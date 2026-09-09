// Regression test: the panel prices a generation off the DISK and ComfyUI
// decides what it can load off ITS OWN search path — and on a machine where
// those two trees differ, the panel used to stop the chat model to make room
// for weights the backend was never going to open.
//
// Measured in the field 2026-08-30 on this machine: all four MiniMax H3
// weights sit exactly where `comfyModelRoots` looks (the ComfyUI Desktop
// shared store), the running ComfyUI was launched
// `--base-directory Documents\ComfyUI` with no extra_model_paths.yaml
// anywhere, and it lists NONE of them. So the arbiter priced the job at
// 40 503 MiB, handed the whole card over, warmed ComfyUI up — and only then
// heard `Value not in list — vae_name: 'minimax_h3_video_vae_fp16...'`. The
// user paid a full handoff for a job that was never runnable.
//
// The two questions are genuinely different and BOTH sources are needed: the
// disk knows how big a weight is (/object_info carries no sizes, and size is
// what the arbiter's arithmetic runs on), the backend knows whether it can
// open it (the disk cannot know the search path). So this pins both halves:
//
//   1. Comfy.missingWeights reads the backend's own combo lists, and is
//      SILENT about everything it cannot answer — an unknown class, a
//      non-combo input, a linked input, a value that is not a weight file,
//      an unreachable server. A check that guesses is worse than no check.
//   2. tools.js refuses BEFORE the arbiter acts, naming every file AND
//      where it sits on disk, which is the sentence that tells a user
//      their backend is pointed at the wrong root.
//
// A THIRD half, added 2026-09-09 (WORKPLAN 17g). Checking weights alone
// reported "ready" about a graph ComfyUI refuses: the shipped KREA2 template
// named sampler `res_2s`, a value the RES4LYF pack ADDS to a core node's
// enum, and the backend a buyer gets dropped every output branch of it at
// validation while this very check printed PASS. So Comfy.validateGraphInputs
// asks both questions in one walk of /object_info — the weight slots and the
// build-constant enum VALUES — and the same invariant governs both: it may
// only ever report what ComfyUI would itself reject. An enum whose options
// come from this DISK (ckpt_name, LoadImage.image) is never judged, because
// those are one machine's contents and half of them the panel overwrites at
// generate time.
//
// The combo lists below are the REAL ones this machine's ComfyUI 0.32.0
// answered on 2026-08-30, trimmed but not invented — including the two
// entries that make the rules necessary: `pixel_space`, a NON-file value
// sitting in the same vae_name combo, and the int8 H3 VAE, which is present
// and is a different file from the fp16 one the template names.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}

const REPO = path.join(__dirname, "..");

// ------------------------------------------------- the field capture

