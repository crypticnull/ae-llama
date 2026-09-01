/*
 * test-comfy-image-landed.js — the image that uploads fine and lands nowhere.
 *
 * Audited on the shipped KREA2 template: comfy_generate with {image} uploads
 * the file into ComfyUI's input dir, injectParams finds no node to hand it
 * to (KREA2's manifest has no procedural.firstFrame and the generic walk
 * never places images), and the run then SUCCEEDS — as pure text-to-image,
 * the reference silently ignored. Every step reported success; the only
 * evidence was the output not resembling the reference.
 *
 * The rule pinned here: after ALL injection paths and before the queue
 * POST, generate() reads the MUTATED GRAPH for the server-returned upload
 * name — not the applied[] prose, which is written for the model and can
 * fail to say what the graph does not carry. An image that landed nowhere
 * refuses, grounded: the workflow is named, and the templates whose
 * manifest declares procedural.firstFrame (the only route an image takes
 * into a graph) are listed. Nothing is queued, so the refusal is what the
 * chat model sees instead of a wrong render.
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

// ---------------------------------------------------------------- fixtures

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-imgland-"));
const wfDir = path.join(tmpDir, "workflows");
fs.mkdirSync(wfDir);

// KREA2-shaped: a prompt can land (CLIPTextEncode with literal text), but
// nothing in the graph or manifest takes an image.
const KREA2ISH = {
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "m.safetensors" } },
  "3": { class_type: "CLIPTextEncode",
         inputs: { text: "placeholder", clip: ["1", 1] } },
  "2": { class_type: "SaveImage",
         inputs: { filename_prefix: "probe", images: ["3", 0] } }
};
const kreaFile = path.join(wfDir, "AE_LLAMA_KREA2ISH.json");
fs.writeFileSync(kreaFile, JSON.stringify(KREA2ISH), "utf8");

// H3-shaped: the manifest's procedural.firstFrame hands the uploaded name
// to a LoadImage, exactly like the shipped MiniMax H3 i2v template.
const H3ISH = {
  "114": { class_type: "LoadImage",
           inputs: { image: "only-on-the-owners-machine.png" } },
  "138": { class_type: "MiniMaxH3ImageToVideo",
           inputs: { prompt: "(neutral example)",
                     first_frame: ["114", 0] } },
  "2": { class_type: "SaveVideo",
         inputs: { filename_prefix: "probe", video: ["138", 0] } }
};
const h3File = path.join(wfDir, "AE_LLAMA_H3ISH.json");
fs.writeFileSync(h3File, JSON.stringify(H3ISH), "utf8");
fs.writeFileSync(h3File.replace(/\.json$/, ".manifest.json"), JSON.stringify({
  procedural: {
    prompt: { nodeId: 138, input: "prompt" },
    firstFrame: { nodeId: 114, input: "image", detachable: true }
  }
}), "utf8");

// A second image-capable template: the refusal must list THE ONES that
// would accept an image, plural when there are several.
const otherFile = path.join(wfDir, "AE_LLAMA_OTHER_I2V.json");
fs.writeFileSync(otherFile, JSON.stringify(H3ISH), "utf8");
fs.writeFileSync(otherFile.replace(/\.json$/, ".manifest.json"),
  JSON.stringify({ procedural: {
    prompt: { nodeId: 138, input: "prompt" },
    firstFrame: { nodeId: 114, input: "image" }
  } }), "utf8");

// A dir where NO template takes an image — the refusal's other branch.
const bareDir = path.join(tmpDir, "bare");
fs.mkdirSync(bareDir);
const bareFile = path.join(bareDir, "AE_LLAMA_KREA2ISH.json");
fs.writeFileSync(bareFile, JSON.stringify(KREA2ISH), "utf8");

const imgPath = path.join(tmpDir, "grab 0001.png");
fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

// -------------------------------------------------------------- the server

/**
 * A ComfyUI whose upload endpoint RENAMES what it stores ("srv-" + the sent
 * name) — the graph may only ever carry the server's answer, and a panel
 * that reused its local basename would be caught by exactly this rename.
 * Every request is recorded so the checks can assert what was NOT posted.
 */
