/*
 * test-comfy-node-errors.js — the run ComfyUI accepts, executes and
 * finishes without rendering anything.
 *
 * Measured in the field on 2026-08-30 (handoff-probe against a ComfyUI that
 * was one release behind the one the KREA2 template was validated on):
 *
 *   got prompt
 *   Failed to validate prompt for output 478:
 *   * CLIPLoader 439:437:
 *     - Value not in list: type: 'krea2' not in [...]
 *   Output will be ignored
 *   Failed to validate prompt for output 475:   Output will be ignored
 *   ... (all five outputs)
 *   Prompt executed in 0.01 seconds
 *
 * POST /prompt answered 200 WITH a prompt_id — ComfyUI queues a prompt whose
 * outputs all failed validation rather than rejecting it — and /history then
 * reported the run complete, with no error and no outputs. The panel said:
 *
 *   "Workflow finished but produced no output files (no SaveImage/SaveVideo
 *    node?)"
 *
 * which blames the template for the one thing that was NOT wrong with it.
 * The real reason had been handed over at queue time in `node_errors` and
 * thrown away. This pins that: when every output branch is dropped, the
 * error says what ComfyUI said.
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

// The smallest graph the panel will post: a loader, somewhere for the
// prompt to land (generate() refuses a template with no editable text) and
// a save node.
const GRAPH = {
  "1": { class_type: "CLIPLoader",
         inputs: { clip_name: "enc.safetensors", type: "krea2" } },
  "3": { class_type: "CLIPTextEncode",
         inputs: { text: "placeholder", clip: ["1", 0] } },
  "2": { class_type: "SaveImage",
         inputs: { filename_prefix: "probe", images: ["3", 0] } }
};

// ComfyUI's real node_errors shape, from the same capture.
const NODE_ERRORS = {
  "1": {
    class_type: "CLIPLoader",
    errors: [{
      type: "value_not_in_list",
      message: "Value not in list",
      details: "type: 'krea2' not in ['stable_diffusion', 'sd3', 'wan']"
    }]
  }
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-nodeerr-"));
const wfFile = path.join(tmpDir, "PROBE.json");
fs.writeFileSync(wfFile, JSON.stringify(GRAPH), "utf8");

/**
 * A ComfyUI that behaves exactly like the field capture: 200 + prompt_id +
 * node_errors on /prompt, then a COMPLETED history entry with no outputs
 * and no error status.
 */
function fakeComfy(opts, cb) {
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    res.setHeader("content-type", "application/json");
    if (/^\/object_info\//.test(url)) {
      const cls = decodeURIComponent(url.replace("/object_info/", ""));
      const out = {};
      out[cls] = { input: {}, output: [] };
      res.statusCode = 200;
      res.end(JSON.stringify(out));
      return;
    }
    if (url === "/prompt" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.statusCode = 200;
        const answer = { prompt_id: "p-1", number: 1 };
        if (opts.nodeErrors) answer.node_errors = opts.nodeErrors;
        res.end(JSON.stringify(answer));
      });
      return;
    }
    if (/^\/history\//.test(url)) {
      res.statusCode = 200;
      // Executed in 0.01 s: completed, no error, no outputs at all.
      res.end(JSON.stringify({
        "p-1": { outputs: {}, status: { status_str: "success",
                                        completed: true, messages: [] } }
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1", () => {
    cb(server, "http://127.0.0.1:" + server.address().port);
  });
}

function runOnce(opts, cb) {
  fakeComfy(opts, (server, url) => {
    Comfy.generate({
      comfyUrl: url,
      workflowFile: wfFile,
      outDir: path.join(tmpDir, "out"),
      timeoutSec: 20,
      params: { prompt: "a red cup", width: 64, height: 64, seed: 1 }
    }, null, function (err, result) {
      server.close();
      cb(err, result);
    });
  });
}

// 1. Every output dropped: the error must carry ComfyUI's own reason.
runOnce({ nodeErrors: NODE_ERRORS }, function (err) {
  assert(!!err, "a run that rendered nothing is an error, not a success");
  const msg = err ? err.message : "";
  assert(/dropped every output branch/.test(msg),
         "…and it says the outputs were dropped at validation [" + msg + "]");
  assert(msg.indexOf("CLIPLoader") !== -1 && msg.indexOf("krea2") !== -1,
         "…naming the node and the value ComfyUI refused [" + msg + "]");
  assert(!/SaveImage\/SaveVideo/.test(msg),
         "…and it no longer blames a missing save node [" + msg + "]");

  // 2. The control: no node_errors at all is a genuinely output-less
  // graph, and that message is still the right one.
  runOnce({ nodeErrors: null }, function (err2) {
    const msg2 = err2 ? err2.message : "";
    assert(!!err2 && /no SaveImage\/SaveVideo node/.test(msg2),
           "with nothing skipped, a graph with no save node still says so [" +
           msg2 + "]");

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    console.log(failures === 0
      ? "\nAll node-error checks passed."
      : "\n" + failures + " check(s) FAILED.");
    process.exit(failures === 0 ? 0 : 1);
  });
});
