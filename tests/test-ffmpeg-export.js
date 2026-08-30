// Regression test: comp -> GIF / social .mp4 (WORKPLAN 6.2 Pass B).
//
// Two pieces ship in that pass and this covers both with NO ffmpeg
// binary and NO After Effects:
//
//   Ffmpeg.*                         (panel) — find, plan, build, VERIFY
//   export_gif / export_social       (panel) — the whole round trip
//
// ffmpeg is reached through global.AEBridge.nodeRequire, so the suite
// hands the module a SCRIPTED child_process: every ffmpeg and ffprobe
// answer below is one that was measured in the field, replayed byte for
// byte. That is the only way to prove the checks that matter, because
// each of them exists to catch a command that EXITED ZERO.
//
// Facts modelled here, all measured against BtbN n9.0.1-11-ge47273f4d9
// (LGPL) and AE 2026 on 2026-08-30:
//
//  1. ffmpeg EXITS 0 WHEN IT REFUSES TO WRITE — handed an existing
//     output with no -y it prints "already exists. Exiting.", writes
//     nothing and returns 0. Without -nostdin the same case is an
//     interactive prompt that HANGS FOREVER. So every argument list this
//     module builds must start with both flags, and the exit code is
//     never the check.
//  2. `ffmpeg -t 0` writes a 262-byte MP4 with ZERO streams that ffprobe
//     then accepts: exit 0, valid JSON, empty stderr, probe_score 100.
//     The captured JSON is below. A checker that trusts ffprobe's exit
//     code calls that file a successful export.
//  3. ffprobe exits 1 on a zero-byte file WHILE STILL PRINTING `{}` —
//     so "the JSON parsed" is not a check either.
//  4. Matroska (.webm, .mkv) reports NEITHER nb_frames NOR duration on
//     the stream. Reading that as "0 frames" rejects a perfectly good
//     VP9 file — the mirror image of the bug the checker exists for.
//  5. AE's "Lossless" module writes RAWVIDEO / bgr24 AVI: width * height
//     * 3 bytes PER FRAME. Measured 231 040 B/f at 320x240 and
//     6 224 440 B/f at 1920x1080 — 1.87 GB for 10 s of 1080p30.
//  6. That AVI CARRIES THE COMP'S AUDIO as pcm_s16le when the comp has
//     an audio layer (a 2 s tone added exactly 384 000 bytes).
//  7. AE renders the WORK AREA when render_comp is given no span. A 3 s
//     comp trimmed to its middle second renders ONE second, reports
//     "start 1s, 10 frame(s)" and status DONE. Nothing downstream can
//     tell that from a comp that is one second long.
//  8. `-encoders` is a COMPILE-time list: this build names h264_amf and
//     h264_qsv and both fail at encode time for want of a device, while
//     libopenh264 encodes real h264 in 37 ms.
//  9. libopenh264 does NOT refuse odd dimensions (101x75 encodes fine),
//     so rounding to even is a compatibility choice and must not be
//     tested as if it were a crash guard.
// 10. h264_nvenc REFUSES a frame under about 145x49 -- "Frame Dimension
//     less than the minimum supported value", exit -22, zero bytes.
//     Measured on this card: 146x50 encodes, 144x48 and 128x128 do not.
//     So an encoder trial at a fixed small size answers about the wrong
//     picture: the first version of tryEncoder used 64x64 and a machine
//     with a working NVIDIA encoder fell through to h264_mf in silence.
//     Found only because the FIELD run disagreed with the hardware that
//     was in the box.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ffmpegSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "ffmpeg.js"), "utf8");
const toolsSrc = fs.readFileSync(
  path.join(ROOT, "extension", "js", "tools.js"), "utf8");

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

const TMP = path.join(os.tmpdir(), "aell-ffmpeg-export-test-" + process.pid);
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
rmrf(TMP);
fs.mkdirSync(TMP, { recursive: true });
process.on("exit", () => rmrf(TMP));

// ==================================== the scripted ffmpeg / ffprobe
//
// One queue of answers, matched on the argv the module builds. Anything
// unmatched is a loud failure rather than a silent empty answer — an
// unrecognised invocation is exactly the drift this file exists to see.

const CALLS = [];
let RULES = [];

function fakeExecFile(exe, args, opts, cb) {
  CALLS.push({ exe, args: args.slice(0) });
  for (const r of RULES) {
    if (r.match(exe, args)) {
      const out = r.run(exe, args);
      // Async, like the real one — a module that assumes a synchronous
      // callback works here and deadlocks in the panel.
      setImmediate(() => cb(out.err || null, out.stdout || "", out.stderr || ""));
      return;
    }
  }
  setImmediate(() => cb(new Error("UNSCRIPTED CALL: " + exe + " " +
                                  args.join(" ")), "", ""));
}

const nodeShim = (m) => {
  if (m === "child_process") return { execFile: fakeExecFile };
  return require(m);
};

let DATA_ROOT = TMP;
const fglobal = {
  Settings: { dataRoot: () => DATA_ROOT },
  AEBridge: { nodeRequire: nodeShim }
};
new Function(ffmpegSrc).call(fglobal);
const F = fglobal.Ffmpeg;

// ================================================== 1. the pure half

// FACT 9: rounding DOWN, so a requested size is never exceeded.
assert(F.evenDown(101) === 100 && F.evenDown(100) === 100,
       "evenDown rounds down to even and leaves even alone");
assert(F.evenDown(1) === 2 && F.evenDown(0) === 2 && F.evenDown(-4) === 2,
       "and never returns something ffmpeg cannot scale to");

// ---- parseSize: two conventions that genuinely disagree
{
  assert(F.parseSize("1080x1920").width === 1080 &&
         F.parseSize("1080x1920").height === 1920,
         "\"1080x1920\" is width by height");
  assert(F.parseSize("1080X1920").height === 1920, "and X is accepted too");
  const p = F.parseSize("720p");
  assert(p.height === 720 && p.width === 0,
         "\"720p\" is a HEIGHT — that is what the p means in video");
  const w = F.parseSize("480");
  assert(w.width === 480 && w.height === 0,
         "a bare \"480\" is a WIDTH — that is what it means for a GIF");
  assert(F.parseSize(480).width === 480, "a number works as well as a string");
  assert(F.parseSize("").width === 0 && !F.parseSize("").err,
         "no size at all is not an error");
  assert(/must be/.test(F.parseSize("big").err),
         "and nonsense is a grounded refusal: " + F.parseSize("big").err);
}