function fakeComfy(cb) {
  const seen = [];
  const state = { uploadedAs: null, postedGraph: null };
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(req.method + " " + url);
      const body = Buffer.concat(chunks);
      if (url === "/upload/image" && req.method === "POST") {
        const named = /name="image"; filename="([^"]+)"/
          .exec(body.toString("latin1"));
        state.uploadedAs = "srv-" + (named ? named[1] : "unnamed");
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ name: state.uploadedAs, subfolder: "",
                                 type: "input" }));
        return;
      }
      if (url === "/prompt" && req.method === "POST") {
        state.postedGraph = JSON.parse(body.toString("utf8")).prompt;
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ prompt_id: "p-1", number: 1 }));
        return;
      }
      if (/^\/history\//.test(url)) {
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ "p-1": {
          outputs: { "2": { images: [{ filename: "out.png", subfolder: "",
                                       type: "output" }] } },
          status: { status_str: "success", completed: true, messages: [] }
        } }));
        return;
      }
      if (/^\/view/.test(url)) {
        res.statusCode = 200;
        res.end(Buffer.from([0x01]));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1", () => {
    cb(server, "http://127.0.0.1:" + server.address().port, seen, state);
  });
}

// ------------------------------------------------------------- the checks

// 1. KREA2 shape + image: refused, grounded, and NOTHING queued.
fakeComfy((server, url, seen, state) => {
  Comfy.generate({
    comfyUrl: url, workflowFile: kreaFile,
    outDir: path.join(tmpDir, "out"), timeoutSec: 20,
    params: { prompt: "a red cup", image: imgPath }
  }, null, (err) => {
    server.close();
    const msg = err ? err.message : "(no error)";
    assert(!!err, "an image on a template with no image input is an ERROR, " +
           "not a quiet text-to-image run");
    assert(msg.indexOf("AE_LLAMA_KREA2ISH") !== -1,
           "the refusal names the workflow [" + msg + "]");
    assert(msg.indexOf("no image input") !== -1,
           "and says it has no image input");
    assert(msg.indexOf("procedural.firstFrame") !== -1,
           "and says what an accepting template declares");
    assert(msg.indexOf("AE_LLAMA_H3ISH") !== -1 &&
           msg.indexOf("AE_LLAMA_OTHER_I2V") !== -1,
           "and lists BOTH templates that would accept one [" + msg + "]");
    assert(seen.some((s) => s === "POST /upload/image"),
           "the upload itself happened — the check needs the server's name");
    assert(!seen.some((s) => s === "POST /prompt"),
           "but the generation was never queued: " + seen.join(", "));

    // 2. Same shape, a folder with no image-capable template at all.
    fakeComfy((server2, url2) => {
      Comfy.generate({
        comfyUrl: url2, workflowFile: bareFile,
        outDir: path.join(tmpDir, "out"), timeoutSec: 20,
        params: { prompt: "a red cup", image: imgPath }
      }, null, (err2) => {
        server2.close();
        const msg2 = err2 ? err2.message : "(no error)";
        assert(!!err2 && msg2.indexOf("none of the templates") !== -1,
               "with no accepting template anywhere, the refusal says so " +
               "instead of listing nothing [" + msg2 + "]");

        // 3. H3 shape: the image lands, the run queues, and the QUEUED
        // graph carries the SERVER-returned unique name.
        fakeComfy((server3, url3, seen3, state3) => {
          Comfy.generate({
            comfyUrl: url3, workflowFile: h3File,
            outDir: path.join(tmpDir, "out"), timeoutSec: 20,
            params: { prompt: "a kite", image: imgPath }
          }, null, (err3, result) => {
            server3.close();
            assert(!err3, "a firstFrame manifest accepts the image" +
                   (err3 ? " [" + err3.message + "]" : ""));
            assert(result && result.files && result.files.length === 1,
                   "and the run completes end to end");
            const g = state3.postedGraph;
            const landed = g && g["114"] ? g["114"].inputs.image : null;
            assert(landed === state3.uploadedAs,
                   "the queued LoadImage names EXACTLY what the server said " +
                   "it stored (" + landed + ")");
            assert(/^srv-aell-[0-9a-z]+-\d+_grab 0001\.png$/.test(landed || ""),
                   "which carries the per-call unique prefix and keeps the " +
                   "source basename and extension (" + landed + ")");

            try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
            catch (e) {}
            console.log(failures === 0
              ? "\nAll image-landed checks passed."
              : "\n" + failures + " check(s) FAILED.");
            process.exit(failures === 0 ? 0 : 1);
          });
        });
      });
    });
  });
});
