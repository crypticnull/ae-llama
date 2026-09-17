/*
 * test-comfy-progress.js — a fifteen-minute render has to say how far in
 * it is (WORKPLAN §18 P3b).
 *
 * Before this, `Comfy.generate` reported one thing while a job ran:
 * elapsed seconds, every ten seconds. At H3's authored 15 s clip that is
 * ninety lines reading "still generating… 600s" with no denominator, and
 * the user cannot tell a job a tenth of the way through from one that has
 * wedged. The reaction to that is a force-quit mid-generation, which is
 * the exact way the backend gets left holding the card (§17k).
 *
 * ComfyUI publishes step k of N on ONE channel and it is not a REST one:
 * measured on the managed vendor build 2026-09-09, /history is empty until
 * the job finishes, /queue says only "running", and /api/jobs — the newest
 * route and the one that sounds like it should — serialises status and
 * outputs with no value/max anywhere. So the panel speaks RFC 6455 to /ws
 * itself (Node 17 has no WebSocket global and the panel ships no
 * dependencies).
 *
 * The bug classes pinned here, in the order they would bite:
 *   1. the frame decoder — a ping, a binary preview or a fragmented
 *      message in the stream must not desynchronise it or drop the text
 *      events that follow;
 *   2. the tracker — which node's fraction, whose prompt, and above all
 *      that the ETA is anchored on the first STEP and not on elapsed time
 *      (elapsed includes model loading, most of a minute on the video
 *      templates, so elapsed/value quotes an ETA far past the truth on
 *      exactly the renders that need one);
 *   3. the wiring — the socket has to be open before the queue POST and
 *      CLOSED when the job settles, or every generation leaks one;
 *   4. survival — a backend that refuses the upgrade must still render.
 *      Progress is never allowed to fail a render.
 *   5. the sentence itself — no event means no fraction, one step seen
 *      means no estimate. A guessed number is the one the user decides to
 *      wait on.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}

const REPO = path.join(__dirname, "..");
const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
  Settings: { dataRoot: () => REPO },
  setTimeout, clearTimeout, setInterval, clearInterval
};
eval(fs.readFileSync(path.join(REPO, "extension", "js", "comfy.js"), "utf8"));
const Comfy = window.Comfy;

// tools.js wants more of the panel than comfy.js does; only the one pure
// formatter is under test here, so the globals it needs are stubbed flat.
const toolsWindow = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
  Settings: { get: () => ({}), dataRoot: () => REPO },
  Comfy: Comfy,
  setTimeout, clearTimeout, setInterval, clearInterval,
  navigator: { platform: "Win32" },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
};
(function (window) {
  eval(fs.readFileSync(path.join(REPO, "extension", "js", "tools.js"), "utf8"));
})(toolsWindow);
const Tools = toolsWindow.Tools;

// ------------------------------------------------------------ ws server
//
// A server-side RFC 6455 writer, deliberately hand-rolled rather than
// shared with the client under test: a bug in the framing would otherwise
// cancel itself out and the test would pass on two wrongs.

function serverFrame(opcode, payload, fin) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2); header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10); header[1] = 127;
    header.writeUInt32BE(0, 2); header.writeUInt32BE(body.length, 6);
  }
  header[0] = (fin === false ? 0x00 : 0x80) | opcode;
  return Buffer.concat([header, body]);
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * A fake ComfyUI. `onSocket(socket, query)` is handed the upgraded socket
 * so each test decides what to push down it. Every request is recorded.
 */
