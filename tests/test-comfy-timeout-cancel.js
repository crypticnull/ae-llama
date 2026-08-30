/*
 * test-comfy-timeout-cancel.js — the job the panel gave up on and left
 * running.
 *
 * Measured in the field on 2026-08-30 (scripts/oom-probe.js, RTX 5090,
 * ComfyUI 0.32.0). WORKPLAN item 7's last bullet asked for a real CUDA OOM;
 * this backend will not give one — an oversized KREA2 job offloads and
 * GRINDS (33 s/it, then 92 s/it, no error, no end). So the reachable shape
 * of "a generation the card cannot do" is the panel's own TIMEOUT, and that
 * turned out to be worse than an OOM: torch frees its allocation on the way
 * out, an abandoned job does not.
 *
 * What the probe recorded, before the fix:
 *
 *   .. ComfyUI still generating... 90s
 *   .. VRAM did not visibly release within 10 s - proceeding anyway.
 *   .. Warming the chat model back up...
 *   -- at warm-up: VRAM 23673 MB, ComfyUI queue 1 running / 0 pending
 *
 * The panel stopped looking, said "prompt <id> may still finish in ComfyUI",
 * and then asked llama-server to load a 18 932 MB model into a 32 768 MB
 * card that the job it had just abandoned still held 23 673 MB of. (On
 * Windows the driver's sysmem fallback hid the collision; the chat model
 * came back spilled into host RAM.)
 *
 * The fix is that a timeout now CANCELS. These checks pin the whole rule,
 * including the half that matters most on a user's machine: this is the
 * USER'S ComfyUI and they may have queued their own work in its own UI, so
 * only the panel's OWN prompt id may ever be touched.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

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

const GRAPH = {
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "m.safetensors" } },
  "3": { class_type: "CLIPTextEncode",
         inputs: { text: "placeholder", clip: ["1", 1] } },
  "2": { class_type: "SaveImage",
         inputs: { filename_prefix: "probe", images: ["3", 0] } }
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-timeout-"));
const wfFile = path.join(tmpDir, "PROBE.json");
fs.writeFileSync(wfFile, JSON.stringify(GRAPH), "utf8");

/**
 * A ComfyUI that accepts the prompt and then never finishes it — the real
 * shape of the grind. `opts.queue` decides what /queue says about our
 * prompt; every request is recorded so the checks can assert what the panel
 * did NOT do as firmly as what it did.
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
        const out = {};
        out[cls] = { input: {}, output: [] };
        res.statusCode = 200; res.end(JSON.stringify(out)); return;
      }
      if (url === "/prompt" && req.method === "POST") {
        res.statusCode = 200;
        res.end(JSON.stringify({ prompt_id: "p-1", number: 1 }));
        return;
      }
      if (/^\/history\//.test(url)) {
        // Never finishes: no entry for the prompt at all, which is what
        // ComfyUI reports for a job that is still running.
        res.statusCode = 200; res.end("{}"); return;
      }
      if (url === "/queue" && req.method === "GET") {
        if (opts.queueUnreadable) { res.statusCode = 500; res.end("nope"); return; }
        res.statusCode = 200;
        res.end(JSON.stringify(opts.queue));
        return;
      }
      if (url === "/queue" && req.method === "POST") {
        res.statusCode = 200; res.end("{}"); return;
      }
      if (url === "/interrupt" && req.method === "POST") {
        res.statusCode = 200; res.end(""); return;
      }
      res.statusCode = 404; res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1", () => {
    cb(server, "http://127.0.0.1:" + server.address().port, seen);
  });
}

/** One timed-out generation. cb(err, seen, callCount). */
function runOnce(opts, cb) {
  fakeComfy(opts, (server, url, seen) => {
    let calls = 0;
    let first = null;
    Comfy.generate({
      comfyUrl: url,
      workflowFile: wfFile,
      outDir: path.join(tmpDir, "out"),
      // Shorter than one poll period would time out before the first
      // /history is even asked for; 3 s gives the poller a tick first, so
      // the cancel happens on the path a real grind takes.
      timeoutSec: 3,
      params: { prompt: "a red cup", width: 64, height: 64, seed: 1 }
    }, null, function (err) {
      calls++;
      if (calls === 1) {
        first = err;
        // Give any straggler poll a chance to call back a second time.
        setTimeout(function () {
          server.close();
          cb(first, seen, calls);
        }, 2500);
      }
    });
  });
}

