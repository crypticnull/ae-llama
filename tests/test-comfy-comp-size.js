// Regression test: a render placed in a comp takes its size from the comp
// (NEXT UP 22, WORKPLAN §23c bullet 2).
//
// comfy_generate {comp} already PLACES the render (0.12.46), but it
// rendered at the template's authored size whatever the comp was, so a
// 1080x1920 comp got a square SDXL picture letterboxed into it. Now, with
// a comp named and no width/height, IMAGE templates take the comp's size
// (capped at the authored pixel count, which is what every VRAM gate was
// measured at) and VIDEO templates keep the authored pixel count at the
// comp's aspect. Both snap to the size node's declared step, read from
// the live backend's /object_info, never assumed.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

const REPO = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-size22-"));
const win = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => dir },
  Settings: { dataRoot: () => dir, get: () => ({}) },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout
};
new Function("window", fs.readFileSync(
  path.join(REPO, "extension", "js", "comfy.js"), "utf8"))(win);
const Comfy = win.Comfy;

// ------------------------------------------------ 1. the rule alone

const S8 = { w: 8, h: 8 }, S32 = { w: 32, h: 32 };
function size(o) { const r = Comfy.sizeForComp(o); return r.width + "x" + r.height; }

assert(size({ kind: "image", authoredW: 1024, authoredH: 1024, compW: 1920,
              compH: 1080, factor: 1, step: S8 }) === "1368x768",
       "sdxl in a 1080p comp: the comp's aspect at the authored pixel count");
assert(size({ kind: "image", authoredW: 512, authoredH: 512, compW: 640,
              compH: 360, factor: 1, step: S8 }) === "640x360",
       "a comp smaller than the authored size gets exactly its size");
assert(size({ kind: "image", authoredW: 1920, authoredH: 1080, compW: 1920,
              compH: 1080, factor: 1.6, step: S8 }) === "1200x672",
       "a template that enlarges 1.6x generates small enough that its FILE " +
       "lands at the comp's size");
assert(size({ kind: "video", authoredW: 1280, authoredH: 704, compW: 1080,
              compH: 1920, factor: 1, step: S32 }) === "704x1280",
       "wan in a vertical comp: authored pixel count, turned to the comp");
assert(size({ kind: "video", authoredW: 768, authoredH: 512, compW: 640,
              compH: 360, factor: 1, step: S32 }) === "832x480",
       "video never shrinks to a small comp: the measured seconds hold");
assert(size({ kind: "image", authoredW: 1024, authoredH: 1024, compW: 16,
              compH: 4000, factor: 1, step: S8,
              min: { w: 16, h: 16 }, max: { w: 1024, h: 1024 } }) ===
       "16x1024",
       "the node's declared min/max bound a freak aspect");

// ------------------------------------------ 2. generate() against a backend

const STEPS = { EmptyLatentImage: 8, Wan22ImageToVideoLatent: 32 };
let queued = null;
const server = http.createServer((req, res) => {
  const m = /^\/object_info\/(.+)$/.exec(req.url);
  if (m) {
    const cls = decodeURIComponent(m[1]);
    const out = {};
    if (STEPS[cls]) {
      const spec = ["INT", { default: 512, min: 16, max: 16384,
                             step: STEPS[cls] }];
      out[cls] = { input: { required: { width: spec, height: spec } } };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }
  if (req.url === "/prompt") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      queued = JSON.parse(body).prompt;
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub stops here" } }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

function template(name, cls, w, h, kind) {
  const file = path.join(dir, name + ".json");
  fs.writeFileSync(file, JSON.stringify({
    "1": { class_type: "CLIPTextEncode", inputs: { text: "x", clip: ["9", 0] } },
    "2": { class_type: cls, inputs: { width: w, height: h, batch_size: 1 } },
    "3": { class_type: "SaveImage", inputs: { images: ["2", 0],
                                              filename_prefix: "t" } }
  }));
  return { file, manifest: { kind, models: [] } };
}
const SDXL = template("SDXL", "EmptyLatentImage", 1024, 1024, "image");
const WAN = template("WAN", "Wan22ImageToVideoLatent", 1280, 704, "video");
const ODD = template("ODD", "SomePackLatent", 1024, 1024, "image");

const MAIN = { name: "Main", width: 1920, height: 1080 };
const TALL = { name: "Tall", width: 1080, height: 1920 };

function gen(t, params, cb) {
  queued = null;
  Comfy.generate({ comfyUrl: url, workflowFile: t.file, outDir: dir,
                   timeoutSec: 5, manifest: t.manifest,
                   params: Object.assign({ prompt: "a boat" }, params) },
    null, function (err) {
      const n = queued && queued["2"].inputs;
      cb(n ? n.width + "x" + n.height : null, err);
    });
}

let url;
const cases = [
  (done) => gen(SDXL, { compSize: MAIN }, (got) => {
    assert(got === "1368x768", "image template sized from the comp: " + got);
    done();
  }),
  (done) => gen(WAN, { compSize: TALL }, (got) => {
    assert(got === "704x1280", "video template turned to the comp: " + got);
    done();
  }),
  (done) => gen(SDXL, { compSize: MAIN, width: 512, height: 512 }, (got) => {
    assert(got === "512x512", "a named width/height wins over the comp: " + got);
    done();
  }),
  (done) => gen(SDXL, {}, (got) => {
    assert(got === "1024x1024", "no comp: the authored size: " + got);
    done();
  }),
  (done) => gen(ODD, { compSize: MAIN }, (got, err) => {
    assert(got === "1024x1024" && /stub stops here/.test(String(err)),
           "no declared step: the authored size is kept, never guessed: " + got);
    done();
  })
];

server.listen(0, "127.0.0.1", () => {
  url = "http://127.0.0.1:" + server.address().port;
  (function next(i) {
    if (i >= cases.length) {
      server.close();
      console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
      return;
    }
    cases[i](() => next(i + 1));
  })(0);
});
