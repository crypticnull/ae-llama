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
//     back, which is the entire reason the H3 template needed adapting;
//   - a SUBGRAPH's promoted widget lives on the instance, and the inner node
//     keeps a stale copy of it (KREA2, 2026-08-28);
//   - cg-use-everywhere's "Anything Everywhere" draws no wire at all, so the
//     links it stands in for are invisible in the export.
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

throws(() => adapt({ "1": { class_type: "X" } }, STUB_DEFS, null),
       "not a UI-format workflow",
       "an already-API graph is refused rather than half-converted");

// ------------------------------------------------------- 7. subgraphs
//
// Measured on the KREA2 template (2026-08-28): its "Initial Loader" subgraph
// holds three loaders whose file-name widgets are PROMOTED to the instance.
// The instance's copy is the live one and the inner nodes keep a stale copy,
// so a flattener that trusted the inner value would load whatever the author
// last had selected before promoting the widget.

function subLoaderDef(extra) {
  const def = {
    id: "SUB", name: "Loaders",
    inputNode: { id: -10 }, outputNode: { id: -20 },
    inputs: [{ name: "name", type: "COMBO" }],
    outputs: [{ name: "MODEL", type: "MODEL" }],
    widgets: [],
    nodes: [{ id: 50, type: "ModelSource", mode: 0,
              widgets_values: ["stale.safetensors"],
              inputs: [{ name: "name", type: "COMBO",
                         widget: { name: "name" }, link: 900 }],
              outputs: [{ name: "MODEL", type: "MODEL", links: [901] }] }],
    links: [
      { id: 900, origin_id: -10, origin_slot: 0,
        target_id: 50, target_slot: 0, type: "COMBO" },
      { id: 901, origin_id: 50, origin_slot: 0,
        target_id: -20, target_slot: 0, type: "MODEL" }
    ]
  };
  Object.keys(extra || {}).forEach((k) => { def[k] = extra[k]; });
  return def;
}

function subgraphGraph(instance, defExtra) {
  const inst = {
    id: 60, type: "SUB", mode: 0, widgets_values: ["live.safetensors"],
    inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [70] }]
  };
  Object.keys(instance || {}).forEach((k) => { inst[k] = instance[k]; });
  return {
    definitions: { subgraphs: [subLoaderDef(defExtra)] },
    nodes: [
      inst,
      { id: 61, type: "Consumer", mode: 0, widgets_values: ["p"],
        inputs: [{ name: "model", type: "MODEL", link: 70 },
                 { name: "prompt", type: "STRING",
                   widget: { name: "prompt" }, link: null }],
        outputs: [] }
    ],
    links: [link(70, 60, 0, 61, 0, "MODEL")]
  };
}

r = adapt(subgraphGraph(), STUB_DEFS, null);
assert(r.api["60:50"] && r.api["60:50"].class_type === "ModelSource",
       "a subgraph's inner node is emitted as <instance>:<inner>, the same " +
       "id ComfyUI's own expansion produces");
assert(!("60" in r.api),
       "the instance node itself never reaches the API graph - /prompt has " +
       "never heard of a subgraph UUID");
assert(r.api["60:50"].inputs.name === "live.safetensors",
       "the INSTANCE's promoted widget value wins over the inner node's " +
       "stale copy of it");
assert(r.api["61"].inputs.model[0] === "60:50",
       "a consumer outside the subgraph is wired to the inner producer");
assert(r.expandedSubgraphs.length === 1 &&
       r.expandedSubgraphs[0].indexOf("Loaders") !== -1,
       "the expansion is reported by name, not done silently");
assert(r.rewired.join(" ").indexOf("promoted subgraph widget") !== -1,
       "and the value override is reported too");

// A promoted input can also be CONNECTED in the parent, in which case it is a
// signal, not a value.
let sg = subgraphGraph({
  inputs: [{ name: "name", type: "COMBO", link: 71 }],
  widgets_values: []
});
sg.nodes.push({ id: 62, type: "TextSource", mode: 0, widgets_values: ["x"],
                inputs: [], outputs: [{ name: "STRING", type: "STRING",
                                        links: [71] }] });