// ---- planSize
const SRC = { w: 1920, h: 1080 };
{
  const p = F.planSize(SRC, {});
  assert(p.width === 1920 && p.height === 1080 && p.filter === "",
         "no size asked for is no scale filter at all — an even-sided " +
         "comp is passed through untouched");
}
{
  // The comp itself can be odd: 1919 wide is legal in AE.
  const p = F.planSize({ w: 1919, h: 1081 }, {});
  assert(p.width === 1918 && p.height === 1080 &&
         p.filter === "scale=1918:1080",
         "an ODD comp is rounded down and SAYS SO — got " + p.filter);
  assert(/even sides/.test(p.note), "with the reason: " + p.note);
}
{
  const p = F.planSize(SRC, { size: "480" });
  assert(p.width === 480 && p.height === 270 && p.filter === "scale=480:270",
         "a width alone keeps the aspect ratio — got " +
         p.width + "x" + p.height);
}
{
  const p = F.planSize(SRC, { size: "720p" });
  assert(p.width === 1280 && p.height === 720,
         "and a height alone does too — got " + p.width + "x" + p.height);
}
{
  // 16:9 into 9:16 is the story/reel case, and it is the one where
  // getting `fit` wrong silently destroys the shot.
  const c = F.planSize(SRC, { size: "1080x1920" });
  assert(c.fit === "contain", "contain is the DEFAULT — losing the edges " +
         "of someone's comp is not something to do without being asked");
  assert(/force_original_aspect_ratio=decrease/.test(c.filter) &&
         /pad=1080:1920/.test(c.filter),
         "contain scales to fit then pads to the exact frame: " + c.filter);
  assert(/force_divisible_by=2/.test(c.filter),
         "and the INNER picture is kept even too — the pad is what makes " +
         "the odd one invisible until an encoder complains");
  assert(/letterboxed/.test(c.note) && /1920x1080/.test(c.note) &&
         /'cover'/.test(c.note),
         "the note names both shapes and the other option: " + c.note);

  const v = F.planSize(SRC, { size: "1080x1920", fit: "cover" });
  assert(/force_original_aspect_ratio=increase/.test(v.filter) &&
         /crop=1080:1920/.test(v.filter),
         "cover scales up and crops: " + v.filter);
  assert(/CROPS/.test(v.note), "and says that it is losing picture: " + v.note);

  const s = F.planSize(SRC, { size: "1080x1920", fit: "stretch" });
  assert(s.filter === "scale=1080:1920",
         "stretch is a plain scale: " + s.filter);
  assert(/changes the shape/.test(s.note),
         "and is the one that has to say it distorts: " + s.note);
}
{
  // Same aspect ratio, both dimensions given: no pad, no crop, no note.
  const p = F.planSize(SRC, { size: "1280x720" });
  assert(p.filter === "scale=1280:720" && p.fit === "exact" && !p.note,
         "a same-shape target is a plain scale with nothing to warn " +
         "about — got " + p.filter + " / " + p.note);
}
{
  assert(/'fit' must be/.test(F.planSize(SRC, { fit: "squish" }).err),
         "an unknown fit is refused with the list");
  assert(/padColor/.test(
    F.planSize(SRC, { size: "1080x1920", padColor: "rgb(1,2,3)" }).err),
         "and so is a pad colour ffmpeg cannot parse");
  assert(/nothing can be scaled/.test(F.planSize({ w: 0, h: 0 }, {}).err),
         "a comp with no pixels is refused rather than divided by");
}

// ---- planMaster: the pixels AE never has to render
//
// The master exists only to be scaled DOWN, so a 4K comp going to a
// 480 px GIF moves 24 MB a frame to keep 0.4. AE's Render Settings can
// render the smaller frame itself, and render_comp grew {resolution}
// for it. Measured in AE 2026: the rendered frame is ceil(dim/factor)
// on each axis, and the FOUR names are all AE offers.

