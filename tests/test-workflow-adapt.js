// Regression test: the UI -> API workflow converter (scripts/adapt-workflow.js)
// and the adapted H3 i2v template it ships.
//
// The stub graph below is not invented: every shape in it was measured against
// ComfyUI 0.32.0 on the AE machine (2026-08-26, WORKPLAN item 2d part 1), and
// each one silently corrupts a template if handled wrong --
//
//   - widget values are stored POSITIONALLY with no names, so one extra or
//     missing position shifts every later widget on that node;
//   - control_after_generate ("randomize") is a frontend-only widget that
//     occupies a position and must be consumed;
//   - a V3 dynamic combo consumes its own position, then the SELECTED
//     option's inputs expand inline as "<id>.<sub>" keys;
//   - a V3 autogrow group ("values.a", "values.b") is sockets only and
//     consumes no positions at all;
//   - bypass (mode 4) is not "drop it": consumers rewire through it to the
//     same-typed input;
//   - dropping a node that FED a widget input hands the widget its own value
//     back, which is the entire reason the H3 template needed adapting.
"use strict";

const fs = require("fs");
const path = require("path");
const { adapt } = require("../scripts/adapt-workflow.js");

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else console.log("ok  -", msg);
}
function throws(fn, needle, msg) {
  let got = null;
  try { fn(); } catch (e) { got = e.message; }
  if (got === null) { console.error("FAIL:", msg, "(did not throw)"); failures++; }
  else if (got.indexOf(needle) === -1) {
    console.error("FAIL:", msg, "\n      wanted:", needle, "\n      got:", got);
    failures++;
  } else console.log("ok  -", msg);
}

// ---------------------------------------------------------------- stub defs

const STUB_DEFS = {
  defs: {
    // noise_seed carries the frontend's extra "randomize" widget.
    RandomNoise: {
      input_types: {
        required: {
          noise_seed: ["INT", { control_after_generate: true }],
          label: ["STRING", {}]
        }
      }
    },
    // A dynamic combo whose chosen option adds two more widgets inline.
    Resizer: {
      input_types: {
        required: {
          images: ["IMAGE", {}],
          resize_type: ["COMFY_DYNAMICCOMBO_V3", {
            options: [
              { key: "by multiplier", inputs: { required: { scale: ["FLOAT", {}] } } },
              { key: "target dimensions", inputs: { required: {
                  width: ["INT", {}], height: ["INT", {}] } } }
            ]
          }],
          quality: ["COMBO", { options: ["LOW", "ULTRA"] }]
        }
      }
    },
    // An autogrow group: members are sockets, never widgets.
    MathExpr: {
      input_types: {
        required: {
          expression: ["STRING", {}],
          values: ["COMFY_AUTOGROW_V3", {
            template: { input: { required: { value: ["FLOAT,INT,BOOLEAN", {}] } },
                        names: ["a", "b", "c"], min: 1 }
          }]
        }
      }
    },
    NumberSource: { input_types: { required: { value: ["FLOAT", {}] } } },
    TextSource: { input_types: { required: { value: ["STRING", {}] } } },
    // The consumer whose prompt widget is fed by a link, like H3 node 138.
    Consumer: {
      input_types: {
        required: { model: ["MODEL", {}], prompt: ["STRING", {}] },
        optional: { extra: ["IMAGE", {}] }
      }
    },
    PassThrough: { input_types: { required: { model: ["MODEL", {}] } } },
    ModelSource: { input_types: { required: { name: ["COMBO", { options: ["m"] }] } } },
    ImageSource: { input_types: { required: { name: ["COMBO", { options: ["i"] }] } } },
    Sink: { input_types: { required: { anything: ["*", {}] } } }
  }
};

function link(id, src, slot, dst, dstSlot, type) {
  return [id, src, slot, dst, dstSlot, type];
}

// --------------------------------------------------- 1. positional decoding

let g = {
  nodes: [
    { id: 1, type: "RandomNoise", mode: 0,
      widgets_values: [12345, "randomize", "tail"], inputs: [], outputs: [] }
  ],
  links: []
};
let r = adapt(g, STUB_DEFS, null);
assert(r.api["1"].inputs.noise_seed === 12345,
       "noise_seed reads the value at its own position");
assert(r.api["1"].inputs.label === "tail",
       "control_after_generate consumes a position, so the NEXT widget " +
       "still lands on its own value");