function fakeComfy(opts, cb) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: url, body: body });
      res.setHeader("content-type", "application/json");
      if (/^\/object_info\//.test(url)) {
        const cls = decodeURIComponent(url.replace("/object_info/", ""));
        const out = {}; out[cls] = { input: {}, output: [] };
        res.statusCode = 200; res.end(JSON.stringify(out)); return;
      }
      if (url === "/prompt" && req.method === "POST") {
        res.statusCode = 200;
        res.end(JSON.stringify({ prompt_id: "p-1", number: 1 }));
        return;
      }
      if (/^\/history\//.test(url)) {
        res.statusCode = 200;
        res.end(JSON.stringify(opts.history ? opts.history() : {}));
        return;
      }
      if (url.indexOf("/view") === 0) {
        res.statusCode = 200;
        res.setHeader("content-type", "image/png");
        res.end(Buffer.from("not really a png", "utf8"));
        return;
      }
      if (url === "/queue") {
        res.statusCode = 200;
        res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
        return;
      }
      res.statusCode = 404; res.end("{}");
    });
  });

  const sockets = [];
  server.on("upgrade", (req, socket) => {
    seen.push({ method: "UPGRADE", url: req.url || "", body: "" });
    if (opts.refuseUpgrade) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const key = req.headers["sec-websocket-key"] || "";
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n");
    sockets.push(socket);
    socket.on("error", () => {});
    // An upgraded socket with nothing reading it stays PAUSED and never
    // notices the peer going away, so a "was it closed?" check on it would
    // pass whatever the panel did. Resume before the test attaches.
    socket.resume();
    if (opts.onSocket) opts.onSocket(socket, req.url || "");
  });

  server.listen(0, "127.0.0.1", () => {
    cb({
      url: "http://127.0.0.1:" + server.address().port,
      seen: seen,
      sockets: sockets,
      close: () => { sockets.forEach((s) => { try { s.destroy(); } catch (e) {} });
                     server.close(); }
    });
  });
}

// ============================================================ 1. decoder

function decoderCheck(done) {
  const got = [];
  const bin = Buffer.alloc(300); bin.fill(7);   // a preview image, oversized
  fakeComfy({
    onSocket: (socket) => {
      // A ping, a >125-byte BINARY frame (the 16-bit length path), a text
      // event split across two frames, then a plain one. Everything that
      // can put the reader out of step, in one stream.
      socket.write(serverFrame(0x9, Buffer.from("hb")));
      socket.write(serverFrame(0x2, bin));
      socket.write(serverFrame(0x1, '{"type":"exec', false));
      socket.write(serverFrame(0x0, 'uting","data":{"node":"3"}}'));
      socket.write(serverFrame(0x1, '{"type":"status","data":{}}'));
    }
  }, (srv) => {
    const handle = Comfy._openEventSocket(
      { isHttps: false, host: "127.0.0.1",
        port: parseInt(srv.url.split(":")[2], 10), label: "test" },
      "client-abc",
      (msg) => { got.push(msg); });

    setTimeout(() => {
      const upgrades = srv.seen.filter((r) => r.method === "UPGRADE");
      assert(upgrades.length === 1 && /clientId=client-abc/.test(upgrades[0].url),
             "the socket subscribes as the SAME clientId the prompt is posted " +
             "under [" + (upgrades[0] || {}).url + "]");
      assert(got.length === 2, "two text events survived a ping and a 300-byte " +
             "binary preview in between (" + got.length + ")");
      assert(got[0] && got[0].type === "executing" && got[0].data.node === "3",
             "…a FRAGMENTED text event is reassembled, not dropped [" +
             JSON.stringify(got[0]) + "]");
      assert(got[1] && got[1].type === "status",
             "…and the reader is still in step for the event after it [" +
             JSON.stringify(got[1]) + "]");
      handle.close();
      srv.close();
      done();
    }, 400);
  });
}

// ------------------------------------------------------------- 2. pong

function pongCheck(done) {
  const frames = [];
  fakeComfy({
    onSocket: (socket) => {
      socket.on("data", (c) => { frames.push(c); });
      socket.write(serverFrame(0x9, Buffer.from("hb")));
    }
  }, (srv) => {
    const handle = Comfy._openEventSocket(
      { isHttps: false, host: "127.0.0.1",
        port: parseInt(srv.url.split(":")[2], 10), label: "test" },
      "c", () => {});
    setTimeout(() => {
      const all = Buffer.concat(frames);
      // opcode 0xA, and the mask bit set — an unmasked client frame is a
      // protocol violation aiohttp closes the connection over.
      assert(all.length >= 2 && (all[0] & 0x0f) === 0x0a,
             "a server ping is answered with a PONG (opcode " +
             (all.length ? (all[0] & 0x0f) : "none") + ")");
      assert(all.length >= 2 && (all[1] & 0x80) !== 0,
             "…and the client frame is MASKED, which RFC 6455 5.3 requires " +
             "and aiohttp disconnects over");
      handle.close(); srv.close(); done();
    }, 400);
  });
}