{
  const none = F.planMaster(SRC, { width: 480, height: 270 });
  assert(none.factor === 1 && none.width === SRC.w && none.height === SRC.h,
         "no masterResolution is the shipped behaviour, unchanged: a " +
         "full-size master (" + none.width + "x" + none.height + ")");
  assert(!none.note, "and nothing to say about it");
}
{
  const h = F.planMaster(SRC, { width: 480, height: 270 }, "half");
  assert(h.factor === 2 && h.width === 960 && h.height === 540,
         "half of 1920x1080 is 960x540 — " + h.width + "x" + h.height);
  assert(/half resolution/.test(h.note) && /1920x1080/.test(h.note),
         "and the note names both sizes, because the user asked for a " +
         "1920-wide comp: " + h.note);
}
{
  // ceil, not floor. 641/2 is 321 in After Effects, measured.
  const o = F.planMaster({ w: 641, h: 361 }, { width: 320, height: 180 },
                         "half");
  assert(o.width === 321 && o.height === 181,
         "an odd comp rounds each axis UP: 641x361 at half is 321x181, " +
         "not 320x180 — got " + o.width + "x" + o.height);
}
{
  // THE rule: this may never hand ffmpeg something it has to enlarge.
  const bad = F.planMaster(SRC, { width: 1080, height: 1920 }, "quarter");
  assert(/ENLARGE/.test(bad.err || ""),
         "a reduction that lands under the output is refused, not " +
         "quietly upscaled: " + String(bad.err).slice(0, 90));
  assert(/480x270/.test(bad.err || ""),
         "and the refusal says what AE WOULD have rendered: " +
         String(bad.err).slice(0, 90));
  assert(/full-resolution master/.test(bad.err || ""),
         "and that this size has nothing to spare: " +
         String(bad.err).slice(-70));
}
{
  const bad2 = F.planMaster(SRC, { width: 960, height: 540 }, "quarter");
  assert(/most it can be reduced .* is half/.test(bad2.err || ""),
         "when a smaller reduction WOULD work, the refusal names it " +
         "rather than leaving the user to bisect: " +
         String(bad2.err).slice(-80));
}
{
  const a = F.planMaster(SRC, { width: 480, height: 270 }, "auto");
  assert(a.factor === 4 && a.width === 480 && a.height === 270,
         "'auto' takes the largest reduction that still COVERS the " +
         "output — 1920 to a 480 px GIF is exactly quarter, so ffmpeg " +
         "scales nothing at all (" + a.width + "x" + a.height + ")");
  const b = F.planMaster(SRC, { width: 1080, height: 1920 }, "auto");
  assert(b.factor === 1 && !b.err,
         "and when nothing fits, 'auto' is simply the full master — " +
         "never a refusal, because the user asked for a choice, not a " +
         "size");
  const c = F.planMaster(SRC, { width: 700, height: 394 }, "auto");
  assert(c.factor === 2,
         "700 wide needs more than a third of 1920 (640), so auto stops " +
         "at half — got factor " + c.factor);
}
{
  assert(F.planMaster(SRC, { width: 480, height: 270 }, "1/4").factor === 4,
         "'1/4' is quarter, the way a person would write it");
  assert(F.planMaster(SRC, { width: 480, height: 270 }, "QUARTER").factor === 4,
         "and case is not a trap");
  assert(F.planMaster(SRC, { width: 480, height: 270 }, "full").factor === 1,
         "'full' is the explicit way to say the default");
  const e = F.planMaster(SRC, { width: 480, height: 270 }, "35%");
  assert(/must be full, half, third, quarter or auto/.test(e.err || ""),
         "an arbitrary percentage is refused with the list — AE has no " +
         "such setting: " + String(e.err).slice(0, 80));
}

// ---- fps + the size estimate
assert(F.withFps("scale=2:2", 12) === "fps=12,scale=2:2",
       "the fps filter goes FIRST — dropping frames before scaling them " +
       "is the cheap order");
assert(F.withFps("", 12) === "fps=12" && F.withFps("scale=2:2", 0) === "scale=2:2",
       "and either half alone still produces a valid chain");

// FACT 5, the numbers straight off the field renders.
assert(F.estimateIntermediate(320, 240, 12) === 2764800,
       "320x240x12 frames estimates 2 764 800 B against a measured " +
       "2 772 480 — the estimate is the FLOOR, and within 0.3%");
assert(F.estimateIntermediate(1920, 1080, 2) === 12441600,
       "1920x1080x2 estimates 12 441 600 against a measured 12 448 880");
{
  const tenSec = F.estimateIntermediate(1920, 1080, 300);
  assert(tenSec === 1866240000 && tenSec > 1.7 * 1024 * 1024 * 1024,
         "ten seconds of 1080p30 is 1 866 240 000 bytes of lossless " +
         "master — " + F.humanBytes(tenSec) + " once the GB is the " +
         "binary one the guard counts in. This is why there is a guard");
}
assert(F.humanBytes(2772480) === "3 MB" && /GB$/.test(F.humanBytes(2e9)),
       "humanBytes is for a sentence, not a spreadsheet");

// ---- bitrate: libopenh264 has no CRF, so quality has to become a number
{
  const m = F.bitrateFor(1920, 1080, 30, "medium");
  assert(m.kbps === 6221, "1080p30 medium lands on ~6 Mbps — got " + m.kbps);
  assert(F.bitrateFor(1920, 1080, 30, "high").kbps >
         F.bitrateFor(1920, 1080, 30, "low").kbps,
         "high is more bits than low");
  assert(F.bitrateFor(64, 64, 1, "low").kbps === 200,
         "a tiny frame still gets a floor — 15 kbps of h264 is a smear");
  assert(F.bitrateFor(7680, 4320, 60, "high").kbps === 20000,
         "and 8K60 is capped: nothing social wants 300 Mbps");
  assert(/'quality' must be/.test(F.bitrateFor(1920, 1080, 30, "cinema").err),
         "an unknown quality is refused with the list");
}

// ---- the argument lists. FACT 1 is the whole reason these are asserted.
{
  const g = F.buildGifArgs("in.avi", "out.gif",
                           { filter: "scale=480:270", fps: 12 });
  assert(!g.err, "a plain GIF builds");
  assert(g.args[0] === "-nostdin" && g.args[1] === "-y",
         "-nostdin and -y come FIRST — without -y ffmpeg exits 0 having " +
         "written nothing, and without -nostdin that same case hangs " +
         "forever on a prompt nobody can answer");
  const chain = g.args[g.args.indexOf("-filter_complex") + 1];
  assert(/^fps=12,scale=480:270,split/.test(chain),
         "the size and rate are applied BEFORE the palette is built — a " +
         "palette taken from the full-size frames is the wrong palette: " +
         chain);
  assert(/palettegen=max_colors=256:stats_mode=diff/.test(chain) &&
         /paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle/.test(chain),
         "two-pass palette, diff mode — a GIF encoded without one is " +
         "quantised to the web palette and looks it");
  assert(g.args[g.args.indexOf("-loop") + 1] === "0",
         "-loop 0 is FOREVER (the numbers are not intuitive and getting " +
         "them backwards ships a GIF that plays once)");
  assert(F.buildGifArgs("i", "o", { loop: false })
          .args[F.buildGifArgs("i", "o", { loop: false }).args
                 .indexOf("-loop") + 1] === "-1",
         "and -1 is once");
  assert(g.args.indexOf("-an") !== -1, "a GIF carries no audio");
  assert(g.args[g.args.length - 1] === "out.gif",
         "the output is last, where ffmpeg wants it");

  assert(/max_colors=32/.test(
    F.buildGifArgs("i", "o", { colors: 32 }).args.join(" ")),
    "a colour count is passed through");
  assert(/max_colors=256/.test(
    F.buildGifArgs("i", "o", { colors: 9999 }).args.join(" ")),
    "and clamped to what GIF can hold");
  assert(/'dither' must be/.test(F.buildGifArgs("i", "o", { dither: "x" }).err),
         "an unknown dither is refused with the list");
}
{
  const s = F.buildSocialArgs("in.avi", "out.mp4", {
    filter: "scale=1080:1920", width: 1080, height: 1920, fps: 30,
    encoder: "libopenh264", audio: true
  });
  assert(!s.err && s.args[0] === "-nostdin" && s.args[1] === "-y",
         "the mp4 list starts with the same two flags");
  assert(s.args[s.args.indexOf("-c:v") + 1] === "libopenh264",
         "the encoder is the one that was chosen, not a default buried here");
  assert(s.args[s.args.indexOf("-pix_fmt") + 1] === "yuv420p",
         "yuv420p, or half the players in the world show a black frame");
  assert(s.args[s.args.indexOf("-c:a") + 1] === "aac",
         "audio is AAC — the native encoder, so no GPL dependency");
  assert(s.args.indexOf("+faststart") !== -1,
         "faststart moves the index to the front, which is the whole " +
         "point of 'social'");
  assert(/^\d+k$/.test(s.args[s.args.indexOf("-b:v") + 1]),
         "a real bitrate is passed: libopenh264 has no CRF to fall back on");

  const mute = F.buildSocialArgs("in.avi", "out.mp4",
    { width: 640, height: 360, fps: 30, audio: false });
  assert(mute.args.indexOf("-an") !== -1 && mute.args.indexOf("-c:a") === -1,
         "audio: false is -an, not a silent AAC track");
}