const FIELD_LISTS = {
  VAELoader: {
    vae_name: [
      "!krea2_vae.safetensors",
      "LTX23_audio_vae_bf16.safetensors",
      "LTX23_video_vae_bf16.safetensors",
      "ace_1.5_vae.safetensors",
      "ae.safetensors",
      // The H3 VAE this backend DOES have is the int8 one. The template
      // names the fp16, and a near-miss is a miss.
      "minimax_h3_video_vae_int8_convrot.safetensors",
      "qwen_image_vae.safetensors",
      "wan_2.1_vae.safetensors",
      // A choice that is not a file at all, in the same combo.
      "pixel_space"
    ]
  },
  CLIPLoader: {
    clip_name: [
      "gemma_3_12B_it_fp8_scaled.safetensors",
      "qwen3vl_4b_fp8_scaled.safetensors",
      "umt5_xxl_fp16.safetensors"
    ],
    type: ["stable_diffusion", "wan", "qwen_image", "krea2", "minimax"]
  },
  // Node classes whose combos are BUILD-CONSTANT: the same list on every
  // install of the same build, which is what makes them checkable at all.
  // 44 samplers is the vendor build's real count, measured 2026-09-09 —
  // the author's ComfyUI offers 63 because RES4LYF adds 19, `res_2s`
  // among them.
  KSamplerSelect: {
    sampler_name: [
      "euler", "euler_cfg_pp", "euler_ancestral", "heun", "heunpp2", "dpm_2",
      "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_a",
      "dpmpp_sde", "dpmpp_2m", "dpmpp_3m_sde", "ddpm", "lcm", "ipndm",
      "deis", "res_multistep", "res_multistep_cfg_pp", "gradient_estimation",
      "er_sde", "seeds_2", "seeds_3", "exp_heun_2_x0", "exp_heun_2_x0_sde",
      "ddim", "uni_pc", "uni_pc_bh2"
    ]
  },
  BasicScheduler: {
    scheduler: ["simple", "sgm_uniform", "karras", "exponential", "ddim_uniform",
                "beta", "normal", "linear_quadratic", "kl_optimal"]
  },
  // The trap that makes the build-constant rule necessary: a combo of this
  // disk's images, whose authored value is the AUTHOR's file and which the
  // panel overwrites with the user's upload before it ever posts.
  LoadImage: {
    image: ["author_reference.png", "some_other.jpg"]
  },
  UNETLoader: {
    unet_name: [
      "Krea-2-Raw.safetensors",
      "flux2_dev_fp8mixed.safetensors",
      "krea2_turbo_int8_convrot.safetensors",
      "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
    ],
    weight_dtype: ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"]
  }
};

/* EXACTLY ComfyUI 0.32.0's /object_info/<class>: 200 either way, and the
 * body is an empty object for a class it has never heard of. `required`
 * carries [[choice, ...], {...}] per input. */
function fakeComfy(lists, cb) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const m = /^\/object_info\/(.+)$/.exec(req.url || "");
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    if (!m) { res.end("{}"); return; }
    const cls = decodeURIComponent(m[1]);
    hits[cls] = (hits[cls] || 0) + 1;
    const out = {};
    if (Object.prototype.hasOwnProperty.call(lists, cls)) {
      const required = {};
      for (const input in lists[cls]) {
        required[input] = [lists[cls][input], {}];
      }
      out[cls] = { input: { required: required }, output: [] };
    }
    res.end(JSON.stringify(out));
  });
  server.listen(0, "127.0.0.1", () => {
    cb(server, "http://127.0.0.1:" + server.address().port, hits);
  });
}

function run(steps, done) {
  let i = 0;
  (function next() {
    if (i >= steps.length) { done(); return; }
    steps[i++](next);
  })();
}

// ============================================================ layer 1
// Comfy.missingWeights, against the fake backend.

const comfyWindow = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
  Settings: { dataRoot: () => REPO },
  setTimeout, clearTimeout, setInterval, clearInterval
};
(function (window) {
  eval(fs.readFileSync(path.join(REPO, "extension", "js", "comfy.js"), "utf8"));
})(comfyWindow);
const Comfy = comfyWindow.Comfy;

const WF_DIR = path.join(REPO, "extension", "comfy-workflows");
const H3_FILE = path.join(WF_DIR, "AE_LLAMA_H3_I2V_V1.json");
// Moved out of the bundle by WORKPLAN 18 P8 (fixture README says why).
const K_FILE = path.join(REPO, "tests", "fixtures", "authored-krea2",
                         "AE_LLAMA_KREA2_V1.json");
const h3Graph = () => JSON.parse(fs.readFileSync(H3_FILE, "utf8"));
const kGraph = () => JSON.parse(fs.readFileSync(K_FILE, "utf8"));
const h3Manifest = JSON.parse(fs.readFileSync(
  path.join(WF_DIR, "AE_LLAMA_H3_I2V_V1.manifest.json"), "utf8"));