// ============================================================ 3. tracker

function trackerChecks() {
  function state(nodes, promptId) {
    return { type: "progress_state",
             data: { prompt_id: promptId || "p-1", nodes: nodes } };
  }
  function running(value, max) {
    return { state: "running", value: value, max: max };
  }

  let t = Comfy._makeProgressTracker("p-1");
  assert(t.read() === null, "nothing has reported yet -> no fraction at all");

  t.accept(state({ "9": { state: "finished", value: 1, max: 1 } }));
  assert(t.read() === null,
         "a one-shot node that is not a sampler contributes no fraction");

  // A VAE tile bar and the sampler run at once; the sampler is the one
  // with steps to go, and flipping between them would make the fraction
  // jump backwards every message.
  t.accept(state({ "3": running(2, 40), "7": running(1, 4) }));
  let r = t.read();
  assert(r && r.max === 40 && r.node === "3",
         "with two bars running, the one with the MOST steps is the fraction [" +
         JSON.stringify(r) + "]");

  t.accept(state({ "3": running(11, 40) }, "someone-else"));
  r = t.read();
  assert(r.value === 2, "another prompt's progress is ignored (" + r.value + ")");

  t.accept(state({ "3": running(6, 40) }));
  assert(t.read().value === 6, "our own prompt advances the fraction");

  // The ETA rule: anchored on the first STEP seen, never on elapsed.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    t = Comfy._makeProgressTracker("p-1");
    clock += 60000;                       // a minute of model loading
    t.accept(state({ "3": running(1, 41) }));
    assert(t.read().etaSec === 0,
           "one step seen is no rate — no estimate is offered yet (" +
           t.read().etaSec + ")");
    clock += 20000;                       // 20 s for 10 steps = 2 s/step
    t.accept(state({ "3": running(11, 41) }));
    r = t.read();
    assert(r.etaSec === 60,
           "the estimate is 30 steps x 2 s = 60 s — measured from the FIRST " +
           "STEP, not from the elapsed 80 s that includes the load (" +
           r.etaSec + ")");

    // A node that restarts its bar (a second pass on the same id) must not
    // project through the reset.
    clock += 5000;
    t.accept(state({ "3": running(2, 41) }));
    assert(t.read().etaSec === 0,
           "a bar that goes BACKWARDS re-anchors instead of quoting a rate " +
           "measured across the reset (" + t.read().etaSec + ")");

    // NEXT UP 37: the bar starts at 0 when the sampler node starts, and
    // dynamic-VRAM weights stream in during the first forward pass, so
    // step 0->1 is load time. The 12a H3 run at 1920x1072 (~20 s/step)
    // read "about 10m left" at step 2 and warned of a timeout it beat.
    t = Comfy._makeProgressTracker("p-1");
    t.accept(state({ "3": running(0, 20) }));
    clock += 46000;                       // step 1: 20 s + 26 s of staging
    t.accept(state({ "3": running(1, 20) }));
    assert(t.read().etaSec === 0,
           "step 0->1 includes weight staging — no estimate from it (" +
           t.read().etaSec + ")");
    clock += 20000;
    t.accept(state({ "3": running(2, 20) }));
    r = t.read();
    assert(r.etaSec === 360,
           "at step 2 the estimate is 18 steps x 20 s = 360 s, from step 1 " +
           "on, not 600 s through the staging step (" + r.etaSec + ")");
    assert(!/timeout/.test(Tools._generatingLine(66, r, 600, false)),
           "and a 66 s-in job projecting 360 s more warns of no timeout [" +
           Tools._generatingLine(66, r, 600, false) + "]");

    // The older builds' message shape.
    t = Comfy._makeProgressTracker("p-1");
    t.accept({ type: "progress", data: { node: "3", value: 4, max: 20 } });
    r = t.read();
    assert(r && r.value === 4 && r.max === 20,
           "a build that still sends the flat `progress` event is understood [" +
           JSON.stringify(r) + "]");
  } finally {
    Date.now = realNow;
  }
}

