/*
 * test-comfy-inject.js — manifest-driven injection points (WORKPLAN 2d part 2).
 *
 * The generic introspection in injectParams only understands
 * CLIPTextEncode-shaped graphs. MiniMax H3 carries its prompt on the sampler
 * node, its length in SECONDS on a primitive feeding a frame-grid expression,
 * and its size as MEGAPIXELS on a ResolutionSelector — so a template like that
 * renders its own placeholder text at its own size unless the sidecar
 * manifest's `procedural` block is honoured.
 *
 * The stub graph below reproduces the real shapes measured on the shipped
 * H3 i2v template (see WORKPLAN-LOG 2026-08-26), including the two that bite:
 *   - node 167's megapixels widget holds a STRING (".98"), not a number;
 *   - node 138's first_frame is a LINK to a LoadImage naming a file that
 *     exists on exactly one machine.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}
function throws(fn, needle, label) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  if (msg === null) { failures++; console.log("FAIL- " + label + " (did not throw)"); return; }
  assert(msg.indexOf(needle) !== -1, label + " [" + msg + "]");
  return msg;
}

const REPO = path.join(__dirname, "..");
const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
  Settings: { dataRoot: () => REPO },
  setTimeout, clearTimeout, setInterval, clearInterval
};
eval(fs.readFileSync(path.join(REPO, "extension", "js", "comfy.js"), "utf8"));
const Comfy = window.Comfy;

// --------------------------------------------------------------- the stub

function h3Graph() {
  return {
    "114": { class_type: "LoadImage",
             inputs: { image: "only-on-the-owners-machine.png" } },
    "115": { class_type: "ResolutionSelector",
             inputs: { aspect_ratio: "16:9 (Widescreen)",
                       megapixels: ["167", 0], multiple: 32 } },
    "136": { class_type: "PrimitiveFloat", inputs: { value: 15 } },
    // The real one stores ".98" as a STRING. Writing a number back would
    // change the widget's type under a node that declared it FLOAT-as-text.
    "167": { class_type: "Float", inputs: { Number: ".98" } },
    "138": { class_type: "MiniMaxH3ImageToVideo",
             inputs: { prompt: "(neutral example)",
                       width: ["115", 0], height: ["115", 1],
                       length: ["135", 1], clip: ["137", 0],
                       vae: ["129", 0], first_frame: ["114", 0] } },
    "133": { class_type: "RandomNoise", inputs: { noise_seed: 1 } }
  };
}

function h3Manifest() {
  return { procedural: {
    prompt: { nodeId: 138, widget: 0, input: "prompt" },
    durationSeconds: { nodeId: 136, widget: 0, input: "value" },
    resolution: { nodeId: 167, widget: 0, input: "Number",
                  maxMegapixels: 1.03 },
    firstFrame: { nodeId: 114, input: "image", detachable: true }
  } };
}

// ------------------------------------------------------- prompt + duration

let g = h3Graph();
let applied = Comfy.injectParams(g, { prompt: "a kite over the sea",
                                      durationSeconds: 6, seed: 42 },
                                 h3Manifest());
assert(g["138"].inputs.prompt === "a kite over the sea",
       "the prompt lands on the sampler node the manifest names");
assert(g["136"].inputs.value === 6,
       "durationSeconds lands on the seconds primitive");
assert(g["133"].inputs.noise_seed === 42,
       "the generic passes still run alongside the procedural ones");
assert(applied.join(" ").indexOf("prompt -> node 138.prompt") !== -1,
       "applied names the exact node.input the prompt went to");

// The whole point of the seconds/frames distinction: 120 frames written into
// a seconds widget asks for a two-minute render and looks like it worked.
throws(() => Comfy.injectParams(h3Graph(), { prompt: "x", frames: 120 },
                                h3Manifest()),
       "durationSeconds",
       "'frames' on a seconds template is REFUSED, naming durationSeconds");
let msg = null;
try { Comfy.injectParams(h3Graph(), { prompt: "x", frames: 120 }, h3Manifest()); }
catch (e) { msg = e.message; }
assert(msg.indexOf("120") !== -1,
       "and the refusal quotes the frame count it was handed");

// Both given: the explicit seconds win, no refusal.
g = h3Graph();
Comfy.injectParams(g, { prompt: "x", frames: 120, durationSeconds: 5 },
                   h3Manifest());
assert(g["136"].inputs.value === 5,
       "durationSeconds wins when the caller sends both");

// A template with no seconds input says so rather than silently dropping it.
g = h3Graph();
applied = Comfy.injectParams(g, { prompt: "x", durationSeconds: 5 },
  { procedural: { prompt: { nodeId: 138, input: "prompt" } } });
assert(applied.join(" ").indexOf("durationSeconds ignored") !== -1,
       "durationSeconds against a template that has none is reported, " +
       "not swallowed");

// ------------------------------------------------------------- resolution

g = h3Graph();
applied = Comfy.injectParams(g, { prompt: "x", width: 1024, height: 576 },
                             h3Manifest());
assert(g["167"].inputs.Number === "0.59",
       "width x height becomes megapixels, written as the STRING the " +
       "widget was authored as");
assert(applied.join(" ").indexOf("aspect ratio") !== -1,
       "and the caller is told the pixel dims come from the template's " +
       "own aspect ratio, not from their width/height");

g = h3Graph();
applied = Comfy.injectParams(g, { prompt: "x", width: 1920, height: 1080 },
                             h3Manifest());
assert(g["167"].inputs.Number === "1.03",
       "an over-large request is capped at the model's trained maximum");
assert(applied.join(" ").indexOf("capped") !== -1, "and the cap is reported");

// Width without height is not enough to compute an area — leave it alone.
g = h3Graph();
Comfy.injectParams(g, { prompt: "x", width: 1920 }, h3Manifest());
assert(g["167"].inputs.Number === ".98",
       "width alone does not touch the megapixels widget");

// -------------------------------------------------------- the first frame

g = h3Graph();
applied = Comfy.injectParams(g, { prompt: "x" }, h3Manifest());
assert(g["114"] === undefined,
       "with no image the LoadImage node is deleted — its authored filename " +
       "exists on nobody else's machine and would fail validation");
assert(g["138"].inputs.first_frame === undefined,
       "and the optional input that linked to it is removed, so the graph " +
       "runs as text-to-video");
assert(g["138"].inputs.clip !== undefined && g["138"].inputs.vae !== undefined,
       "detaching removes ONLY the inputs fed by that node");
assert(applied.join(" ").indexOf("138.first_frame") !== -1,
       "applied names the input it detached");

g = h3Graph();
applied = Comfy.injectParams(g, { prompt: "x", imageName: "frame_0001.png" },
                             h3Manifest());
assert(g["114"].inputs.image === "frame_0001.png",
       "with an uploaded name, the LoadImage keeps its place and is renamed");
assert(g["138"].inputs.first_frame instanceof Array,
       "and the link into the sampler survives");

// Not marked detachable: refuse to guess that the input is optional, and say
// what was left standing.
g = h3Graph();
const notDetachable = h3Manifest();
delete notDetachable.procedural.firstFrame.detachable;
applied = Comfy.injectParams(g, { prompt: "x" }, notDetachable);
assert(g["114"] !== undefined && applied.join(" ").indexOf("not marked " +
       "detachable") !== -1,
       "an undeclared reference frame is kept, with the reason stated");

// ------------------------------------------------------- grounded refusals

throws(() => Comfy.injectParams(h3Graph(), { prompt: "x" },
  { procedural: { prompt: { nodeId: 999, input: "prompt" } } }),
  "not in this workflow",
  "a manifest pointing at a node the workflow lacks refuses by id");

msg = throws(() => Comfy.injectParams(h3Graph(), { prompt: "x" },
  { procedural: { prompt: { nodeId: 138, input: "text" } } }),
  "does not have",
  "a wrong input NAME refuses");
assert(msg.indexOf("prompt") !== -1,
       "and the refusal lists the inputs the node really has");

msg = throws(() => Comfy.injectParams(h3Graph(), { prompt: "x" },
  { procedural: { prompt: { nodeId: 138, widget: 4 } } }),
  "settable input",
  "a widget index past the end refuses");
assert(msg.indexOf("prompt") !== -1, "listing the settable inputs it found");

// The positional fallback exists for hand-written manifests: widget 0 is the
// first LITERAL input, because links are sockets, not widgets.
g = h3Graph();
Comfy.injectParams(g, { prompt: "by position" },
                   { procedural: { prompt: { nodeId: 138, widget: 0 } } });
assert(g["138"].inputs.prompt === "by position",
       "widget 0 resolves past the node's linked inputs to the first widget");

// No manifest at all must behave exactly as before this feature existed.
g = h3Graph();
applied = Comfy.injectParams(g, { prompt: "x", seed: 3 });
assert(g["138"].inputs.prompt === "(neutral example)" &&
       g["114"] !== undefined && g["133"].inputs.noise_seed === 3,
       "with no manifest nothing procedural happens and the generic passes " +
       "are untouched");

// An empty prompt must not blank out the template's own text.
g = h3Graph();
Comfy.injectParams(g, { prompt: "" }, h3Manifest());
assert(g["138"].inputs.prompt === "(neutral example)",
       "an empty prompt leaves the template's text alone");

// ------------------------------------------------------------ the upload

let receivedHex = null;
const server = http.createServer((req, res) => {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.url !== "/upload/image" || req.method !== "POST") {
      res.writeHead(404); res.end("no"); return;
    }
    const ct = req.headers["content-type"] || "";
    const boundary = /boundary=(.+)$/.exec(ct);
    const text = body.toString("latin1");
    // Everything the real server needs in order to store the file.
    const okShape = boundary &&
      text.indexOf("--" + boundary[1]) === 0 &&
      /name="image"; filename="([^"]+)"/.test(text) &&
      text.indexOf('name="overwrite"') !== -1 &&
      text.indexOf("--" + boundary[1] + "--\r\n") !== -1;
    const named = /name="image"; filename="([^"]+)"/.exec(text);
    // The payload between the header break and the closing boundary is the
    // file, byte for byte.
    const start = text.indexOf("\r\n\r\n") + 4;
    const stop = text.indexOf("\r\n--" + boundary[1] + "\r\n", start);
    receivedHex = body.slice(start, stop).toString("hex");
    res.writeHead(okShape ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: named ? named[1] : null, subfolder: "",
                             type: "input" }));
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aell-inject-"));
const imgPath = path.join(tmp, "grab 0001.png");
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                           0x00, 0x0d, 0x2d, 0x2d, 0xff]);
fs.writeFileSync(imgPath, bytes);

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const base = { isHttps: false, host: "127.0.0.1", port: port,
                 label: "127.0.0.1:" + port };

  Comfy.uploadImage(base, imgPath, (err, name) => {
    assert(!err, "uploadImage posts a well-formed multipart body" +
                 (err ? " (" + err.message + ")" : ""));
    assert(name === "grab 0001.png",
           "and returns the filename LoadImage should name");
    // The file arrives byte for byte — these bytes contain a CRLF and a "--"
    // on purpose, the two things a hand-rolled multipart body gets wrong.
    assert(receivedHex === bytes.toString("hex"),
           "the image bytes survive the encoding intact");

    // A path that does not exist must fail before any socket is opened.
    Comfy.uploadImage(base, path.join(tmp, "nope.png"), (err2) => {
      assert(err2 && err2.message.indexOf("Cannot read image") === 0,
             "a missing file is a grounded local error, not a server round " +
             "trip");

      // A server refusal must surface its status AND its body — "upload
      // failed" alone leaves nobody anywhere to look.
      const rude = http.createServer((rq, rs) => {
        rq.resume();
        rq.on("end", () => { rs.writeHead(413); rs.end("payload too large"); });
      });
      rude.listen(0, "127.0.0.1", () => {
        const rbase = { isHttps: false, host: "127.0.0.1",
                        port: rude.address().port, label: "rude" };
        Comfy.uploadImage(rbase, imgPath, (err3) => {
          assert(err3 && err3.message.indexOf("HTTP 413") !== -1 &&
                 err3.message.indexOf("payload too large") !== -1,
                 "a server refusal carries its status and its body");
          rude.close();
          server.close();
          fs.rmSync(tmp, { recursive: true, force: true });
          process.exit(failures ? 1 : 0);
        });
      });
    });
  });
});