let layer1Done;
fakeComfy(FIELD_LISTS, (server, url, hits) => {
  run([
    // ---- the field case, replayed whole ------------------------------
    (next) => {
      Comfy.missingWeights(url, h3Graph(), (err, res) => {
        assert(!err && res && res.missing.length === 4,
               "THE FIELD CASE: the shipped H3 template names four weights " +
               "this backend cannot load (got " +
               (err ? err.message : res.missing.length) + ")");
        const names = res.missing.map((m) => m.value).sort();
        assert(names.join("|") === [
                 "minimax_h3_audio_vae_fp32.safetensors",
                 "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                 "minimax_h3_video_vae_fp16.safetensors",
                 "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
               ].join("|"),
               "…and it names exactly those four files: " + names.join(", "));
        const vae = res.missing.filter(
          (m) => m.value === "minimax_h3_video_vae_fp16.safetensors")[0];
        assert(vae && vae.classType === "VAELoader" &&
               vae.input === "vae_name" && String(vae.node).length > 0,
               "…each carrying the node, class and input ComfyUI would " +
               "have reported the error at (" +
               (vae ? vae.node + " " + vae.classType + "." + vae.input : "-") +
               ")");
        assert(vae && vae.choiceCount === FIELD_LISTS.VAELoader.vae_name.length,
               "…and how many choices the server did offer, so the refusal " +
               "can say the list was not empty");
        // The int8 VAE IS on this backend. A near-miss must still miss.
        assert(res.missing.some(
                 (m) => m.value === "minimax_h3_video_vae_fp16.safetensors"),
               "a DIFFERENT quantization of the same model on the server " +
               "does not satisfy the file the template names");
        next();
      });
    },
    // ---- the template whose weights this backend really has ----------
    (next) => {
      Comfy.missingWeights(url, kGraph(), (err, res) => {
        assert(!err && res && res.missing.length === 0 && res.checked === 3,
               "the KREA2 template's three weights ARE listed — checked " +
               (res ? res.checked : "?") + ", missing " +
               (res ? res.missing.length : "?") + " — so nothing is refused");
        next();
      });
    },
    // ---- one fetch per CLASS, not per node ---------------------------
    (next) => {
      // The H3 graph has TWO VAELoaders. The run above must have asked
      // about the class once.
      assert(hits.VAELoader === 2,
             "each class is fetched ONCE PER GRAPH however many nodes use " +
             "it (two VAELoader nodes in H3, two graphs run, " +
             hits.VAELoader + " requests)");
      next();
    },
    // ---- everything it must be SILENT about --------------------------
    (next) => {
      const g = {
        "1": { class_type: "NeverHeardOfIt",
               inputs: { ckpt_name: "nope.safetensors" } }
      };
      Comfy.missingWeights(url, g, (err, res) => {
        assert(!err && res.missing.length === 0 && res.checked === 0,
               "a class the server does not know is passed over in " +
               "SILENCE — nothing can be asked about its inputs");
        next();
      });
    },
    (next) => {
      const g = {
        "1": { class_type: "UNETLoader",
               inputs: { unet_name: "krea2_turbo_int8_convrot.safetensors",
                         // not a combo this class declares at all
                         mystery_name: "whatever.safetensors" } }
      };
      Comfy.missingWeights(url, g, (err, res) => {
        assert(!err && res.missing.length === 0 && res.checked === 1,
               "an input the class does not declare is not an error — only " +
               "the one real combo is checked (checked " + res.checked + ")");
        next();
      });
    },
    (next) => {
      const g = {
        "1": { class_type: "UNETLoader",
               inputs: { unet_name: "krea2_turbo_int8_convrot.safetensors",
                         // a MODE, wrong, in a combo of modes
                         weight_dtype: "fp4_invented" } }
      };
      Comfy.missingWeights(url, g, (err, res) => {
        assert(!err && res.missing.length === 0,
               "a non-weight combo value is not this check's business — " +
               "`weight_dtype` is a mode, and calling it a missing weight " +
               "would send a user hunting for a file that never existed");
        next();
      });
    },
    (next) => {
      const g = {
        "1": { class_type: "VAELoader", inputs: { vae_name: "pixel_space" } }
      };
      Comfy.missingWeights(url, g, (err, res) => {
        assert(!err && res.missing.length === 0 && res.checked === 0,
               "`pixel_space` — a real, non-file choice measured in the " +
               "field inside vae_name itself — is not treated as a weight");
        next();
      });
    },
    (next) => {
      const g = {
        "1": { class_type: "VAELoader", inputs: { vae_name: ["99", 0] } }
      };
      Comfy.missingWeights(url, g, (err, res) => {
        assert(!err && res.missing.length === 0 && res.checked === 0,
               "a LINKED input (an [id, slot] pair) is never mistaken for " +
               "a filename");
        next();
      });
    },
    (next) => {
      // Some builds answer ["COMBO", {options: [...]}] instead.
      const alt = http.createServer((req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ VAELoader: { input: { required: {
          vae_name: ["COMBO", { options: ["ae.safetensors"] }] } } } }));
      });
      alt.listen(0, "127.0.0.1", () => {
        const u = "http://127.0.0.1:" + alt.address().port;
        const g = { "1": { class_type: "VAELoader",
                           inputs: { vae_name: "gone.safetensors" } } };
        Comfy.missingWeights(u, g, (err, res) => {
          assert(!err && res.missing.length === 1,
                 "the ['COMBO', {options}] spec form is read too");
          alt.close();
          next();
        });
      });
    },
    // ---- 17g: the enum VALUES, which the weight check cannot see -----
    (next) => {
      // The regression itself, replayed: node 278 back on the RES4LYF
      // sampler, against a backend that has the vendor build's 29.
      const g = {
        "278": { class_type: "KSamplerSelect",
                 inputs: { sampler_name: "res_2s" } }
      };
      Comfy.validateGraphInputs(url, g, null, (err, res) => {
        assert(!err && res.badValues.length === 1 && res.valuesChecked === 1,
               "THE 17g CASE: a sampler only a custom pack provides is " +
               "reported, where the weight check saw nothing (bad " +
               (res ? res.badValues.length : "?") + ", checked " +
               (res ? res.valuesChecked : "?") + ")");
        const b = res.badValues[0];
        assert(b && b.node === "278" && b.classType === "KSamplerSelect" &&
               b.input === "sampler_name" && b.value === "res_2s",
               "…carrying the node, class and input ComfyUI names in its " +
               "own validation error");
        assert(b && b.choices instanceof Array &&
               b.choices.indexOf("euler") !== -1,
               "…and WHAT THE BACKEND DOES OFFER, which is the only thing " +
               "that turns the refusal into a fix");
        next();
      });
    },
    (next) => {
      const g = {
        "278": { class_type: "KSamplerSelect",
                 inputs: { sampler_name: "exp_heun_2_x0" } }
      };
      Comfy.validateGraphInputs(url, g, null, (err, res) => {
        assert(!err && res.badValues.length === 0 && res.valuesChecked === 1,
               "the value the template ships TODAY is one this backend " +
               "has, so nothing is refused — the check was really run " +
               "(checked " + (res ? res.valuesChecked : "?") + ")");
        next();
      });
    },
    (next) => {
      // The false-refusal trap. This combo is a picture of one disk, and
      // the authored value is the AUTHOR's file — the panel uploads over
      // it before posting. Judging it would fail every machine but one.
      const g = {
        "1": { class_type: "LoadImage",
               inputs: { image: "not_on_this_machine.png" } }
      };
      Comfy.validateGraphInputs(url, g, null, (err, res) => {
        assert(!err && res.badValues.length === 0 && res.valuesChecked === 0,
               "a combo whose options come from this DISK is never judged " +
               "as an enum — LoadImage.image is the author's own PNG until " +
               "the panel overwrites it");
        next();
      });
    },
    (next) => {
      const g = {
        "1": { class_type: "VAELoader",
               inputs: { vae_name: "gone.safetensors" } },
        "2": { class_type: "KSamplerSelect",
               inputs: { sampler_name: "res_2s" } }
      };
      Comfy.validateGraphInputs(url, g, { skipNodes: ["2"] }, (err, res) => {
        assert(!err && res.badValues.length === 0 && res.missing.length === 1,
               "a node the CALLER says will not reach the server as " +
               "written (an unconditional optionalNodes drop) is not " +
               "judged, while the rest of the graph still is");
        next();
      });
    },
    (next) => {
      const g = {
        "1": { class_type: "KSamplerSelect",
               inputs: { sampler_name: "res_2s" } }
      };
      Comfy.missingWeights(url, g, (err, res) => {
        assert(!err && res.missing.length === 0 &&
               res.badValues === undefined,
               "missingWeights still answers ONLY about weights — the " +
               "arbiter asks whether files can be opened, not whether the " +
               "graph is runnable, and its contract did not move");
        next();
      });
    },
    (next) => {
      Comfy.validateGraphInputs("http://127.0.0.1:1", h3Graph(), null,
                                (err, res) => {
        assert(!!err && !res,
               "an unreachable backend is an ERROR for the enum half too");
        next();
      });
    },
    (next) => {
      Comfy.missingWeights("http://127.0.0.1:1", h3Graph(), (err, res) => {
        assert(!!err && !res,
               "an UNREACHABLE backend is an ERROR, never an empty answer " +
               "— the caller must be able to tell 'nothing missing' from " +
               "'could not ask'");
        next();
      });
    }
  ], () => { server.close(); layer1Done(); });
});