// ============================================================ 4. sentence

function sentenceChecks() {
  const line = Tools._generatingLine;
  assert(line(600, null) === "ComfyUI still generating… 600s",
         "no progress event -> the line is exactly what it always was [" +
         line(600, null) + "]");
  assert(line(600, { value: 3, max: 1 }) === "ComfyUI still generating… 600s",
         "a max of 1 is not a fraction worth showing [" +
         line(600, { value: 3, max: 1 }) + "]");
  assert(line(90, { value: 1, max: 41, etaSec: 0 }) ===
         "ComfyUI still generating… 90s — step 1/41",
         "one step seen -> the fraction, and NO invented estimate [" +
         line(90, { value: 1, max: 41, etaSec: 0 }) + "]");
  assert(line(120, { value: 14, max: 40, etaSec: 240 }) ===
         "ComfyUI still generating… 120s — step 14/40, about 4m left",
         "the fifteen-minute case reads as progress, not as a hang [" +
         line(120, { value: 14, max: 40, etaSec: 240 }) + "]");
  assert(/about 45s left$/.test(line(10, { value: 2, max: 4, etaSec: 45 })),
         "under a minute is quoted in seconds [" +
         line(10, { value: 2, max: 4, etaSec: 45 }) + "]");
  assert(/about 1h 5m left$/.test(line(10, { value: 1, max: 900, etaSec: 3900 })),
         "over an hour says so rather than '65m' [" +
         line(10, { value: 1, max: 900, etaSec: 3900 }) + "]");

  // §18 P3c: a finish projected past the timeout is a promise the panel
  // breaks by cancelling. Warn the first time, with setting and value.
  const p = { value: 10, max: 40, etaSec: 720 };
  assert(line(120, { value: 14, max: 40, etaSec: 240 }, 600, false) ===
         "ComfyUI still generating… 120s — step 14/40, about 4m left",
         "a finish INSIDE the timeout reads exactly as before [" +
         line(120, { value: 14, max: 40, etaSec: 240 }, 600, false) + "]");
  const first = line(120, p, 600, false);
  assert(/about 12m left — but that is past the generation timeout \(600s\)/.test(first) &&
         /Settings > Generation timeout \(s\)/.test(first),
         "a finish PAST the timeout says so, naming the value and the setting [" +
         first + "]");
  const later = line(130, p, 600, true);
  assert(/about 12m left \(past the 10m timeout\)$/.test(later) &&
         !/Settings/.test(later),
         "…and once warned, later lines carry a short tag, not the whole " +
         "warning every ten seconds [" + later + "]");
  assert(line(120, p) === "ComfyUI still generating… 120s — step 10/40, about 12m left",
         "no timeout passed -> no warning (old callers unchanged) [" +
         line(120, p) + "]");
  assert(!/timeout/.test(line(590, { value: 39, max: 40, etaSec: 0 }, 600, false)),
         "no estimate -> no timeout claim, since there is no projection to " +
         "compare [" + line(590, { value: 39, max: 40, etaSec: 0 }, 600, false) + "]");

  const note = Comfy._timeoutProgressNote;
  assert(note(null) === "" && note({ value: 3, max: 1 }) === "",
         "timeout message: no step reported -> no invented progress");
  assert(note({ value: 10, max: 40, etaSec: 720 }) ===
         " — it was at step 10/40 (25%), projected to need about 720s more",
         "timeout message carries the fraction and the projection [" +
         note({ value: 10, max: 40, etaSec: 720 }) + "]");
  assert(note({ value: 1, max: 40, etaSec: 0 }) === " — it was at step 1/40 (3%)",
         "…and no projection when the tracker had none [" +
         note({ value: 1, max: 40, etaSec: 0 }) + "]");
}