assert(!("randomize" in r.api["1"].inputs),
       "the frontend-only control widget never becomes an input");

// ------------------------------------------------------- 2. dynamic combos

g = {
  nodes: [
    { id: 15, type: "ImageSource", mode: 0, widgets_values: ["i"],
      inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [40] }] },
    { id: 2, type: "Resizer", mode: 0,
      widgets_values: ["target dimensions", 1920, 1080, "ULTRA"],
      inputs: [{ name: "images", type: "IMAGE", link: 40 }], outputs: [] }
  ],
  links: [link(40, 15, 0, 2, 0, "IMAGE")]
};
r = adapt(g, STUB_DEFS, null);
assert(r.api["2"].inputs.resize_type === "target dimensions",
       "dynamic combo keeps the selector value under its own name");
assert(r.api["2"].inputs["resize_type.width"] === 1920 &&
       r.api["2"].inputs["resize_type.height"] === 1080,
       "the selected option's inputs expand as dotted keys");
assert(r.api["2"].inputs.quality === "ULTRA",
       "the widget AFTER a dynamic combo is not shifted by the expansion");
assert(!("scale" in r.api["2"].inputs) &&
       !("resize_type.scale" in r.api["2"].inputs),
       "the option that was NOT selected contributes nothing");

g.nodes[1].widgets_values = ["by multiplier", 2.0, "ULTRA"];
r = adapt(g, STUB_DEFS, null);
assert(r.api["2"].inputs["resize_type.scale"] === 2.0 &&
       r.api["2"].inputs.quality === "ULTRA",
       "a different option expands a different (shorter) widget run");

g.nodes[1].widgets_values = ["nonsense", 1, 2, "ULTRA"];
throws(() => adapt(g, STUB_DEFS, null), "not one of [by multiplier",
       "an unknown dynamic-combo key is refused, listing the real options");

// ------------------------------------------------------------ 3. autogrow

g = {
  nodes: [
    { id: 3, type: "NumberSource", mode: 0, widgets_values: [15],
      inputs: [], outputs: [{ name: "FLOAT", type: "FLOAT", links: [10] }] },
    { id: 4, type: "MathExpr", mode: 0, widgets_values: ["a * 2"],
      inputs: [
        { name: "values.a", type: "FLOAT,INT,BOOLEAN", link: 10 },
        { name: "values.b", type: "FLOAT,INT,BOOLEAN", link: null }
      ],
      outputs: [] }
  ],
  links: [link(10, 3, 0, 4, 0, "FLOAT")]
};
r = adapt(g, STUB_DEFS, null);
assert(r.api["4"].inputs.expression === "a * 2",
       "an autogrow group consumes no widget positions");
assert(Array.isArray(r.api["4"].inputs["values.a"]) &&
       r.api["4"].inputs["values.a"][0] === "3",
       "a connected autogrow member becomes a link under its dotted name");
assert(!("values.b" in r.api["4"].inputs),
       "an unconnected autogrow member is left out entirely");

// -------------------------------------------------- 4. bypass and mute

function bypassGraph(mode) {
  return {
    nodes: [
      { id: 5, type: "ModelSource", mode: 0, widgets_values: ["m"],
        inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [20] }] },
      { id: 6, type: "PassThrough", mode: mode, widgets_values: [],
        inputs: [{ name: "model", type: "MODEL", link: 20 }],
        outputs: [{ name: "MODEL", type: "MODEL", links: [21] }] },
      { id: 7, type: "Consumer", mode: 0, widgets_values: ["p"],
        inputs: [{ name: "model", type: "MODEL", link: 21 },
                 { name: "prompt", type: "STRING",
                   widget: { name: "prompt" }, link: null }],
        outputs: [] }
    ],
    links: [link(20, 5, 0, 6, 0, "MODEL"), link(21, 6, 0, 7, 0, "MODEL")]
  };
}

r = adapt(bypassGraph(4), STUB_DEFS, null);
assert(!("6" in r.api), "a bypassed node is not emitted");
assert(r.api["7"].inputs.model[0] === "5",
       "a consumer is rewired THROUGH the bypassed node to its same-typed " +
       "input, not left dangling");
assert(r.rewired.join(" ").indexOf("rewired past bypass") !== -1,
       "the rewire is reported, not silent");

throws(() => adapt(bypassGraph(2), STUB_DEFS, null),
       "missing required input 'model'",
       "muting (mode 2) a node in the middle is refused, not passed through");