sg.links.push(link(71, 62, 0, 60, 0, "COMBO"));
r = adapt(sg, STUB_DEFS, null);
assert(Array.isArray(r.api["60:50"].inputs.name) &&
       r.api["60:50"].inputs.name[0] === "62",
       "a promoted input the parent CONNECTED crosses the boundary as a link");

// Nested: a subgraph inside a subgraph.
sg = subgraphGraph();
sg.definitions.subgraphs.push({
  id: "OUTER", name: "Outer",
  inputNode: { id: -10 }, outputNode: { id: -20 },
  inputs: [], outputs: [{ name: "MODEL", type: "MODEL" }], widgets: [],
  nodes: [{ id: 80, type: "SUB", mode: 0,
            widgets_values: ["inner.safetensors"], inputs: [],
            outputs: [{ name: "MODEL", type: "MODEL", links: [910] }] }],
  links: [{ id: 910, origin_id: 80, origin_slot: 0,
            target_id: -20, target_slot: 0, type: "MODEL" }]
});
sg.nodes[0].type = "OUTER";
sg.nodes[0].widgets_values = [];
r = adapt(sg, STUB_DEFS, null);
assert(r.api["60:80:50"] &&
       r.api["60:80:50"].inputs.name === "inner.safetensors",
       "nested subgraphs expand recursively, id by id");
assert(r.api["61"].inputs.model[0] === "60:80:50",
       "and the outside consumer reaches all the way in");

throws(() => adapt(subgraphGraph({ mode: 4 }), STUB_DEFS, null),
       "muted or bypassed",
       "a bypassed subgraph instance is refused, not guessed at");
throws(() => adapt(subgraphGraph(null, { widgets: [{ name: "seed" }] }),
                   STUB_DEFS, null),
       "promotes 1 widget(s)",
       "a promoted widget that is not also an input is refused (unmeasured " +
       "shape), with the /history route named");
throws(() => adapt(subgraphGraph({ widgets_values: [] }), STUB_DEFS, null),
       "neither a connection nor a stored widget value",
       "an input with no value and no wire is refused rather than sent as " +
       "undefined");

// ------------------------------------------ 8. cg-use-everywhere broadcasts

function ueProps(extra) {
  const p = { group_restricted: 0, color_restricted: 0, title_regex: null,
              input_regex: null, group_regex: null, send_to_any: 0,
              string_to_combo: 0 };
  Object.keys(extra || {}).forEach((k) => { p[k] = extra[k]; });
  return { ue_properties: p };
}

function ueGraph(opts) {
  opts = opts || {};
  return {
    nodes: [
      { id: 90, type: "ModelSource", mode: 0, widgets_values: ["m"],
        inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [100] }] },
      { id: 91, type: opts.type || "Anything Everywhere", mode: 0,
        widgets_values: [], properties: ueProps(opts.props),
        inputs: opts.inputs || [
          { name: "anything", type: "MODEL", link: 100 },
          { name: "anything2", type: "*", link: null }
        ],
        outputs: [] },
      { id: 92, type: "Consumer", mode: 0, widgets_values: ["p"],
        inputs: [{ name: "model", type: "MODEL", link: null },
                 { name: "prompt", type: "STRING",
                   widget: { name: "prompt" }, link: null },
                 { name: "extra", type: "IMAGE", link: null }],
        outputs: [] }
    ],
    links: [link(100, 90, 0, 91, 0, "MODEL")]
  };
}

r = adapt(ueGraph(), STUB_DEFS, null);
assert(r.api["92"].inputs.model[0] === "90",
       "an unconnected socket is filled from the broadcaster's source - the " +
       "frontend draws no wire for this, so a converter that ignores it " +
       "ships a graph missing links the author is looking at");
assert(!("91" in r.api),
       "the broadcaster is frontend wiring and never reaches the API graph");
assert(r.api["92"].inputs.prompt === "p",
       "a WIDGET slot is never filled by the broadcast");
assert(!("extra" in r.api["92"].inputs),
       "a socket whose type nobody broadcasts is left alone");