// ====================================================== 5. wiring + leak

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-progress-"));
const wfFile = path.join(tmpDir, "PROBE.json");
fs.writeFileSync(wfFile, JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "placeholder", clip: ["1", 1] } },
  "2": { class_type: "SaveImage", inputs: { filename_prefix: "probe", images: ["3", 0] } }
}), "utf8");

const DONE_HISTORY = {
  "p-1": {
    status: { status_str: "success", completed: true },
    outputs: { "2": { images: [{ filename: "probe_00001_.png",
                                subfolder: "", type: "output" }] } }
  }
};

/** One generation against a fake ComfyUI that finishes on the first poll. */
function generateOnce(opts, cb) {
  fakeComfy(opts.server || {}, (srv) => {
    const seenProgress = [];
    Comfy.generate({
      comfyUrl: srv.url,
      workflowFile: wfFile,
      outDir: path.join(tmpDir, "out"),
      timeoutSec: 20,
      params: { prompt: "a red cup", width: 64, height: 64, seed: 1 }
    }, opts.noSink ? null : ((s, p) => { seenProgress.push([s, p]); }),
    (err, res) => {
      // Let any close land before the assertions read the socket state.
      setTimeout(() => cb(err, res, srv, seenProgress), 150);
    });
  });
}

function wiringChecks(done) {
  let closedByPanel = false;
  generateOnce({
    server: {
      history: () => DONE_HISTORY,
      // "end", not "close": an upgraded socket is half-open, so the server
      // side stays writable after the peer goes away and never emits close.
      onSocket: (socket) => {
        socket.on("end", () => { closedByPanel = true; });
        socket.on("close", () => { closedByPanel = true; });
      }
    }
  }, (err, res, srv) => {
    assert(!err, "a normal generation still succeeds with the socket open [" +
           (err ? err.message : "no error") + "]");
    const up = srv.seen.filter((r) => r.method === "UPGRADE");
    const posted = srv.seen.findIndex((r) => r.url === "/prompt");
    const upgraded = srv.seen.findIndex((r) => r.method === "UPGRADE");
    assert(up.length === 1, "the event socket is opened once per generation (" +
           up.length + ")");
    assert(upgraded !== -1 && upgraded < posted,
           "…and BEFORE the queue POST, or a warm backend's first steps are " +
           "missed (upgrade at " + upgraded + ", POST at " + posted + ")");
    let sentId = null;
    try {
      sentId = JSON.parse(srv.seen[posted].body).client_id;
    } catch (e) {}
    assert(sentId && up[0].url.indexOf("clientId=" + sentId) !== -1,
           "…subscribed under the SAME client_id the prompt names, which is " +
           "the only id ComfyUI addresses these events to [" + sentId + "]");
    assert(closedByPanel,
           "the socket is CLOSED when the job settles — every generation " +
           "would otherwise leak one for the life of the panel");
    srv.close();

    // No sink -> no socket at all. Nothing should subscribe to an event
    // stream nobody is listening to.
    generateOnce({ noSink: true, server: { history: () => DONE_HISTORY } },
      (err2, res2, srv2) => {
        assert(!err2, "…and a caller that passed no onProgress still renders");
        assert(srv2.seen.filter((r) => r.method === "UPGRADE").length === 0,
               "no progress callback -> no websocket is opened at all");
        srv2.close();

        // A backend that refuses the upgrade must still render. This is the
        // whole safety property: progress may never fail a generation.
        generateOnce({ server: { history: () => DONE_HISTORY, refuseUpgrade: true } },
          (err3, res3, srv3) => {
            assert(!err3,
                   "a backend that REFUSES the /ws upgrade still renders — " +
                   "progress is never allowed to fail a generation [" +
                   (err3 ? err3.message : "no error") + "]");
            srv3.close();
            done();
          });
      });
  });
}

// ============================================ 6. end to end through generate

/**
 * The whole chain, once: a real socket pushing real progress_state frames
 * into a real Comfy.generate, and the sentence the panel would print. The
 * progress callback fires on a ten-second cadence, so this check costs
 * about eleven seconds and is worth them — it is the only one that proves
 * the pieces are actually connected to each other.
 */