// ---------------------------------- 5. the H3 bug: dropped node -> widget

g = {
  nodes: [
    { id: 8, type: "TextSource", mode: 0, widgets_values: ["enhancer text"],
      inputs: [], outputs: [{ name: "STRING", type: "STRING", links: [30] }] },
    { id: 9, type: "ModelSource", mode: 0, widgets_values: ["m"],
      inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [31] }] },
    { id: 11, type: "Consumer", mode: 0,
      widgets_values: ["the value the panel injects"],
      inputs: [{ name: "model", type: "MODEL", link: 31 },
               { name: "prompt", type: "STRING",
                 widget: { name: "prompt" }, link: 30 }],
      outputs: [] },
    { id: 12, type: "MarkdownNote", mode: 0, widgets_values: ["notes"],
      inputs: [], outputs: [] }
  ],
  links: [link(30, 8, 0, 11, 1, "STRING"), link(31, 9, 0, 11, 0, "MODEL")]
};

r = adapt(g, STUB_DEFS, null);
assert(Array.isArray(r.api["11"].inputs.prompt),
       "while the upstream node is present the prompt stays a LINK - which " +
       "is exactly why an injected widget value did nothing");
assert(!("12" in r.api),
       "a frontend-only MarkdownNote never reaches the API graph");

r = adapt(g, STUB_DEFS, { panelAdaptation: { dropNodes: [8] } });
assert(r.api["11"].inputs.prompt === "the value the panel injects",
       "dropping the upstream node hands the widget its own value back, so " +
       "injection takes effect");
assert(!("8" in r.api), "the dropped node is gone from the API graph");
assert(r.rewired.join(" ").indexOf("widget value used") !== -1,
       "the swap from link to widget value is reported");

throws(() => adapt(g, STUB_DEFS, { panelAdaptation: { dropNodes: [999] } }),
       "which this workflow does not have",
       "dropNodes naming a node that is not there fails with the real list");

// ------------------------------------------------- 6. grounded refusals

g = {
  nodes: [{ id: 13, type: "NotHarvested", mode: 0, widgets_values: [],
            inputs: [], outputs: [] }],
  links: []
};
throws(() => adapt(g, STUB_DEFS, null), "no harvested definition for node type",
       "an unknown node class fails loudly, listing what IS known");

g = {
  nodes: [{ id: 14, type: "RandomNoise", mode: 0, widgets_values: [1],
            inputs: [], outputs: [] }],
  links: []
};
throws(() => adapt(g, STUB_DEFS, null), "widget values but the workflow stores",
       "too few stored widget values fails instead of writing undefined");

throws(() => adapt({ nodes: [], links: [],
                     definitions: { subgraphs: [{ name: "Initial Loader" }] } },
                   STUB_DEFS, null),
       "does not flatten them",
       "a workflow with subgraphs is refused with the /history route named");

throws(() => adapt({ "1": { class_type: "X" } }, STUB_DEFS, null),
       "not a UI-format workflow",
       "an already-API graph is refused rather than half-converted");

// ------------------------------- 7. the shipped H3 i2v template, for real

const REPO = path.join(__dirname, "..");
const uiFile = path.join(REPO, "extension", "workflows",
                         "AE_LLAMA_H3_I2V_V1.json");
const manifestFile = path.join(REPO, "extension", "workflows",
                               "AE_LLAMA_H3_I2V_V1.manifest.json");
const apiFile = path.join(REPO, "extension", "comfy-workflows",
                          "AE_LLAMA_H3_I2V_V1.json");
const defsFile = path.join(REPO, "scripts", "comfy-node-defs.json");