const OURS_RUNNING = {
  queue_running: [[1, "p-1", {}, {}, []]], queue_pending: []
};
const OURS_PENDING = {
  queue_running: [[9, "someone-else", {}, {}, []]],
  queue_pending: [[10, "p-1", {}, {}, []]]
};
const ONLY_THEIRS = {
  queue_running: [[9, "someone-else", {}, {}, []]],
  queue_pending: [[10, "also-theirs", {}, {}, []]]
};

function posts(seen, url) {
  return seen.filter((r) => r.method === "POST" && r.url === url);
}

// 1. Ours is the RUNNING job — targeted interrupt, no queue delete.
runOnce({ queue: OURS_RUNNING }, function (err, seen, calls) {
  const msg = err ? err.message : "";
  assert(!!err && /timed out after \d+s/.test(msg),
         "a grind that outlives the timeout is still a timeout error [" +
         msg + "]");
  assert(!/may still finish in ComfyUI/.test(msg),
         "…and it no longer promises the job might still finish [" + msg + "]");
  assert(/has been cancelled/.test(msg),
         "…it says the job was cancelled [" + msg + "]");
  assert(calls === 1, "cb fired exactly once (" + calls + ")");

  const ints = posts(seen, "/interrupt");
  assert(ints.length === 1, "POST /interrupt was sent once (" +
         ints.length + ")");
  let sentId = null;
  try { sentId = JSON.parse(ints[0].body).prompt_id; } catch (e) {}
  assert(sentId === "p-1",
         "…TARGETED at our own prompt id, so an older ComfyUI's global " +
         "interrupt still cancels the job we mean [" + sentId + "]");
  assert(posts(seen, "/queue").length === 0,
         "…and a running job is not also deleted from the queue");
  assert(seen.some((r) => r.method === "GET" && r.url === "/queue"),
         "the queue was READ before anything was cancelled");

  // 2. Ours is still PENDING behind the user's own job — delete by id,
  //    never interrupt (that would kill THEIR render).
  runOnce({ queue: OURS_PENDING }, function (err2, seen2) {
    const msg2 = err2 ? err2.message : "";
    assert(/still queued and has been removed/.test(msg2),
           "a job still waiting in the queue is removed, not interrupted [" +
           msg2 + "]");
    assert(posts(seen2, "/interrupt").length === 0,
           "…the user's OWN running render is never interrupted");
    const dels = posts(seen2, "/queue");
    assert(dels.length === 1, "POST /queue delete was sent once (" +
           dels.length + ")");
    let del = null;
    try { del = JSON.parse(dels[0].body); } catch (e) {}
    assert(!!del && del["delete"] instanceof Array &&
           del["delete"].length === 1 && del["delete"][0] === "p-1",
           "…naming only our prompt id [" + JSON.stringify(del) + "]");

    // 3. Ours is gone and only the user's own work is in the queue —
    //    the panel must touch NOTHING. This is the check that stops a
    //    future "just interrupt on timeout" from shipping.
    runOnce({ queue: ONLY_THEIRS }, function (err3, seen3) {
      const msg3 = err3 ? err3.message : "";
      assert(/no longer running it/.test(msg3),
             "a prompt ComfyUI no longer holds is reported as gone [" +
             msg3 + "]");
      assert(posts(seen3, "/interrupt").length === 0 &&
             posts(seen3, "/queue").length === 0,
             "…and nothing of the user's is cancelled or deleted");

      // 4. The queue cannot be read at all — say so, cancel nothing, and
      //    still end the round.
      runOnce({ queueUnreadable: true }, function (err4, seen4, calls4) {
        const msg4 = err4 ? err4.message : "";
        assert(!!err4 && /timed out after \d+s/.test(msg4),
               "an unreadable queue still ends the round with the timeout [" +
               msg4 + "]");
        assert(/could not be read/.test(msg4) &&
               /may still be running/.test(msg4),
               "…and says honestly that the job was left alone [" + msg4 + "]");
        assert(posts(seen4, "/interrupt").length === 0,
               "…without guessing and interrupting blindly");
        assert(calls4 === 1, "cb still fired exactly once (" + calls4 + ")");

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        console.log(failures === 0
          ? "\nAll timeout-cancel checks passed."
          : "\n" + failures + " check(s) FAILED.");
        process.exit(failures === 0 ? 0 : 1);
      });
    });
  });
});