// ============================================================ layer 2
// tools.js: the refusal, and WHEN it happens.

function layer2(done) {
  const CHAT_GGUF = "C:\\models\\chat.gguf";
  const SHARED = path.join("C:\\Users\\x\\AppData\\Local", "Comfy-Desktop",
                           "ComfyUI-Shared", "models");
  // The H3 weights, on disk exactly where the field found them: in the
  // Desktop shared store, which is a root the panel reaches and this
  // backend does not.
  let DISK = {
    [path.join(SHARED, "diffusion_models",
               "minimax_h3_fl2va_pruned_int8_convrot.safetensors")]: 20000,
    [path.join(SHARED, "text_encoders",
               "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")]: 19000,
    [path.join(SHARED, "vae",
               "minimax_h3_video_vae_fp16.safetensors")]: 800,
    [path.join(SHARED, "vae",
               "minimax_h3_audio_vae_fp32.safetensors")]: 700
  };
  const fakeFs = {
    statSync: (p) => {
      if (p === CHAT_GGUF) return { size: 4700 * 1048576 };
      if (Object.prototype.hasOwnProperty.call(DISK, p)) {
        return { size: DISK[p] * 1048576 };
      }
      throw new Error("ENOENT: " + p);
    },
    existsSync: (p) => p === CHAT_GGUF ||
      Object.prototype.hasOwnProperty.call(DISK, p),
    readFileSync: fs.readFileSync
  };

  const trace = [];
  let settings = null;
  const window = {
    AEBridge: { nodeRequire: (m) => (m === "fs" ? fakeFs : require(m)) },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout, setInterval, clearInterval,
    Settings: { get: () => settings },
    Llama: {
      getState: () => "running",
      getCurrentModel: () => CHAT_GGUF,
      stop: () => { trace.push("llama.stop"); },
      start: (o, cb) => { trace.push("llama.start"); cb(null); },
      chat: (o, m, s, d, cb) => cb(new Error("no enhancer in this test"))
    },
    Setup: { queryVramUsedMB: (cb) => cb(null, 21000) },
    Comfy: {
      listWorkflows: () => [{ name: "AE_LLAMA_H3_I2V_V1", file: H3_FILE }],
      readManifest: () => h3Manifest,
      loadWorkflow: (f) => JSON.parse(fs.readFileSync(f, "utf8")),
      validateGraphInputs: null,     // set per scenario
      // The panel asks comfy.js WHICH backend it is talking to (managed
      // vs the user's own) rather than reading comfyUrl — keep the stub
      // faithful to that, or every call site throws.
      backendUrl: (s) => (s && s.comfyUrl) || "http://127.0.0.1:8288",
      ensureRunning: (u, st, cb) => { trace.push("comfy.ensure"); cb(null); },
      generate: (o, p, cb) => {
        trace.push("comfy.generate");
        cb(null, { files: [], applied: [] });
      },
      freeVram: (u, cb) => { trace.push("comfy.free"); cb(null); }
    }
  };
  window.window = window;
  (function (window) {
    eval(fs.readFileSync(path.join(REPO, "extension", "js", "tiers.js"), "utf8"));
    eval(fs.readFileSync(path.join(REPO, "extension", "js", "tools.js"), "utf8"));
  })(window);
  const Tools = window.Tools;

  settings = {
    serverPath: "s", modelPath: CHAT_GGUF, port: 1, ctxSize: 16384,
    gpuLayers: 99, comfyUrl: "http://127.0.0.1:8188",
    comfyWorkflowsDir: WF_DIR, comfyOutDir: "/out", comfyTimeoutSec: 60,
    comfyPauseLlm: "auto", comfyEnhance: {}, vramOverrideGB: 0,
    comfyDir: "", comfyModelsDir: "", comfyModelRoots: []
  };
  const env = require("process").env;
  const savedLocal = env.LOCALAPPDATA;
  env.LOCALAPPDATA = "C:\\Users\\x\\AppData\\Local";
  // A 24 GB card: the H3 bill (40.5 GB) cannot sit beside a 6.2 GB chat
  // model, so the arbiter's answer is a HANDOFF — the churn worth saving.
  Tools.setGpuInfo({ hasNvidia: true, vramGB: 24, computeCap: 12 });

  const FIELD_MISSING = [
    { node: "129", classType: "VAELoader", input: "vae_name",
      value: "minimax_h3_video_vae_fp16.safetensors", choiceCount: 11 },
    { node: "130", classType: "VAELoader", input: "vae_name",
      value: "minimax_h3_audio_vae_fp32.safetensors", choiceCount: 11 },
    { node: "137", classType: "CLIPLoader", input: "clip_name",
      value: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", choiceCount: 17 },
    { node: "148", classType: "UNETLoader", input: "unet_name",
      value: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      choiceCount: 26 }
  ];

  const BAD_SAMPLER = [
    { node: "278", classType: "KSamplerSelect", input: "sampler_name",
      value: "res_2s",
      choices: ["euler", "heun", "dpmpp_2m", "res_multistep",
                "exp_heun_2_x0", "ddim", "uni_pc"] }
  ];

  // ---- the sentence for a value the backend does not have -------------
  {
    const t = Tools._describeBadValues(BAD_SAMPLER, settings);
    assert(t.indexOf("res_2s") !== -1 &&
           /node 278 KSamplerSelect\.sampler_name/.test(t),
           "the enum refusal names the value AND the node ComfyUI would " +
           "have failed at");
    assert(t.indexOf("exp_heun_2_x0") !== -1 && t.indexOf("euler") !== -1,
           "…and lists what the backend DOES offer — a failed lookup that " +
           "does not say what exists cannot be acted on");
    assert(/panelAdaptation\.setInputs/.test(t) &&
           /adapt-workflow\.js/.test(t),
           "…and names the seam that FIXES it, not the generated API file " +
           "that the next regeneration overwrites");
    const many = [];
    for (let i = 0; i < 30; i++) many.push("s" + i);
    const t2 = Tools._describeBadValues(
      [{ node: "1", classType: "KSamplerSelect", input: "sampler_name",
         value: "res_2s", choices: many }], settings);
    assert(/it has 30, including/.test(t2) && t2.indexOf("s29") === -1,
           "a long option list is capped with a COUNT — ComfyUI's own " +
           "validate_inputs stops listing above 20 and this matches it, so " +
           "a user who sees both messages sees the same shape twice");
  }

  // ---- the disagreement, as an arithmetic fact ------------------------
  const priced = Tools._genNeedMBFor(h3Manifest, settings);
  assert(priced === 40500,
         "the panel PRICES the H3 template off the shared store the " +
         "backend cannot see — 40500 MiB (got " + priced + "), which is " +
         "the whole disagreement: it is not a missing DOWNLOAD");
  assert(Tools._vramArbiter.planFor(settings, h3Manifest).decision.mode ===
           "handoff",
         "…and on a 24 GB card that priced job means the chat model gets " +
         "STOPPED — so a refusal that arrives late costs a real handoff");

  // ---- the sentence ---------------------------------------------------
  const text = Tools._describeMissingWeights(FIELD_MISSING, h3Manifest,
                                             settings);
  assert(FIELD_MISSING.every((m) => text.indexOf(m.value) !== -1),
         "the refusal names every file the backend rejected");
  assert(text.indexOf(path.join(SHARED, "vae",
           "minimax_h3_video_vae_fp16.safetensors")) !== -1,
         "…and where each one actually SITS ON DISK — the sentence that " +
         "tells a user their backend is pointed at the wrong root");
  assert(/node 129 VAELoader\.vae_name/.test(text),
         "…and the node and input ComfyUI would have failed at");
  assert(/searching a different models tree/.test(text) &&
         /extra_model_paths\.yaml/.test(text),
         "…and, when every file IS on the machine, says so and names the " +
         "config file that fixes it rather than telling the user to " +
         "download what they already have");
  {
    const gone = Object.assign({}, DISK);
    DISK = {};
    const t2 = Tools._describeMissingWeights(FIELD_MISSING, h3Manifest,
                                             settings);
    assert(/not on this disk either/.test(t2) && /Download them/.test(t2),
           "a weight that is on NEITHER the backend nor the disk gets the " +
           "opposite advice — download it");
    assert(!/searching a different models tree/.test(t2),
           "…and is never told their search path is wrong when the file " +
           "is simply not there");
    DISK = gone;
  }
  {
    const many = [];
    for (let i = 0; i < 9; i++) {
      many.push({ node: String(i), classType: "VAELoader", input: "vae_name",
                  value: "w" + i + ".safetensors", choiceCount: 3 });
    }
    const t3 = Tools._describeMissingWeights(many, h3Manifest, settings);
    assert(/cannot load 9 of this workflow's weights/.test(t3) &&
           /and 3 more/.test(t3),
           "a long list is capped with a COUNT, never silently truncated");
  }

  // ---- WHEN it happens: the bug class ---------------------------------
  function generate(cb) {
    trace.length = 0;
    Tools.executeCommands([{ tool: "comfy_generate", args: {
      workflow: "AE_LLAMA_H3_I2V_V1", prompt: "p", "import": false
    } }], {}, null, (rs) => cb(rs[0]));
  }

  run([
    (next) => {
      window.Comfy.validateGraphInputs = (u, g, o, cb) =>
        cb(null, { missing: FIELD_MISSING, badValues: [], checked: 4,
                   valuesChecked: 9 });
      generate((r) => {
        assert(r.ok === false && /cannot load 4 of this workflow/.test(r.error),
               "THE BUG CLASS: comfy_generate refuses a job whose weights " +
               "the backend cannot load (got: " +
               (r.ok ? "ok" : String(r.error).slice(0, 60)) + ")");
        assert(trace.indexOf("llama.stop") === -1,
               "…BEFORE the chat model is stopped — the handoff the user " +
               "used to pay for is saved (trace: " + trace.join(", ") + ")");
        assert(trace.indexOf("comfy.generate") === -1,
               "…and the graph is never queued");
        assert(trace.indexOf("comfy.ensure") !== -1,
               "…having really booted the backend, because /object_info " +
               "is the ground truth and a dead backend has no answer");
        next();
      });
    },
    (next) => {
      // The other half of the invariant, and the one that decides whether
      // this check is safe to ship: it may NEVER refuse a job that would
      // have run.
      window.Comfy.validateGraphInputs = (u, g, o, cb) =>
        cb(null, { missing: [], badValues: [], checked: 4,
                   valuesChecked: 9 });
      generate((r) => {
        assert(r.ok === true && trace.indexOf("comfy.generate") !== -1,
               "a backend that lists every weight generates as before");
        assert(trace.indexOf("llama.stop") !== -1,
               "…and still pays the handoff it really needs");
        next();
      });
    },
    (next) => {
      window.Comfy.validateGraphInputs = (u, g, o, cb) =>
        cb(new Error("ComfyUI unreachable at 127.0.0.1:8188"));
      generate((r) => {
        assert(r.ok === true && trace.indexOf("comfy.generate") !== -1,
               "a backend that cannot be ASKED refuses nothing — an " +
               "unanswerable check never becomes a failure");
        next();
      });
    },
    (next) => {
      // A panel build (or a stale install) with no such function at all.
      window.Comfy.validateGraphInputs = null;
      generate((r) => {
        assert(r.ok === true,
               "and neither does a Comfy module that has no weight check");
        next();
      });
    },
    // ---- 17g on the REAL path: an enum value refuses the same way ------
    (next) => {
      window.Comfy.validateGraphInputs = (u, g, o, cb) =>
        cb(null, { missing: [], badValues: BAD_SAMPLER, checked: 4,
                   valuesChecked: 9 });
      generate((r) => {
        assert(r.ok === false && /does not offer 1 of the value/.test(r.error),
               "THE 17g BUG CLASS: a template whose weights all load is " +
               "STILL refused when the backend does not have a value it " +
               "names (got: " +
               (r.ok ? "ok — the graph ComfyUI refuses was queued"
                     : String(r.error).slice(0, 60)) + ")");
        assert(trace.indexOf("llama.stop") === -1 &&
               trace.indexOf("comfy.generate") === -1,
               "…before the handoff and without queueing anything, exactly " +
               "as the weight refusal does (trace: " +
               (trace.join(", ") || "empty") + ")");
        next();
      });
    },
    (next) => {
      // The preflight reads the template off disk; the panel posts a graph
      // resolveOptionalNodes has already edited. A node it drops or
      // re-classes UNCONDITIONALLY must not be judged, or a correct
      // template is refused on every machine.
      let sawSkip = null;
      window.Comfy.validateGraphInputs = (u, g, o, cb) => {
        sawSkip = o && o.skipNodes;
        cb(null, { missing: [], badValues: [], checked: 4, valuesChecked: 9 });
      };
      generate(() => {
        assert(sawSkip instanceof Array,
               "the preflight tells the check which nodes the manifest " +
               "will rewrite before the POST (got " + JSON.stringify(sawSkip) +
               ")");
        assert(sawSkip && sawSkip.length === 0,
               "…and every H3 optionalNodes entry is gated on " +
               "when:'missing', which needs no listing: a missing class " +
               "has no /object_info definition and the check is already " +
               "silent there");
        next();
      });
    },
    (next) => {
      // The ordering the FIRST version of this fix got wrong: a refusal
      // the arithmetic alone can reach must not boot a backend to say so.
      window.Comfy.validateGraphInputs = (u, g, o, cb) =>
        cb(null, { missing: FIELD_MISSING, badValues: [], checked: 4,
                   valuesChecked: 9 });
      settings.comfyPauseLlm = "never";
      generate((r) => {
        assert(r.ok === false && /never/.test(r.error),
               "pause 'never' on a job that cannot fit still refuses on " +
               "the arithmetic alone (got: " +
               String(r.error).slice(0, 60) + ")");
        assert(trace.indexOf("comfy.ensure") === -1 &&
               trace.indexOf("llama.stop") === -1,
               "…without starting ANYTHING — planFor has no side effects " +
               "and a refusal that needs no backend must not boot one " +
               "(trace: " + (trace.join(", ") || "empty") + ")");
        settings.comfyPauseLlm = "auto";
        next();
      });
    }
  ], () => {
    env.LOCALAPPDATA = savedLocal;
    done();
  });
}

layer1Done = () => layer2(() => {
  console.log(failures ? "\nTESTS FAILED" : "\nall checks passed");
  process.exit(failures ? 1 : 0);
});