// ---- the destination, checked before anything is rendered
{
  const dir = path.join(TMP, "out");
  fs.mkdirSync(dir, { recursive: true });
  assert(/'output' is required/.test(F.checkOutput("", [".gif"], false).err),
         "no output at all is a grounded refusal");
  assert(/ABSOLUTE/.test(F.checkOutput("out.gif", [".gif"], false).err),
         "a relative path is refused — it would resolve against whatever " +
         "AE's working directory happens to be");
  const wrong = F.checkOutput(path.join(dir, "a.mp4"), [".gif"], false);
  assert(/extension decides the format/.test(wrong.err) && /\.gif/.test(wrong.err),
         "the extension picks the MUXER, so a wrong one cannot run at " +
         "all: " + wrong.err);
  const missing = F.checkOutput("C:\\nope\\deeper\\a.gif", [".gif"], false);
  assert(/does not exist/.test(missing.err) &&
         /Deepest folder that does exist/.test(missing.err),
         "a missing folder names the deepest one that IS there — " +
         "'create the missing folder' is only actionable if you know " +
         "which: " + missing.err);
  const good = path.join(dir, "a.gif");
  assert(!F.checkOutput(good, [".gif"], false).err, "a good path passes");
  fs.writeFileSync(good, Buffer.alloc(2048));
  assert(/already exists/.test(F.checkOutput(good, [".gif"], false).err),
         "an existing file is refused rather than overwritten in silence");
  assert(!F.checkOutput(good, [".gif"], true).err,
         "unless overwrite was asked for");
  assert(/2 KB/.test(F.checkOutput(good, [".gif"], false).err),
         "and the refusal says how big the thing it declined to destroy " +
         "is: " + F.checkOutput(good, [".gif"], false).err);
  assert(!F.checkOutput(path.join(dir, "a.MOV"), [".mp4", ".mov"], false).err,
         "the extension check is case-insensitive");
}

// ============================================ 2. finding the install
//
// FACT: the archive nests as bin\ffmpeg-<build>-win64-lgpl\bin\, which
// is where this machine's really is. A non-recursive lookup finds
// nothing and reads as "the download failed".

{
  const r = F.find({ vendorOnly: true });
  assert(!r.ok && /get-ffmpeg\.ps1/.test(r.reason),
         "no install is a grounded refusal naming the acquirer: " + r.reason);
}
const NEST = path.join(TMP, "vendor", "ffmpeg", "bin",
                       "ffmpeg-n9.0-latest-win64-lgpl-9.0", "bin");
fs.mkdirSync(NEST, { recursive: true });
fs.writeFileSync(path.join(NEST, "ffmpeg.exe"), "x");
{
  const r = F.find({ vendorOnly: true });
  assert(!r.ok && /has ffmpeg\.exe but no ffprobe\.exe/.test(r.reason),
         "half an install says WHICH half — the checker is useless " +
         "without ffprobe: " + r.reason);
}
fs.writeFileSync(path.join(NEST, "ffprobe.exe"), "x");
fs.writeFileSync(path.join(NEST, "ffplay.exe"), "x");
let INSTALL = null;
{
  const r = F.find({ vendorOnly: true });
  assert(r.ok && r.source === "vendor", "a complete install is found");
  assert(/win64-lgpl-9\.0[\\/]bin[\\/]ffmpeg\.exe$/.test(r.ffmpeg),
         "NESTED two levels under bin\\ — found by walking, not by " +
         "joining a fixed path: " + r.ffmpeg);
  assert(/ffprobe\.exe$/.test(r.ffprobe), "and ffprobe with it");
  INSTALL = r;
}
{
  // The PATH fallback is not a nicety: the dev machine had a gyan.dev
  // build in Program Files before any of this was written.
  const saveRoot = DATA_ROOT;
  DATA_ROOT = path.join(TMP, "empty");
  const pathDir = path.join(TMP, "onpath");
  fs.mkdirSync(pathDir, { recursive: true });
  fs.writeFileSync(path.join(pathDir, "ffmpeg.exe"), "x");
  fs.writeFileSync(path.join(pathDir, "ffprobe.exe"), "x");
  const savePath = process.env.PATH;
  process.env.PATH = pathDir + ";" + savePath;
  const r = F.find();
  assert(r.ok && r.source === "path",
         "with no vendor copy, one already on PATH is used");
  assert(!F.find({ vendorOnly: true }).ok,
         "and vendorOnly refuses it, which is how the acquirer's tests " +
         "prove the not-installed message on a machine that has ffmpeg");
  process.env.PATH = savePath;
  DATA_ROOT = saveRoot;
}