assert(r.rewired.join(" ").indexOf("wired by Anything Everywhere") !== -1,
       "the virtual wiring is reported, not silent");

sg = ueGraph();
sg.nodes.push({ id: 93, type: "ModelSource", mode: 0, widgets_values: ["m2"],
                inputs: [], outputs: [{ name: "MODEL", type: "MODEL",
                                        links: [101] }] });
sg.nodes[2].inputs[0].link = 101;
sg.links.push(link(101, 93, 0, 92, 0, "MODEL"));
r = adapt(sg, STUB_DEFS, null);
assert(r.api["92"].inputs.model[0] === "93",
       "a socket that IS connected keeps its own wire");

throws(() => adapt(ueGraph({ props: { group_restricted: 1 } }),
                   STUB_DEFS, null),
       "restricts its broadcast",
       "a group/colour-restricted broadcast is refused, naming the property");
throws(() => adapt(ueGraph({ type: "Anything Everywhere?" }), STUB_DEFS, null),
       "regex/group/colour rules",
       "the regex-targeted variants are refused with the /history route");
throws(() => adapt(ueGraph({ inputs: [
         { name: "a", type: "MODEL", link: 100 },
         { name: "b", type: "MODEL", link: 100 }] }), STUB_DEFS, null),
       "two use-everywhere inputs",
       "two broadcasts of one type are refused - which socket gets which is " +
       "not decidable from the export");
throws(() => adapt(ueGraph({ inputs: [
         { name: "a", type: "*", link: 100 }] }), STUB_DEFS, null),
       "untyped (*) input",
       "an untyped broadcast is refused rather than wired everywhere");

// ------------------------------- 9. the shipped H3 i2v template, for real

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
// Without the manifest the generic walk still cannot see it: H3 carries its
// prompt on MiniMaxH3ImageToVideo, not a CLIPTextEncode. That is exactly why
// the sidecar's procedural block exists.
assert(loaded["138"].inputs.prompt !== "a red balloon",
       "the generic walk alone does not reach the H3 prompt node");

const withManifest = Comfy.loadWorkflow(apiFile);
const applied2 = Comfy.injectParams(withManifest,
                                    { prompt: "a red balloon", seed: 7 },
                                    Comfy.readManifest(apiFile));
assert(withManifest["138"].inputs.prompt === "a red balloon",
       "with the sidecar, procedural.prompt lands on node 138");
assert(applied2.join(" ").indexOf("prompt -> node 138") !== -1,
       "and the applied list names the node it went to");

// ------------------- 10. the AUTHORED KREA2 template, subgraph and all
//
// Not shipped yet -- its manifest still owes a removal rule per custom-pack
// class, and it has never rendered a frame through the panel. What is proved
// here is the conversion itself, which is what the subgraph and use-everywhere
// work above was for. The graph this produces was run through ComfyUI 0.32.0's
// own execution.validate_prompt() on the AE machine on 2026-08-28:
// valid: True, good outputs 474/475/478/479/482/497, no node errors.

const kreaUi = JSON.parse(fs.readFileSync(
  path.join(REPO, "extension", "workflows", "AE_LLAMA_KREA2_V1.json"), "utf8"));
const krea = adapt(kreaUi, defs, null);

assert(krea.expandedSubgraphs.length === 1 &&
       krea.expandedSubgraphs[0].indexOf("Initial Loader") !== -1,
       "KREA2's one subgraph is expanded by name");
assert(krea.api["439:436"] &&
       krea.api["439:436"].class_type === "UNETLoader" &&
       krea.api["439:436"].inputs.unet_name ===
         "krea2_turbo_int8_convrot.safetensors",
       "the Initial Loader's UNETLoader arrives with the instance's file name");
assert(krea.api["439:438"].class_type === "VAELoader" &&
       krea.api["439:437"].class_type === "CLIPLoader",
       "and so do the VAE and CLIP loaders beside it");
assert(krea.api["415"].inputs.vae[0] === "439:438" &&
       krea.api["416"].inputs.vae[0] === "439:438",
       "both VAEDecodes get their VAE ONLY through the broadcast - there is " +
       "no drawn wire between them and the loader");
