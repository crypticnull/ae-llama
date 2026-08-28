/*
 * test-comfy-filename-tokens.js — the %date:…% expansion the FRONTEND does.
 *
 * ComfyUI advertises %date:yyyy-MM-dd% and %Node title.widget% inside
 * filename_prefix (SaveVideo's own tooltip), but nothing on the server
 * expands them: the browser rewrites the text in applyTextReplacements()
 * before it posts, and the server saves whatever string it is handed. A
 * panel that posts API-format graphs IS the frontend.
 *
 * Measured in the field on 2026-08-27 (comfy-probe, ComfyUI 0.32.0): posting
 * the bundled H3 template verbatim rendered every frame and then died at the
 * final node with
 *
 *   [WinError 267] The directory name is invalid:
 *   'C:\…\output\video\MiniMax_H3\%date:yyyy_MM_dd%'
 *
 * because the unexpanded token still holds a COLON, which Windows refuses in
 * a path. The same template run from ComfyUI's own UI on that machine wrote
 * output/video/MiniMax_H3/2026_08_03/ — the proof the expansion is the
 * client's job. Everything below pins that bug class without a GPU.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}
function eq(actual, expected, label) {
  assert(actual === expected, label + " [" + JSON.stringify(actual) + "]");
}

const REPO = path.join(__dirname, "..");
const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
  Settings: { dataRoot: () => REPO },
  setTimeout, clearTimeout, setInterval, clearInterval
};
eval(fs.readFileSync(path.join(REPO, "extension", "js", "comfy.js"), "utf8"));
const Comfy = window.Comfy;

const TEMPLATE = path.join(REPO, "extension", "comfy-workflows",
                           "AE_LLAMA_H3_I2V_V1.json");
const template = () => JSON.parse(fs.readFileSync(TEMPLATE, "utf8"));

// A fixed instant, so the expected strings are exact: 2026-08-27 04:05:09.
const WHEN = new Date(2026, 7, 27, 4, 5, 9);

// --------------------------------------------- the shipped template

{
  const g = template();
  const prefix = g["92"].inputs.filename_prefix;
  assert(g["92"].class_type === "SaveVideo",
         "the shipped template still saves from SaveVideo at node 92");
  assert(prefix.indexOf("%date:") !== -1,
         "and its filename_prefix still carries a %date:…% token [" +
         prefix + "]");

  const changes = Comfy.expandFilenameTokens(g, WHEN);
  eq(g["92"].inputs.filename_prefix,
     "video/MiniMax_H3/2026_08_27/2026_08_27_",
     "expanding rewrites BOTH tokens in the shipped prefix");
  assert(changes.length === 1 && changes[0].indexOf("92.filename_prefix") === 0,
         "and reports the one change it made [" + changes.join("; ") + "]");

  // The actual failure mode, stated as its own assertion: a colon anywhere
  // in the posted prefix is a dead render on Windows.
  assert(g["92"].inputs.filename_prefix.indexOf(":") === -1,
         "nothing colon-shaped survives into the posted filename_prefix");

  // Idempotent — a second pass has nothing left to do.
  eq(Comfy.expandFilenameTokens(g, WHEN).length, 0,
     "running it twice changes nothing the second time");
}

// ------------------------------------------------- the date grammar
//
// Ported literally from the frontend's formatDate (comfyui_frontend_package
// 1.48.7): tokens dd?|MM?|hh?|mm?|ss?|yyy?y?, zero-padded to the token's own
// length, everything else verbatim.

function fmt(spec) {
  const g = { "1": { class_type: "SaveImage",
                     inputs: { filename_prefix: "%date:" + spec + "%" } } };
  Comfy.expandFilenameTokens(g, WHEN);
  return g["1"].inputs.filename_prefix;
}

eq(fmt("yyyy-MM-dd"), "2026-08-27", "yyyy-MM-dd");
eq(fmt("yyyy_MM_dd"), "2026_08_27", "yyyy_MM_dd (the bundled template's own)");
eq(fmt("yy"), "26", "yy is the last two digits");
eq(fmt("yyy"), "yyy", "yyy is not a date token and stays verbatim");
eq(fmt("M-d"), "8-27", "single M and d are unpadded");
eq(fmt("MM-dd"), "08-27", "MM and dd are zero-padded");
eq(fmt("hhmmss"), "040509", "hh mm ss, each padded to its token length");
eq(fmt("h_m_s"), "4_5_9", "single h m s are unpadded");
eq(fmt("yyyyMMdd_hhmmss"), "20260827_040509", "a full stamp");

// ------------------------------------------- what must NOT be touched

{
  // A user's prompt with percent signs. The browser's own rule — a token
  // that is neither date: nor exactly Node.widget is returned untouched —
  // is what keeps this safe, so it is asserted here rather than trusted.
  const g = {
    "1": { class_type: "CLIPTextEncode",
           inputs: { text: "raise brightness 50% to 100%, contrast 20%" } }
  };
  const changes = Comfy.expandFilenameTokens(g, WHEN);
  eq(g["1"].inputs.text, "raise brightness 50% to 100%, contrast 20%",
     "a prompt full of percent signs is left exactly alone");
  eq(changes.length, 0, "and reports no change");
}

{
  const g = {
    "1": { class_type: "SaveImage",
           inputs: { filename_prefix: "%date:yyyy%", images: ["2", 0] } },
    "2": { class_type: "VAEDecode", inputs: {} }
  };
  Comfy.expandFilenameTokens(g, WHEN);
  assert(Array.isArray(g["1"].inputs.images) &&
         g["1"].inputs.images[0] === "2",
         "links are not strings and are never rewritten");
}

{
  const g = { "1": { class_type: "SaveImage",
                     inputs: { filename_prefix: "%unknown_thing%" } } };
  eq(Comfy.expandFilenameTokens(g, WHEN).length, 0,
     "an unrecognised token is left visible rather than guessed at");
  eq(g["1"].inputs.filename_prefix, "%unknown_thing%",
     "and the text is unchanged");
}

// ------------------------------------------ %Node.widget% references

{
  const g = {
    "1": { class_type: "SaveImage",
           inputs: { filename_prefix: "run_%EmptyLatentImage.width%" } },
    "2": { class_type: "EmptyLatentImage", inputs: { width: 1024 } }
  };
  Comfy.expandFilenameTokens(g, WHEN);
  eq(g["1"].inputs.filename_prefix, "run_1024",
     "a %Class.widget% reference reads the other node's literal value");
}

{
  // _meta.title is what the adapter preserves from the UI's node title, and
  // it is the second name the browser matches on.
  const g = {
    "1": { class_type: "SaveImage",
           inputs: { filename_prefix: "%My Latent.width%" } },
    "2": { class_type: "EmptyLatentImage", inputs: { width: 512 },
           _meta: { title: "My Latent" } }
  };
  Comfy.expandFilenameTokens(g, WHEN);
  eq(g["1"].inputs.filename_prefix, "512",
     "a reference by the node's _meta title also resolves");
}

{
  const g = {
    "1": { class_type: "SaveImage",
           inputs: { filename_prefix: "%CheckpointLoaderSimple.ckpt_name%" } },
    "2": { class_type: "CheckpointLoaderSimple",
           inputs: { ckpt_name: "SDXL/base:v1.0<final>.safetensors" } }
  };
  Comfy.expandFilenameTokens(g, WHEN);
  eq(g["1"].inputs.filename_prefix, "SDXL_base_v1.0_final_.safetensors",
     "characters no path may hold are scrubbed out of a referenced value");
}

{
  const g = {
    "1": { class_type: "SaveImage",
           inputs: { filename_prefix: "%EmptyLatentImage.width%" } },
    "2": { class_type: "EmptyLatentImage", inputs: { width: ["3", 0] } },
    "3": { class_type: "PrimitiveInt", inputs: { value: 640 } }
  };
  Comfy.expandFilenameTokens(g, WHEN);
  eq(g["1"].inputs.filename_prefix, "%EmptyLatentImage.width%",
     "a LINKED input has no literal to substitute, so the token stays");
}

{
  const g = { "1": { class_type: "SaveImage",
                     inputs: { filename_prefix: "%NoSuchNode.width%" } } };
  Comfy.expandFilenameTokens(g, WHEN);
  eq(g["1"].inputs.filename_prefix, "%NoSuchNode.width%",
     "a reference to a node that is not in the graph is left visible");
}

// -------------------------------- the call site, not just the function
//
// The function existing proves nothing if generate() stops calling it. This
// queues the REAL template at a fake ComfyUI and reads what was POSTed.

function fakeComfy(cb) {
  let posted = null;
  const server = http.createServer((req, res) => {
    if (/^\/object_info\//.test(req.url || "")) {
      const cls = decodeURIComponent(req.url.replace("/object_info/", ""));
      const out = {};
      // Keep node 168: the bypass path has its own suite; this one is about
      // the graph that actually gets posted.
      out[cls] = { input: {}, output: [] };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
      return;
    }
    if (req.url === "/prompt" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try { posted = JSON.parse(body).prompt; } catch (e) { posted = null; }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        // No prompt_id -> generate() gives up before polling, which is all
        // this check needs: the POST already happened.
        res.end(JSON.stringify({ error: { message: "stop here" } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1", () => {
    cb(server, "http://127.0.0.1:" + server.address().port,
       () => posted);
  });
}

fakeComfy((server, url, getPosted) => {
  Comfy.generate({
    comfyUrl: url,
    workflowFile: TEMPLATE,
    outDir: path.join(REPO, "logs", "unused-by-this-test"),
    timeoutSec: 5,
    params: { prompt: "a red toy car", durationSeconds: 1,
              width: 512, height: 288, seed: 1 }
  }, null, function () {
    const posted = getPosted();
    assert(posted !== null, "generate() POSTed a prompt");
    if (posted) {
      const prefix = posted["92"].inputs.filename_prefix;
      assert(prefix.indexOf("%date:") === -1,
             "generate() expands the token BEFORE posting [" + prefix + "]");
      assert(prefix.indexOf(":") === -1,
             "so nothing Windows rejects reaches ComfyUI [" + prefix + "]");
      assert(/^video\/MiniMax_H3\/\d{4}_\d{2}_\d{2}\//.test(prefix),
             "and the prefix is a real dated folder [" + prefix + "]");
    }
    server.close();
    console.log(failures === 0
      ? "\nAll filename-token checks passed."
      : "\n" + failures + " check(s) FAILED.");
    process.exit(failures === 0 ? 0 : 1);
  });
});