// ==================================== 3. inspect(): the only real check
//
// Captured ffprobe output, replayed. Each of these EXITED ZERO.

// FACT 2: `ffmpeg -t 0`. 262 bytes, probe_score 100, nb_streams 0,
// nothing at all on stderr.
const EMPTY_MP4_JSON = JSON.stringify({
  streams: [],
  format: { filename: "empty.mp4", nb_streams: 0, format_name: "mov,mp4,m4a",
            duration: "0.000000", size: "262", probe_score: 100 }
});
// A real 24-frame 320x240 export with sound.
const GOOD_MP4_JSON = JSON.stringify({
  streams: [
    { index: 0, codec_name: "h264", codec_type: "video", width: 320,
      height: 240, nb_frames: "24", duration: "2.000000" },
    { index: 1, codec_name: "aac", codec_type: "audio", channels: 2 }
  ],
  format: { nb_streams: 2, duration: "2.000000" }
});
// FACT 4: matroska carries neither on the stream.
const MKV_JSON = JSON.stringify({
  streams: [{ index: 0, codec_name: "vp9", codec_type: "video",
              width: 96, height: 64 }],
  format: { nb_streams: 1, format_name: "matroska,webm", duration: "1.500000" }
});
const COUNT_JSON = JSON.stringify({
  streams: [{ nb_read_frames: "12" }]
});
// FACT 3: exit 1, and `{ }` all the same.
const EMPTY_OBJ = "{ }";

function probeRule(name, stdout, err) {
  return {
    match: (exe, args) => /ffprobe\.exe$/.test(exe) &&
      args.some(a => String(a).indexOf(name) !== -1) &&
      args.indexOf("-count_frames") === -1,
    run: () => ({ stdout, err: err || null })
  };
}
function countRule(name, stdout) {
  return {
    match: (exe, args) => /ffprobe\.exe$/.test(exe) &&
      args.indexOf("-count_frames") !== -1 &&
      args.some(a => String(a).indexOf(name) !== -1),
    run: () => ({ stdout })
  };
}

function makeFile(name, bytes) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

let done = 0;
function step(fn) { fn(); }

// --- run the async assertions in sequence, then the tools.js half.
const good = makeFile("good.mp4", 35104);
const empty = makeFile("empty.mp4", 262);
const zero = makeFile("zero.mp4", 0);
const mkv = makeFile("clip.mkv", 40000);
const gone = path.join(TMP, "never-written.gif");

RULES = [
  probeRule("good.mp4", GOOD_MP4_JSON),
  probeRule("empty.mp4", EMPTY_MP4_JSON),
  probeRule("zero.mp4", EMPTY_OBJ, new Error("exit 1")),
  probeRule("clip.mkv", MKV_JSON),
  countRule("clip.mkv", COUNT_JSON)
];

function inspectTests(next) {
  F.inspect(INSTALL, good, (e, r) => {
    assert(r.ok && r.width === 320 && r.height === 240 && r.frames === 24,
           "a real export inspects as 320x240 / 24 frames");
    assert(r.hasAudio === true && r.codec === "h264",
           "and its audio stream and codec are reported");
    assert(r.bytes === 35104, "with the byte count off the real file");

    F.inspect(INSTALL, empty, (e2, r2) => {
      // THE test in this file.
      assert(!r2.ok, "FACT 2: the 262-byte MP4 that ffprobe scores 100 and " +
             "calls valid is REJECTED — it has no picture in it");
      assert(/NO VIDEO STREAM/.test(r2.reason) &&
             /262 bytes/.test(r2.reason),
             "and the reason says what it actually is: " + r2.reason);

      F.inspect(INSTALL, zero, (e3, r3) => {
        assert(!r3.ok && /zero bytes/.test(r3.reason),
               "FACT 3: a zero-byte file is caught before ffprobe is even " +
               "asked — it answers `{ }` and would parse: " + r3.reason);

        F.inspect(INSTALL, gone, (e4, r4) => {
          assert(!r4.ok && /wrote no file/.test(r4.reason) &&
                 /exit code is never the check/.test(r4.reason),
                 "FACT 1: no file at all is the shape of ffmpeg's " +
                 "exit-0 refusal, and the message says so: " + r4.reason);

          const before = CALLS.length;
          F.inspect(INSTALL, mkv, (e5, r5) => {
            assert(r5.ok && r5.frames === 12,
                   "FACT 4: matroska carries no nb_frames, so the count is " +
                   "asked for again with -count_frames rather than read as " +
                   "zero — got " + r5.frames);
            assert(r5.duration === 1.5,
                   "and the duration falls back to the FORMAT's: " + r5.duration);
            assert(CALLS.length - before === 2,
                   "which costs exactly one extra ffprobe, and only when " +
                   "the fast field was absent");
            assert(r5.hasAudio === false, "a video-only file says so");
            next();
          });
        });
      });
    });
  });
}

// ============================== 4. pickEncoder: FACT 8, the compile list
//
// h264_qsv is NAMED by this build and fails at encode time for want of
// an Intel device. The census cannot see that; only an encode can.

