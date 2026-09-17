// Regression test: comfy_generate places the render in a named comp
// (NEXT UP 22, WORKPLAN §23c).
//
// Until this change the tool imported through import_file, which puts a
// file "into the PROJECT PANEL only", so "make me a picture of X and put
// it in Main" stopped one hop short and the model had to know to follow
// up with import_as_layer. chat-probe step 14 reported that as a GAP every
// night. With `comp` named the panel now imports through import_as_layer
// (reuse + reload, fitted), and hands the result back in import_file's
// shape so outputSize and the probe's cleanup (which deletes by item id)
// keep working. A comp the host refuses still imports the file: minutes
// of rendering are never lost to a mistyped comp name.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

const REPO = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-place22-"));
fs.writeFileSync(path.join(dir, "AE_LLAMA_SDXL_T2I_V1.json"), JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple",
         inputs: { ckpt_name: "real-image.safetensors" } }
}));
fs.writeFileSync(path.join(dir, "AE_LLAMA_SDXL_T2I_V1.manifest.json"),
  JSON.stringify({ kind: "image", catalogEntry: "sdxl", models: [] }));

const comfyWindow = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => dir },
  Settings: { dataRoot: () => dir, get: () => ({}) },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout
};
new Function("window", fs.readFileSync(
  path.join(REPO, "extension", "js", "comfy.js"), "utf8"))(comfyWindow);

// The host, answering in the shapes hostscript.jsx really returns.
const FILE = "C:/out/AELL/apple_00001_.png";
const COMPS = ["Main", "Probe Room"];
let hostLog = [];
let lastParams = null;
const window = {
  AEBridge: {
    nodeRequire: require,
    evalScript: (script, cb) => {
      // callHostTool sends AELL_call("<tool>", <JSON string literal>).
      const m = /^AELL_call\("([a-z_]+)", ([\s\S]*)\)$/.exec(script);
      if (!m) {
        cb(JSON.stringify({ ok: false, error: "unexpected script" }));
        return;
      }
      const tool = m[1];
      const args = JSON.parse(JSON.parse(m[2]));
      hostLog.push({ tool, args });
      if (tool === "get_project_info") {
        cb(JSON.stringify({ ok: true, data: { activeComp: null, items: [
          { name: "Main", id: 1, type: "comp", width: 1920, height: 1080 },
          { name: "Probe Room", id: 2, type: "comp", width: 1080,
            height: 1920 },
          { name: "apple_00001_.png", id: 41, type: "footage" }] } }));
      } else if (tool === "import_file") {
        cb(JSON.stringify({ ok: true, data: { name: "apple_00001_.png",
          id: 41, width: 1024, height: 1024 } }));
      } else if (tool === "import_as_layer") {
        if (COMPS.indexOf(args.comp) === -1) {
          cb(JSON.stringify({ ok: false, error: "Comp not found: \"" +
            args.comp + "\". Comps in this project: " + COMPS.join(", ") }));
          return;
        }
        cb(JSON.stringify({ ok: true, data: { comp: args.comp,
          layer: "apple_00001_.png", index: 1, source: "apple_00001_.png",
          itemId: 42, sourceSize: "1024x1024", compSize: "1920x1080",
          fit: "fit", inPoint: 0, outPoint: 10,
          scale: [105.469, 105.469] } }));
      } else {
        cb(JSON.stringify({ ok: false, error: "unexpected host call " +
          tool }));
      }
    }
  },
  console, setTimeout, clearTimeout,
  Settings: { get: () => ({ comfyWorkflowsDir: dir, comfyUrl: "u",
                            comfyOutDir: dir, comfyTimeoutSec: 60,
                            comfyPauseLlm: "never", comfyEnhance: {},
                            comfyWorkflows: {}, vramOverrideGB: 0 }) },
  Llama: { getState: () => "stopped", chat: () => {} },
  Setup: { queryVramUsedMB: (cb) => cb(new Error("no smi")) },
  Comfy: {
    listWorkflows: comfyWindow.Comfy.listWorkflows,
    describeWorkflows: comfyWindow.Comfy.describeWorkflows,
    resolveWorkflow: comfyWindow.Comfy.resolveWorkflow,
    readManifest: comfyWindow.Comfy.readManifest,
    backendUrl: (s) => (s && s.comfyUrl) || "http://127.0.0.1:8288",
    ensureRunning: (url, st, cb) => cb(null),
    freeVram: (url, cb) => cb(null),
    generate: (opts, prog, cb) => {
      lastParams = opts.params;
      cb(null, { files: [FILE], applied: ["prompt -> node 1"] });
    }
  }
};
window.window = window;
for (const f of ["tiers.js", "tools.js"]) {
  new Function("window", fs.readFileSync(
    path.join(REPO, "extension", "js", f), "utf8"))(window);
}
const Tools = window.Tools;
Tools.setGpuInfo({ hasNvidia: true, vramGB: 32, computeCap: 8.9 });

const APPLE = { prompt: "a single red apple on a white plate",
                workflow: "AE_LLAMA_SDXL_T2I_V1" };

// Placement calls only; the size lookup (get_project_info) is its own step.
function run(args, cb) {
  hostLog = [];
  lastParams = null;
  Tools.executeCommands([{ tool: "comfy_generate", args }], {}, null,
    function (results) {
      cb(results[0], hostLog.filter(c => c.tool !== "get_project_info"),
         hostLog.slice());
    });
}