assert(krea.api["264"].inputs.model[0] === "604" &&
       krea.api["267"].inputs.clip[0] === "604",
       "MODEL and CLIP broadcast from the LoRA loader the author put in the " +
       "middle, not from the subgraph behind it");

const kreaClasses = Object.keys(krea.api).map((k) => krea.api[k].class_type);
["Anything Everywhere", "Label (rgthree)", "Fast Groups Bypasser (rgthree)",
 "Note"].forEach((cls) => {
  assert(kreaClasses.indexOf(cls) === -1,
         "no '" + cls + "' in the API graph - the backend has never heard " +
         "of it");
});
assert(kreaClasses.indexOf("OllamaGenerateV2") === -1 &&
       !("any_01" in krea.api["601"].inputs) &&
       Array.isArray(krea.api["601"].inputs.any_02),
       "the author left the Ollama enhancer bypassed, so the switch falls " +
       "through to the manual prompt input");

// ------------------- 11. panelAdaptation.setInputs: the one-machine value
//
// KREA2 was authored with an ABSOLUTE SaveImage prefix
// (C:\Users\mr\Documents\ComfyUI\output\_KREA2\...). ComfyUI joins a prefix
// onto ITS OWN output dir and then refuses anything landing outside it
// (folder_paths.get_save_image_path), so that value renders on exactly one
// machine and kills the render at its LAST node everywhere else - with the
// GPU time already spent. The correction belongs in the sidecar, not hand-
// edited into the API file, or the next regeneration silently undoes it.

{
  const authored = JSON.parse(fs.readFileSync(path.join(
    REPO, "extension", "workflows", "AE_LLAMA_KREA2_V1.manifest.json"), "utf8"));
  const before = kreaUi.nodes.filter((n) => n.id === 474)[0].widgets_values[0];
  assert(/^[A-Za-z]:/.test(before),
         "the AUTHORED template really does carry an absolute path (" +
         before + ")");

  const fixed = adapt(JSON.parse(JSON.stringify(kreaUi)), defs, authored);
  // Was extension/comfy-workflows/ until WORKPLAN 18 P8 took it out of the
  // shipped bundle; it is still the converter's expected output, so it moved
  // to tests/fixtures/authored-krea2/ rather than being deleted.
  const shippedKrea = JSON.parse(fs.readFileSync(path.join(
    REPO, "tests", "fixtures", "authored-krea2",
    "AE_LLAMA_KREA2_V1.json"), "utf8"));
  assert(JSON.stringify(fixed.api) === JSON.stringify(shippedKrea),
         "the checked-in KREA2 API template is exactly what the converter " +
         "produces from the checked-in UI template and its sidecar (edit " +
         "either and regenerate)");
  const after = fixed.api["474"].inputs.filename_prefix;
  assert(!/^[A-Za-z]:/.test(after) &&
         after.indexOf(String.fromCharCode(92)) === -1,
         "the sidecar's setInputs makes it relative (" + after + ")");
  assert(after === authored.panelAdaptation.setInputs["474"].filename_prefix,
         "with exactly the value the manifest declares");
  assert(fixed.rewired.join(" ").indexOf("set by manifest") !== -1,
         "and the change is reported, not silent");

  throws(() => adapt(JSON.parse(JSON.stringify(kreaUi)), defs,
                     { panelAdaptation: { setInputs: { "9999": { a: 1 } } } }),
         "is not in the adapted graph",
         "setInputs naming a node the graph does not have fails with a list");
  throws(() => adapt(JSON.parse(JSON.stringify(kreaUi)), defs,
                     { panelAdaptation: { setInputs: { "474": { nope: 1 } } } }),
         "which has:",
         "setInputs naming an input the class does not have fails, listing " +
         "the ones it does");
  throws(() => adapt(JSON.parse(JSON.stringify(kreaUi)), defs,
                     { panelAdaptation: { setInputs: { "474": { images: 1 } } } }),
         "which is a LINK",
         "and it refuses to overwrite a LINK - rewiring is the graph " +
         "author's job, not the sidecar's");
}

process.exit(failures ? 1 : 0);