function encoderTests(next) {
  // The trial's testsrc size, read back out of the argv. FACT 10 below
  // is entirely about this number being the RIGHT one.
  function trialSize(args) {
    const m = /testsrc=size=(\d+)x(\d+)/.exec(args.join(" "));
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  }
  RULES = [
    // The hardware encoder that is NAMED and has no device.
    { match: (exe, args) => /ffmpeg\.exe$/.test(exe) &&
        args.indexOf("h264_qsv") !== -1,
      run: () => ({ err: new Error("exit -1313558101"),
                    stderr: "\nError initializing an internal MFX session\n" }) },
    // FACT 10: h264_nvenc works — but REFUSES a frame below about
    // 145x49, with exit -22 and a zero-byte file. Measured on this
    // machine: 146x50 encodes, 144x48 and 128x128 do not.
    { match: (exe, args) => /ffmpeg\.exe$/.test(exe) &&
        args.indexOf("h264_nvenc") !== -1,
      run: (exe, args) => {
        const s = trialSize(args);
        if (!s || s.w < 145 || s.h < 49) {
          fs.writeFileSync(args[args.length - 1], Buffer.alloc(0));
          return { err: new Error("exit -22"),
                   stderr: "[h264_nvenc @ 0] InitializeEncoder failed: " +
                           "invalid param (8): Frame Dimension less than " +
                           "the minimum supported value.\n" };
        }
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(11917));
        return { stdout: "" };
      } },
    // The software one always works.
    { match: (exe, args) => /ffmpeg\.exe$/.test(exe) &&
        args.indexOf("libopenh264") !== -1,
      run: (exe, args) => {
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(1200));
        return { stdout: "" };
      } },
    { match: (exe, args) => /ffprobe\.exe$/.test(exe),
      run: (exe, args) => {
        const file = args[args.length - 1];
        if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
          return { stdout: EMPTY_OBJ };
        }
        return { stdout: JSON.stringify({
          streams: [{ codec_name: "h264", codec_type: "video", width: 640,
                      height: 360, nb_frames: "1", duration: "1.0" }],
          format: { duration: "1.0" } }) };
      } }
  ];

  const BIG = { w: 1080, h: 1920 };
  F.pickEncoder(INSTALL, ["h264_qsv", "libopenh264"], BIG, (r) => {
    assert(r.ok && r.name === "libopenh264",
           "FACT 8: h264_qsv is skipped because it was TRIED and failed, " +
           "not because of anything in the -encoders list — got " + r.name);
    assert(r.tried.length === 2 && /h264_qsv \(failed/.test(r.tried[0]) &&
           /MFX session/.test(r.tried[0]),
           "and the encoder's OWN words are carried, not swallowed: " +
           r.tried[0]);
    assert(!fs.readdirSync(TMP).some(f => /^aell-enc-/.test(f)),
           "the trial file is cleaned up");

    const callsBefore = CALLS.length;
    F.pickEncoder(INSTALL, ["h264_qsv", "libopenh264"], BIG, (r2) => {
      assert(r2.ok && CALLS.length === callsBefore,
             "the verdict is cached — a trial per export would be a cost " +
             "the user feels on every render");

      // FACT 10, the one this file exists to keep fixed. The first
      // version of tryEncoder used a fixed 64x64 frame and a working
      // NVIDIA card silently lost to h264_mf. Caught only because the
      // FIELD run disagreed with the hardware in the machine.
      F.pickEncoder(INSTALL, ["h264_nvenc", "libopenh264"], BIG, (r3) => {
        assert(r3.ok && r3.name === "h264_nvenc",
               "FACT 10: the trial frame is the size the export will be, " +
               "so a 1080x1920 export finds the GPU encoder — a fixed " +
               "small frame would answer about the wrong picture and " +
               "fall through to software. Got " + r3.name);

        // And the same card genuinely cannot do a tiny one, which is
        // what makes the size part of the cache key rather than noise.
        F.pickEncoder(INSTALL, ["h264_nvenc", "libopenh264"],
                      { w: 128, h: 128 }, (r4) => {
          assert(r4.ok && r4.name === "libopenh264",
                 "a 128x128 export really does fall through to software, " +
                 "so the verdict is cached per SIZE, not per name: " +
                 r4.name);
          assert(/Frame Dimension less than the minimum/.test(r4.tried[0]),
                 "with the encoder's explanation, which is the actionable " +
                 "half: " + r4.tried[0]);

          F.pickEncoder(INSTALL, ["h264_amf"], BIG, (r5) => {
            assert(!r5.ok && /COMPILED with/.test(r5.reason) &&
                   /h264_amf/.test(r5.reason) && /1080x1920/.test(r5.reason),
                   "and when nothing works the refusal names the size it " +
                   "tried and explains the compile list rather than " +
                   "blaming the machine: " + r5.reason);
            next();
          });
        });
      });
    });
  });
}

// ================================== 5. the round trip through tools.js
//
// A scripted AE: get_comp_details and render_comp answer the way the
// field measured them, INCLUDING the work-area truncation.

const window = { Ffmpeg: F, AEBridge: { nodeRequire: nodeShim } };
let HOST = {};
window.AEBridge.evalScript = function (script, cb) {
  const m = /^AELL_call\("([a-z_]+)", (.*)\)$/.exec(script);
  if (!m) { cb("{}", false); return; }
  const args = JSON.parse(JSON.parse(m[2]));
  const fn = HOST[m[1]];
  if (!fn) { cb(JSON.stringify({ ok: false, error: "no stub for " + m[1] }), false); return; }
  setImmediate(() => cb(JSON.stringify(fn(args)), false));
};
new Function("window", toolsSrc)(window);
const Tools = window.Tools;
const PANEL = Tools._panelTools;

assert(typeof PANEL.export_gif === "function" &&
       typeof PANEL.export_social === "function",
       "export_gif and export_social are PANEL tools — ExtendScript " +
       "cannot spawn a child process, so they cannot live in hostscript");
for (const t of ["export_gif", "export_social"]) {
  assert(new RegExp('name: "' + t + '", mutating: true').test(toolsSrc),
         t + " is documented in TOOL_DEFS and marked mutating (an " +
         "undocumented tool is unreachable by the model)");
}
assert(/name: "export_social"[\s\S]{0,900}wholeComp/.test(toolsSrc) &&
       /name: "export_gif"[\s\S]{0,900}WORK AREA/.test(toolsSrc),
       "and the docs tell the model about the work area, which is the " +
       "one thing about this feature it cannot find out by trying");