const pending = [];
function step(fn) { pending.push(fn); }
function next(i) {
  if (i >= pending.length) {
    console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
    return;
  }
  pending[i](function () { next(i + 1); });
}

// ------------------------------------------------- 1. the host and doc

{
  const host = fs.readFileSync(
    path.join(REPO, "extension", "jsx", "hostscript.jsx"), "utf8");
  const from = host.indexOf("AELL_TOOLS.import_as_layer = ");
  const body = host.slice(from, host.indexOf("\nAELL_TOOLS.", from + 1));
  assert(/itemId: item\.id/.test(body),
         "import_as_layer reports the item id the stub above answers with");
  assert(/sourceSize: hasPixels \? \(srcW \+ "x" \+ srcH\)/.test(body),
         "and sourceSize in the WxH form placedItem parses");
  for (const compact of [false, true]) {
    const doc = Tools.buildSystemPrompt("", { compact });
    assert(/comp\?: string \(also place it as a layer there\)\}/.test(doc),
           "the comfy_generate doc advertises comp (compact " + compact + ")");
  }
}

// ------------------------------------------------- 2. the tool

step(function (done) {
  run(APPLE, function (r, calls) {
    const tools = calls.map(c => c.tool);
    assert(r.ok && tools.join() === "import_file",
           "no comp: project panel only, as before (" + tools.join() + ")");
    assert(r.ok && r.data.imported[0].id === 41 &&
           r.data.outputSize === "1024x1024",
           "and the result is unchanged: " + JSON.stringify(r.data));
    done();
  });
});

step(function (done) {
  run(Object.assign({ comp: "Probe Room" }, APPLE), function (r, calls) {
    const tools = calls.map(c => c.tool);
    assert(r.ok && tools.join() === "import_as_layer" &&
           calls[0].args.comp === "Probe Room" && calls[0].args.path === FILE,
           "comp named: imported AND placed in one call (" +
           JSON.stringify(calls) + ")");
    const it = r.ok ? r.data.imported[0] : {};
    assert(it.id === 42 && it.name === "apple_00001_.png" &&
           it.comp === "Probe Room" && it.layer === "apple_00001_.png",
           "the item reads like import_file's plus where it landed: " +
           JSON.stringify(it));
    assert(r.ok && r.data.outputSize === "1024x1024",
           "outputSize still comes from the measured source: " +
           (r.ok && r.data.outputSize));
    done();
  });
});

step(function (done) {
  run(Object.assign({ comp: 7 }, APPLE), function (r, calls) {
    // A digit-only name the model sent as a JSON number, like every
    // other comp? arg (AELL_resolveComp stringifies it too).
    assert(calls[0] && calls[0].tool === "import_as_layer" &&
           calls[0].args.comp === "7", "a numeric comp name is a string");
    done();
  });
});

step(function (done) {
  run(Object.assign({ comp: "Mian" }, APPLE), function (r, calls) {
    const tools = calls.map(c => c.tool);
    assert(r.ok && tools.join() === "import_as_layer,import_file",
           "a comp the host refuses still imports the render (" +
           tools.join() + ")");
    const it = r.ok ? r.data.imported[0] : {};
    assert(it.id === 41 && /Comp not found: "Mian"[\s\S]*Main, Probe Room/
             .test(String(it.notPlaced)),
           "and the grounded refusal rides along: " + JSON.stringify(it));
    done();
  });
});

step(function (done) {
  run(Object.assign({ comp: "Main", "import": false }, APPLE),
    function (r, calls) {
      assert(r.ok && calls.length === 0 && r.data.files[0] === FILE,
             "import:false wins over comp: nothing touches the project");
      done();
    });
});

// --------------------------------------- 3. the comp sets the size (§23c)

step(function (done) {
  run(Object.assign({ comp: "Probe Room" }, APPLE), function (r, calls, all) {
    const cs = lastParams && lastParams.compSize;
    assert(cs && cs.name === "Probe Room" && cs.width === 1080 &&
           cs.height === 1920 && all[0].tool === "get_project_info" &&
           all[0].args.limit === 0,
           "a named comp hands its size to generate: " + JSON.stringify(cs));
    done();
  });
});

step(function (done) {
  run(Object.assign({ comp: "Main", width: 512, height: 512 }, APPLE),
    function (r, calls, all) {
      assert(lastParams && lastParams.compSize === null &&
             lastParams.width === 512 &&
             !all.some(c => c.tool === "get_project_info"),
             "a named width/height wins: no comp lookup, no compSize");
      done();
    });
});

step(function (done) {
  run(Object.assign({ comp: "Mian" }, APPLE), function (r) {
    assert(lastParams && lastParams.compSize === null,
           "a comp that does not exist sizes nothing");
    done();
  });
});

step(function (done) {
  run(APPLE, function (r, calls, all) {
    assert(lastParams && lastParams.compSize === null && all.length === 1,
           "no comp: no lookup (" + all.map(c => c.tool).join() + ")");
    done();
  });
});

step(function (done) {
  run(Object.assign({ comp: "" }, APPLE), function (r, calls) {
    assert(calls.map(c => c.tool).join() === "import_file",
           "an empty comp is no comp");
    done();
  });
});

next(0);