const ui = JSON.parse(fs.readFileSync(uiFile, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const defs = JSON.parse(fs.readFileSync(defsFile, "utf8"));
const shipped = JSON.parse(fs.readFileSync(apiFile, "utf8"));

const built = adapt(ui, defs, manifest).api;
assert(JSON.stringify(built) === JSON.stringify(shipped),
       "the checked-in API template is exactly what the converter produces " +
       "from the checked-in UI template (edit the UI one and regenerate)");

const classes = Object.keys(shipped).map((k) => shipped[k].class_type);
assert(classes.indexOf("OllamaGenerate") === -1 &&
       classes.indexOf("PrimitiveStringMultiline") === -1,
       "the Ollama enhancer pair is gone - the panel enhances with its own " +
       "chat model");
assert(classes.indexOf("MarkdownNote") === -1,
       "no frontend-only note nodes shipped");

assert(typeof shipped["138"].inputs.prompt === "string",
       "H3 node 138's prompt is a plain string, so injectParams can write it");
assert(Array.isArray(shipped["138"].inputs.width) &&
       Array.isArray(shipped["138"].inputs.length),
       "width/height/length stay LINKED to the resolution and frame-grid " +
       "maths - injecting them directly would fight the graph");

// The manifest's procedural block addresses nodes by id; the conversion must
// not renumber, or every injection point in it silently points at nothing.
const proc = manifest.procedural;
[["durationSeconds", proc.durationSeconds.nodeId],
 ["prompt", proc.prompt.nodeId],
 ["firstFrame", proc.firstFrame.nodeId],
 ["resolution", proc.resolution.nodeId]].forEach(([label, id]) => {
  assert(shipped[String(id)] !== undefined,
         "procedural." + label + " points at node " + id +
         ", which survived the conversion under the same id");
});
assert(shipped[String(proc.durationSeconds.nodeId)].inputs.value === 15,
       "duration node still holds SECONDS (the graph converts to frames)");

// Bypassed in the source graph, so it must not be in the API graph -- and its
// consumer must have been rewired past it.
assert(classes.indexOf("Power Lora Loader (rgthree)") === -1,
       "the bypassed turbo-LoRA loader is not shipped");
assert(shipped["163"].inputs.model[0] === "153",
       "the LoRA loader's consumer was rewired to the node upstream of it");

// The dynamic/autogrow decoding the whole conversion turns on.
assert(shipped["135"].inputs["values.a"][0] === "136" &&
       shipped["135"].inputs["values.b"][0] === "150",
       "the frame-grid expression's autogrow members are wired by dotted name");
assert(shipped["92"].inputs.codec === "h264" &&
       shipped["92"].inputs["codec.encoding"] === "auto",
       "SaveVideo's nested dynamic combo expanded to codec + codec.encoding");
assert(shipped["168"].inputs["resize_type.width"] === 1920 &&
       shipped["168"].inputs.quality === "ULTRA",
       "the RTX upscaler's dynamic combo expanded without shifting quality");

// comfy.js must actually accept it -- rejecting UI format is why this pass
// existed at all.
const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => REPO },
  Settings: { dataRoot: () => REPO },
  setTimeout, clearTimeout
};
eval(fs.readFileSync(path.join(REPO, "extension", "js", "comfy.js"), "utf8"));
const Comfy = window.Comfy;

let loaded = null;
try { loaded = Comfy.loadWorkflow(apiFile); } catch (e) { loaded = e; }
assert(loaded && !(loaded instanceof Error),
       "comfy.js loadWorkflow accepts the adapted template" +
       (loaded instanceof Error ? " (" + loaded.message + ")" : ""));

throws(() => Comfy.loadWorkflow(uiFile), "UI-format export",
       "and still refuses the raw UI template it was made from");

assert(Comfy.readManifest(apiFile) !== null,
       "the manifest is seeded alongside the API template, so the enhancer " +
       "instruction reaches the panel");

const listed = Comfy.listWorkflows(path.join(REPO, "extension",
                                             "comfy-workflows"))
  .map((w) => w.name);
assert(listed.indexOf("AE_LLAMA_H3_I2V_V1") !== -1,
       "the seeded template is listed for the model to pick");
assert(listed.indexOf("AE_LLAMA_H3_I2V_V1.manifest") === -1,
       "its sidecar is NOT listed as a workflow of its own");

const applied = Comfy.injectParams(loaded, { prompt: "a red balloon", seed: 7 });
assert(loaded["133"].inputs.noise_seed === 7,
       "injectParams still finds the seed in the adapted graph");
assert(applied.join(" ").indexOf("seed") !== -1,
       "and reports what it changed");
// Documented gap, owned by part 2 of the item: H3 carries its prompt on
// MiniMaxH3ImageToVideo, not a CLIPTextEncode, so the generic walk cannot
// place it. Pinned here so part 2 has a failing expectation to flip.
assert(loaded["138"].inputs.prompt !== "a red balloon",
       "KNOWN GAP: injectParams does not yet reach the H3 prompt node " +
       "(manifest procedural wiring is part 2 of WORKPLAN item 2d)");

process.exit(failures ? 1 : 0);