/** A comp, and a render_comp that behaves the way AE measurably does. */
function scriptAE(comp, renderSpan) {
  HOST = {
    get_comp_details: () => ({ ok: true, data: comp }),
    render_comp: (a) => {
      // FACT 7: with no span, AE renders the WORK AREA and says DONE.
      const dur = (typeof a.durationSeconds !== "undefined" &&
                   a.durationSeconds !== null && a.durationSeconds !== "")
        ? Number(a.durationSeconds) : renderSpan;
      const frames = Math.round(dur * comp.frameRate);
      const out = String(a.output).replace(/\//g, "\\");
      fs.writeFileSync(out, Buffer.alloc(1024));
      LAST_MASTER = { file: out, width: comp.width, height: comp.height,
                      frames, duration: dur };
      return { ok: true, data: { comp: comp.name, output: out,
        status: "DONE", bytes: 1024,
        timeSpan: "start 0s, " + frames + " frame(s) at " +
                  comp.frameRate + " fps" } };
    }
  };
}
let LAST_MASTER = null;

/* ffmpeg that really writes a file, and an ffprobe that answers about
 * whichever file it is handed — the master AE "rendered" or the export
 * ffmpeg "encoded". Both are driven off the argv, so a tool that builds
 * the wrong chain gets the wrong answer rather than a pass. */
function scriptFfmpeg(opts) {
  opts = opts || {};
  RULES = [
    { match: (exe) => /ffmpeg\.exe$/.test(exe),
      run: (exe, args) => {
        if (args.indexOf("lavfi") !== -1) {           // an encoder trial
          fs.writeFileSync(args[args.length - 1], Buffer.alloc(1200));
          return { stdout: "" };
        }
        LAST_ENCODE = args.slice(0);
        if (opts.encodeFails) {
          return { err: new Error("exit -22"),
                   stderr: "[AVFilterGraph] No such filter\nError " +
                           "reinitializing filters!\n" };
        }
        // FACT 1: ffmpeg is perfectly capable of exiting 0 having
        // written nothing. That is what this branch models.
        if (!opts.writesNothing) {
          fs.writeFileSync(args[args.length - 1], Buffer.alloc(9000));
        }
        return { stdout: "" };
      } },
    { match: (exe) => /ffprobe\.exe$/.test(exe),
      run: (exe, args) => {
        const file = String(args[args.length - 1]);
        if (!fs.existsSync(file)) return { stdout: EMPTY_OBJ };
        if (LAST_MASTER && file.toLowerCase() === LAST_MASTER.file.toLowerCase()) {
          return { stdout: JSON.stringify({ streams: [
            { codec_name: "rawvideo", codec_type: "video",
              width: LAST_MASTER.width, height: LAST_MASTER.height,
              nb_frames: String(LAST_MASTER.frames),
              duration: String(LAST_MASTER.duration) }
          ].concat(opts.masterAudio ? [{ codec_name: "pcm_s16le",
                                         codec_type: "audio" }] : []),
            format: { duration: String(LAST_MASTER.duration) } }) };
        }
        const dims = encodedDims();
        return { stdout: JSON.stringify({ streams: [
          { codec_name: opts.outCodec || "gif", codec_type: "video",
            width: dims.w, height: dims.h, nb_frames: "12",
            duration: "1.0" }
        ].concat(opts.outAudio ? [{ codec_name: "aac", codec_type: "audio" }] : []),
          format: { duration: "1.0" } }) };
      } }
  ];
}
let LAST_ENCODE = null;
/* Read the size back out of the filter chain the tool built, so the
 * probe cannot agree with a chain that says something else. */
function encodedDims() {
  const j = (LAST_ENCODE || []).join(" ");
  const m = /(?:pad|crop)=(\d+):(\d+)|scale=(\d+):(\d+)/.exec(j);
  if (!m) return { w: LAST_MASTER.width, h: LAST_MASTER.height };
  return { w: Number(m[1] || m[3]), h: Number(m[2] || m[4]) };
}

const COMP = { name: "Promo", width: 1920, height: 1080, duration: 3,
               frameRate: 30 };

function exportTests(next) {
  const dir = path.join(TMP, "exports");
  fs.mkdirSync(dir, { recursive: true });

  // ---- the GIF, with the work area trimmed to one of three seconds
  scriptAE(COMP, 1);
  scriptFfmpeg({});
  PANEL.export_gif({ comp: "Promo", output: path.join(dir, "a.gif") }, (r) => {
    assert(r.ok, "a GIF export succeeds: " + (r.error || ""));
    assert(r.data.dimensions === "480x270",
           "with no size asked for it is 480 wide — a GIF at comp size is " +
           "a GIF nobody can post. Got " + r.data.dimensions);
    assert(/480 px wide, the GIF default/.test((r.data.notes || []).join(" ")),
           "and it SAYS it chose that, rather than quietly resizing " +
           "someone's comp");
    assert(r.data.fps === 12, "12 fps, likewise a default that is stated");
    // FACT 7 — the whole reason this note exists.
    assert(/WORK AREA/.test((r.data.notes || []).join(" ")) &&
           /3s comp/.test((r.data.notes || []).join(" ")),
           "and the ONE second of a THREE second comp that AE actually " +
           "rendered is called out: " + JSON.stringify(r.data.notes));
    assert(!fs.existsSync(LAST_MASTER.file),
           "the lossless master is deleted — it is the biggest file on " +
           "the disk and nobody asked for it");

    // ---- wholeComp beats the work area
    PANEL.export_gif({ comp: "Promo", output: path.join(dir, "b.gif"),
                       wholeComp: true, size: "320" }, (r2) => {
      assert(r2.ok && r2.data.dimensions === "320x180",
             "an explicit size is honoured: " + r2.data.dimensions);
      assert(!/WORK AREA/.test((r2.data.notes || []).join(" ")),
             "and with wholeComp there is no work-area note to make");

      // ---- FACT 1, end to end: ffmpeg exits 0 and writes nothing
      scriptFfmpeg({ writesNothing: true });
      PANEL.export_gif({ comp: "Promo", output: path.join(dir, "c.gif") },
        (r3) => {
          assert(!r3.ok && /wrote no file/.test(r3.error),
                 "an ffmpeg that exits 0 having written nothing is a " +
                 "FAILURE, not a success with a missing file: " + r3.error);
          assert(!fs.existsSync(LAST_MASTER.file),
                 "and the master is still cleaned up on the failure path");

          // ---- a real ffmpeg error carries its stderr
          scriptFfmpeg({ encodeFails: true });
          PANEL.export_gif({ comp: "Promo", output: path.join(dir, "d.gif") },
            (r4) => {
              assert(!r4.ok && /ffmpeg failed/.test(r4.error) &&
                     /reinitializing filters/.test(r4.error),
                     "a real encode failure reports what ffmpeg SAID — " +
                     "err.message alone says nothing actionable: " + r4.error);
              socialTests(dir, next);
            });
        });
    });
  });
}

function socialTests(dir, next) {
  scriptAE(COMP, 3);
  scriptFfmpeg({ masterAudio: true, outAudio: true, outCodec: "h264" });
  PANEL.export_social({ comp: "Promo", output: path.join(dir, "a.mp4"),
                        size: "1080x1920" }, (r) => {
    assert(r.ok, "a social export succeeds: " + (r.error || ""));
    assert(r.data.dimensions === "1080x1920",
           "into the story frame: " + r.data.dimensions);
    assert(r.data.encoder === "libopenh264",
           "on the software encoder by default — the LGPL build has no " +
           "libx264 and no commercial product should need one");
    assert(/letterboxed/.test((r.data.notes || []).join(" ")),
           "and the 16:9 comp is letterboxed, with the note saying so");
    assert(LAST_ENCODE.indexOf("-c:a") !== -1,
           "FACT 6: the master carried the comp's audio, so the export " +
           "does too — no second render, no muxing step");

    // ---- audio that is not there is reported, not silently dropped
    scriptAE(COMP, 3);
    scriptFfmpeg({ masterAudio: false, outAudio: false, outCodec: "h264" });
    PANEL.export_social({ comp: "Promo", output: path.join(dir, "b.mp4") },
      (r2) => {
        assert(r2.ok && LAST_ENCODE.indexOf("-an") !== -1,
               "a silent comp is encoded with -an rather than an empty " +
               "AAC track");
        assert(/No audio: nothing in this part of the comp/
                 .test((r2.data.notes || []).join(" ")),
               "and the user is told, because 'my video has no sound' is " +
               "otherwise a support question: " +
               JSON.stringify(r2.data.notes));

        // ---- the guards that fire BEFORE anything is rendered
        guardTests(dir, next);
      });
  });
}

function guardTests(dir, next) {
  // FACT 5: a long 1080p comp is a multi-gigabyte master.
  const long = { name: "Long", width: 1920, height: 1080, duration: 600,
                 frameRate: 30 };
  scriptAE(long, 600);
  scriptFfmpeg({});
  const callsBefore = CALLS.length;
  PANEL.export_social({ comp: "Long", output: path.join(dir, "long.mp4") },
    (r) => {
      assert(!r.ok && /lossless master/.test(r.error),
             "ten minutes of 1080p is refused BEFORE the render: " + r.error);
      assert(/GB/.test(r.error) && /a frame/.test(r.error) &&
             /18000 frames/.test(r.error),
             "with the arithmetic shown, so the refusal is actionable: " +
             r.error);
      assert(/durationSeconds/.test(r.error) &&
             /maxIntermediateGB/.test(r.error),
             "and both levers named");
      assert(CALLS.length === callsBefore,
             "nothing was spawned and nothing was rendered — the point of " +
             "the guard is that the disk is never touched");

      // Raising the cap lets it through, which is what makes it a guard
      // and not a limit.
      PANEL.export_social({ comp: "Long", output: path.join(dir, "long2.mp4"),
                            durationSeconds: 2 }, (r2) => {
        assert(r2.ok, "a short span of the same comp exports fine: " +
               (r2.error || ""));

        // ---- an fps above the comp's is nonsense, and cheap to refuse
        scriptAE(COMP, 3);
        PANEL.export_social({ comp: "Promo", output: path.join(dir, "f.mp4"),
                              fps: 60 }, (r3) => {
          assert(!r3.ok && /cannot add motion that was never rendered/
                   .test(r3.error) && /30/.test(r3.error),
                 "60 fps out of a 30 fps comp is refused with the comp's " +
                 "own number: " + r3.error);

          // ---- the destination is checked before the comp is even read
          const before = CALLS.length;
          PANEL.export_gif({ comp: "Promo",
                             output: path.join(dir, "wrong.mp4") }, (r4) => {
            assert(!r4.ok && /\.gif/.test(r4.error),
                   "export_gif refuses a .mp4 path: the extension picks " +
                   "the muxer, so it is not cosmetic here: " + r4.error);
            assert(CALLS.length === before, "and refuses it for free");

            PANEL.export_social({ comp: "Promo",
                                  output: path.join(dir, "x.webm") }, (r5) => {
              assert(!r5.ok && /\.mp4, \.mov/.test(r5.error),
                     "and export_social lists what it CAN write: " + r5.error);
              next();
            });
          });
        });
      });
    });
}

// ---- no ffmpeg at all is a refusal the user can act on
function noInstallTest(next) {
  const saveRoot = DATA_ROOT;
  const savePath = process.env.PATH;
  DATA_ROOT = path.join(TMP, "empty");
  process.env.PATH = path.join(TMP, "nothing-here");
  PANEL.export_gif({ comp: "Promo", output: path.join(TMP, "exports", "z.gif") },
    (r) => {
      assert(!r.ok && /get-ffmpeg\.ps1/.test(r.error),
             "with no ffmpeg anywhere the tool names the acquirer rather " +
             "than failing obscurely: " + r.error);
      DATA_ROOT = saveRoot;
      process.env.PATH = savePath;
      next();
    });
}

step(() => inspectTests(() =>
  encoderTests(() =>
    exportTests(() =>
      noInstallTest(() => {
        console.log("\n" + checks + " checks");
        console.log(process.exitCode ? "SOME TESTS FAILED"
                                     : "ALL TESTS PASSED");
      })))));