function endToEndCheck(done) {
  let finish = false;
  fakeComfy({
    history: () => (finish ? DONE_HISTORY : {}),
    onSocket: (socket) => {
      let step = 0;
      // Paced so the ten-second progress callback lands MID-render: a fake
      // that finishes its bar in five seconds would only ever be observed
      // at 40/40, where there is nothing left to project.
      const tick = setInterval(() => {
        step += 2;
        socket.write(serverFrame(0x1, JSON.stringify({
          type: "progress_state",
          data: { prompt_id: "p-1",
                  nodes: { "3": { state: "running", value: step, max: 40 } } }
        })));
        if (step >= 40) clearInterval(tick);
      }, 1000);
      socket.on("close", () => clearInterval(tick));
    }
  }, (srv) => {
    const lines = [];
    Comfy.generate({
      comfyUrl: srv.url,
      workflowFile: wfFile,
      outDir: path.join(tmpDir, "out"),
      timeoutSec: 30,
      params: { prompt: "a red cup", width: 64, height: 64, seed: 1 }
    }, (elapsed, progress) => {
      lines.push(Tools._generatingLine(elapsed, progress));
      finish = true;             // let the next /history poll complete it
    }, (err) => {
      setTimeout(() => {
        assert(!err, "the end-to-end generation finished [" +
               (err ? err.message : "no error") + "]");
        assert(lines.length >= 1, "the progress callback fired (" +
               lines.length + ")");
        const first = lines[0] || "";
        assert(/step \d+\/40/.test(first),
               "…carrying step k/N all the way from a websocket frame to the " +
               "sentence the panel prints [" + first + "]");
        assert(/about \d+[a-z]/.test(first),
               "…and an estimate, which is the half that makes a long render " +
               "readable as progress [" + first + "]");
        srv.close();
        done();
      }, 100);
    });
  });
}

// ================================= 7. the timeout names what it cut off

/**
 * §18 P3c through the real generate: a job that reports steps and never
 * finishes hits a short timeout, and the error says how far it got and
 * that the limit is a setting. The fake has no /queue, so the cancel note
 * is the "could not be read" branch; that is not what is under test.
 */
function timeoutCheck(done) {
  fakeComfy({
    history: () => ({}),
    onSocket: (socket) => {
      let step = 0;
      const tick = setInterval(() => {
        step += 1;
        socket.write(serverFrame(0x1, JSON.stringify({
          type: "progress_state",
          data: { prompt_id: "p-1",
                  nodes: { "3": { state: "running", value: step, max: 40 } } }
        })));
      }, 700);
      socket.on("close", () => clearInterval(tick));
    }
  }, (srv) => {
    Comfy.generate({
      comfyUrl: srv.url,
      workflowFile: wfFile,
      outDir: path.join(tmpDir, "out"),
      timeoutSec: 4,
      params: { prompt: "a red cup", width: 64, height: 64, seed: 1 }
    }, () => {}, (err) => {
      const msg = err ? err.message : "";
      assert(/timed out after \d+s/.test(msg) &&
             /it was at step \d+\/40 \(\d+%\)/.test(msg),
             "a timeout names the step it was cut off at [" + msg + "]");
      assert(/projected to need about \d+s more/.test(msg),
             "…and the projection it had [" + msg + "]");
      assert(/Generation timeout \(s\) to let it finish$/.test(msg),
             "…and ends on the setting that would have let it finish [" +
             msg + "]");
      srv.close();
      done();
    });
  });
}

// ------------------------------------------------------------------ run

trackerChecks();
sentenceChecks();
decoderCheck(() => {
  pongCheck(() => {
    wiringChecks(() => {
      endToEndCheck(() => { timeoutCheck(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        console.log(failures === 0
          ? "\nAll comfy progress checks passed."
          : "\n" + failures + " check(s) FAILED.");
        process.exit(failures === 0 ? 0 : 1);
      }); });
    });
  });
});
