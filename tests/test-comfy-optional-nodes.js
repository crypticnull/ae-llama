/*
 * test-comfy-optional-nodes.js — nodes a bundled template can run WITHOUT.
 *
 * The H3 i2v template ends in RTXVideoSuperResolution, which ships in
 * comfyui_nvidia_rtx_nodes and needs the NVIDIA app's video SDK. It
 * registers on some machines and not others, so a template that hard-requires
 * it fails validation on every machine without the SDK — including, one day,
 * a user's. The manifest's `optionalNodes` block says which nodes may be
 * dropped and which input passes through when they are.
 *
 * The load-bearing fact, read out of the installed ComfyUI 0.32.0 rather than
 * assumed (server.py, get_object_info_node):
 *
 *     out = {}
 *     if (node_class is not None) and (node_class in nodes.NODE_CLASS_MAPPINGS):
 *         out[node_class] = node_info(node_class)
 *     return web.json_response(out)
 *
 * GET /object_info/<class> therefore answers **200 with {}** for a class
 * ComfyUI has never heard of — it does NOT 404. A presence test that trusted
 * the status code would report every class installed and never bypass
 * anything. The fake server below reproduces that exactly, so this test fails
 * if someone "simplifies" classInstalled into a status-code check.
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
function throws(fn, needle, label) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  if (msg === null) {
    failures++; console.log("FAIL- " + label + " (did not throw)");
    return "";
  }
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

// (No longer SHIPPED either: WORKPLAN 18 P9 replaced the minimax-h3 entry's
// graph with the core-only AE_LLAMA_H3_T2V_V1 and moved this one to a
// fixture -- tests/fixtures/authored-h3/README.md. It is kept because it is
// now the ONLY manifest in the repo with an optionalNodes block at all:
// five bypasses, one substitution and a terminal node with no consumer.
// Nothing core-only can stand in for it, and the rules it exercises are
// still live code that any future authored graph will lean on.)
const TEMPLATE = path.join(REPO, "tests", "fixtures", "authored-h3",
                           "AE_LLAMA_H3_I2V_V1.json");
const MANIFEST = path.join(REPO, "tests", "fixtures", "authored-h3",
                           "AE_LLAMA_H3_I2V_V1.manifest.json");
const template = () => JSON.parse(fs.readFileSync(TEMPLATE, "utf8"));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

// KREA2 is the second shipped template and the one that needed the rules to
// grow: rgthree's Power Lora Loader emits MODEL on slot 0 and CLIP on slot 1
// from two different inputs, so a single passthrough cannot answer for it.
// (No longer SHIPPED: WORKPLAN 18 P8 replaced the krea2 entry's graph with
// the core-only AE_LLAMA_KREA2_T2I_V1 and moved this one to a fixture --
// tests/fixtures/authored-krea2/README.md. Kept because nothing core-only
// has a two-output pack node to test against.)
const K_TEMPLATE = path.join(REPO, "tests", "fixtures", "authored-krea2",
                             "AE_LLAMA_KREA2_V1.json");
const K_MANIFEST = path.join(REPO, "tests", "fixtures", "authored-krea2",
                             "AE_LLAMA_KREA2_V1.manifest.json");
const kTemplate = () => JSON.parse(fs.readFileSync(K_TEMPLATE, "utf8"));
const kManifest = JSON.parse(fs.readFileSync(K_MANIFEST, "utf8"));
const kByClass = (c) =>
  (kManifest.optionalNodes || []).filter((o) => o["class"] === c)[0] || {};

// ------------------------------------------------- the shipped template

const OPTIONALS = manifest.optionalNodes || [];
const byClass = (c) => OPTIONALS.filter((o) => o["class"] === c)[0] || {};
const rtxAt = OPTIONALS.map((o) => o["class"])
                       .indexOf("RTXVideoSuperResolution");

const g0 = template();
assert(g0["168"] && g0["168"].class_type === "RTXVideoSuperResolution",
       "the shipped template still ends in RTXVideoSuperResolution at 168");
const entry = byClass("RTXVideoSuperResolution");
assert(String(entry.nodeId) === "168" && entry.passthrough === "images",
       "and the manifest marks it optional, passing through 'images'");
assert(Array.isArray(g0["168"].inputs[entry.passthrough]),
       "whose 'images' input really is a LINK, so there is something to " +
       "rewire consumers to");

// THE portability invariant, and the reason this file grew past one node:
// the shipped H3 template loaded classes from SEVEN packs and declared one
// of them optional, so it ran on the machine it was authored on and nowhere
// else. Every non-core class must now carry a rule.
{
  const core = (manifest.customNodes || [])
    .filter((e) => e.pack === "(comfy-core)")
    .reduce((s, e) => s.concat(e.nodes || []), []);
  const used = Object.keys(g0).map((k) => g0[k].class_type);
  const custom = [...new Set(used)].filter((c) => core.indexOf(c) === -1);
  const ruled = OPTIONALS.map((o) => o["class"]);
  const unruled = custom.filter((c) => ruled.indexOf(c) === -1);
  assert(custom.length > 0, "the template does use custom-pack classes");
  assert(unruled.length === 0,
         "every custom-pack class the shipped graph uses has an " +
         "optionalNodes rule, so a bare ComfyUI can still load it" +
         (unruled.length ? " — HARD-REQUIRED: " + unruled.join(", ") : ""));
  // A rule is only real if it names how to remove the node.
  const ruleless = OPTIONALS.filter((o) => !o.passthrough && !o.substitute)
                            .map((o) => o["class"]);
  assert(ruleless.length === 0,
         "and each rule says HOW (passthrough or substitute)" +
         (ruleless.length ? " — neither: " + ruleless.join(", ") : ""));
}

// --------------------------------------------------------- bypassNode

{
  const g = template();
  const feeder = String(g["168"].inputs.images[0]);
  const consumers = Object.keys(g).filter(k =>
    g[k] && g[k].inputs && Object.keys(g[k].inputs).some(ik =>
      Array.isArray(g[k].inputs[ik]) &&
      String(g[k].inputs[ik][0]) === "168"));
  assert(consumers.length > 0,
         "node 168 has consumers to rewire (" + consumers.join(", ") + ")");

  const r = Comfy.bypassNode(g, 168, "images");
  assert(!g["168"], "bypassNode deletes the node");
  let allRewired = true;
  for (const c of consumers) {
    for (const ik of Object.keys(g[c].inputs)) {
      const v = g[c].inputs[ik];
      if (Array.isArray(v) && String(v[0]) === "168") allRewired = false;
    }
  }
  assert(allRewired, "and no input anywhere still points at 168");
  assert(String(g["134"].inputs.images[0]) === feeder,
         "CreateVideo now reads straight from " + feeder +
         " (got " + JSON.stringify(g["134"].inputs.images) + ")");
  assert(r.rewired.length === consumers.length,
         "and it reports what it rewired: " + r.rewired.join(", "));
}

{
  const g = template();
  assert(Comfy.bypassNode(g, 9999, "images") === null,
         "bypassing a node that is not there returns null, not an error");
}
{
  const g = template();
  throws(() => Comfy.bypassNode(g, 168, null),
         "does not say which input passes through",
         "no passthrough named -> refused, and it lists the real inputs");
}
{
  const g = template();
  const msg = throws(() => Comfy.bypassNode(g, 168, "not_an_input"),
    "has no input named",
    "a passthrough that does not exist -> refused");
  assert(msg.indexOf("images") !== -1,
         "naming the inputs it DOES have");
}
{
  // A literal cannot be handed to a socket expecting a link. Deleting the
  // consumers' inputs instead would fail validation later, far from here.
  const g = template();
  g["168"].inputs.images = "a-literal.png";
  throws(() => Comfy.bypassNode(g, 168, "images"),
         "not a link from another node",
         "a literal passthrough -> refused with the reason");
}

// ------------------------------------------- bypassNode, per output SLOT
//
// A node with ONE output takes an input name and every consumer is rewired to
// it. rgthree's Power Lora Loader has TWO — MODEL from the UNETLoader and
// CLIP from the CLIPLoader — and KREA2 wires four MODEL consumers and two
// CLIP consumers to it. Answering both with one input would hand every
// CLIPTextEncode a MODEL, and the server would report the type error at a
// node the user never touched.

{
  const g = kTemplate();
  assert(g["604"] && g["604"].class_type === "Power Lora Loader (rgthree)",
         "KREA2 node 604 is rgthree's Power Lora Loader");
  const slots = new Set();
  Object.keys(g).forEach((k) => Object.keys(g[k].inputs || {}).forEach((ik) => {
    const v = g[k].inputs[ik];
    if (Array.isArray(v) && String(v[0]) === "604") slots.add(v[1]);
  }));
  assert(slots.has(0) && slots.has(1),
         "and consumers read BOTH of its output slots (" +
         [...slots].join(", ") + ")");

  const modelSrc = String(g["604"].inputs.model[0]);
  const clipSrc = String(g["604"].inputs.clip[0]);
  assert(modelSrc !== clipSrc,
         "fed by two DIFFERENT nodes (" + modelSrc + " model, " + clipSrc +
         " clip), which is what makes one passthrough impossible");

  const rule = kByClass("Power Lora Loader (rgthree)").passthrough;
  assert(rule && typeof rule === "object" && rule["0"] === "model" &&
         rule["1"] === "clip",
         "the manifest answers with a slot map: " + JSON.stringify(rule));

  const r = Comfy.bypassNode(g, 604, rule);
  assert(!g["604"], "bypassNode deletes it");
  assert(String(g["264"].inputs.model[0]) === modelSrc &&
         String(g["277"].inputs.model[0]) === modelSrc,
         "MODEL consumers now read the UNETLoader (" +
         JSON.stringify(g["264"].inputs.model) + ")");
  assert(String(g["267"].inputs.clip[0]) === clipSrc &&
         String(g["280"].inputs.clip[0]) === clipSrc,
         "and CLIP consumers read the CLIPLoader (" +
         JSON.stringify(g["267"].inputs.clip) + ") — NOT the UNETLoader");
  assert(r.rewired.length === 6, "six sockets rewired: " + r.rewired.join(", "));
}

{
  // THE regression this exists for: the old single-name form silently sent
  // slot-1 consumers to the slot-0 source. It must refuse instead.
  const g = kTemplate();
  const msg = throws(() => Comfy.bypassNode(g, 604, "model"),
    "output slot 0",
    "a plain input name on a MULTI-output node -> refused");
  assert(/reads slot 1/.test(msg),
         "naming the consumer that reads the other slot [" + msg + "]");
  assert(msg.indexOf("passthrough MAP") !== -1,
         "and telling the manifest author what to write instead");
  assert(!!g["604"], "the graph is left alone");
}

{
  const g = kTemplate();
  const msg = throws(() => Comfy.bypassNode(g, 604, { "0": "model" }),
    "does not cover",
    "a slot map that misses a slot consumers read -> refused");
  assert(/slot 1/.test(msg), "naming the slot [" + msg + "]");
  assert(!!g["604"], "and the graph is left alone");
}

{
  const g = kTemplate();
  throws(() => Comfy.bypassNode(g, 604, { "0": "model", "1": "nope" }),
         "has no input named",
         "a slot map naming an input that does not exist -> refused");
  assert(!!g["604"] && Array.isArray(g["267"].inputs.clip) &&
         String(g["267"].inputs.clip[0]) === "604",
         "and nothing is rewired before every source resolves — a partial " +
         "bypass would leave half the graph pointing at a deleted node");
}

{
  // A TERMINAL node has no consumers, so no source is needed at all. Image
  // Comparer is one: nothing in KREA2 reads its output.
  const g = kTemplate();
  const readers = Object.keys(g).filter((k) =>
    Object.keys(g[k].inputs || {}).some((ik) =>
      Array.isArray(g[k].inputs[ik]) && String(g[k].inputs[ik][0]) === "475"));
  assert(readers.length === 0, "node 475 (Image Comparer) is terminal");
  g["475"].inputs.image_a = "a-literal.png";
  const r = Comfy.bypassNode(g, 475, "image_a");
  assert(!g["475"] && r.rewired.length === 0,
         "so it is removable even with a LITERAL passthrough — there is " +
         "nothing to rewire to and nothing that needs one");
}

// ------------------------------------------------------ substituteNode
//
// The megapixel source (node 167) is ComfyLiterals' `Float`, and it is the
// one node here that CANNOT be bypassed: its only input is the literal
// ".98", so its consumer has nothing to be rewired to. Core PrimitiveFloat
// has the same FLOAT output, so the node is REPLACED in place — same id,
// same socket, different class.

{
  const g = template();
  assert(g["167"] && g["167"].class_type === "Float" &&
         typeof g["167"].inputs.Number === "string",
         "node 167 is ComfyLiterals' Float, carrying a STRING widget (" +
         JSON.stringify(g["167"].inputs.Number) + ")");
  assert(String(g["115"].inputs.megapixels[0]) === "167",
         "and ResolutionSelector reads it, so it cannot just be deleted");
  throws(() => Comfy.bypassNode(g, 167, "Number"),
         "not a link from another node",
         "which is exactly why bypassNode refuses it");

  const sub = byClass("Float").substitute;
  const r = Comfy.substituteNode(g, 167, sub);
  assert(g["167"].class_type === "PrimitiveFloat",
         "substituteNode swaps the class in place");
  assert(g["167"].inputs.value === 0.98 &&
         typeof g["167"].inputs.value === "number",
         "coercing the STRING '.98' to the FLOAT PrimitiveFloat requires " +
         "(got " + JSON.stringify(g["167"].inputs.value) + ")");
  assert(!("Number" in g["167"].inputs),
         "and dropping the input the new class does not have — an " +
         "inherited stray key fails validation at the server");
  assert(String(g["115"].inputs.megapixels[0]) === "167" &&
         g["115"].inputs.megapixels[1] === 0,
         "the consumer still points at 167:0, untouched");
  assert(r.carried.join(",").indexOf("value <- Number") !== -1,
         "and it reports what it carried: " + r.carried.join(", "));
}

{
  // Injection runs BEFORE optional nodes resolve, so whatever the panel
  // wrote into the old input has to survive the swap.
  const g = template();
  g["167"].inputs.Number = "0.15";
  Comfy.substituteNode(g, 167, byClass("Float").substitute);
  assert(g["167"].inputs.value === 0.15,
         "an INJECTED megapixel figure is carried across, not the " +
         "template default (got " + g["167"].inputs.value + ")");
}

{
  const g = template();
  assert(Comfy.substituteNode(g, 9999, { "class": "PrimitiveFloat" }) === null,
         "substituting a node that is not there returns null, not an error");
}
{
  const g = template();
  throws(() => Comfy.substituteNode(g, 167, { inputs: {} }),
         "names no replacement class",
         "a substitute block with no class -> refused");
}
{
  const g = template();
  const msg = throws(() => Comfy.substituteNode(g, 167,
    { "class": "PrimitiveFloat", inputs: { value: { from: "nope" } } }),
    "has no input named",
    "a 'from' that does not exist -> refused");
  assert(msg.indexOf("Number") !== -1, "naming the inputs it DOES have");
  assert(g["167"].class_type === "Float", "and the graph is left alone");
}
{
  const g = template();
  g["167"].inputs.Number = "not a number";
  throws(() => Comfy.substituteNode(g, 167, byClass("Float").substitute),
         "to a number",
         "a value that cannot be coerced -> refused, rather than posting " +
         "NaN and letting the server say something unhelpful");
}
{
  // A link's type is whatever its source emits; this side cannot see that,
  // so coercing one would be a guess dressed as a fact.
  const g = template();
  g["167"].inputs.Number = ["136", 0];
  throws(() => Comfy.substituteNode(g, 167, byClass("Float").substitute),
         "link carries whatever type its source emits",
         "coercing a LINK -> refused");
}
{
  const g = template();
  throws(() => Comfy.substituteNode(g, 167,
    { "class": "PrimitiveFloat", inputs: { value: { from: "Number", as: "flurb" } } }),
    "unknown type",
    "an unknown coercion -> refused, listing the ones that exist");
}
{
  const g = template();
  const r = Comfy.substituteNode(g, 167,
    { "class": "PrimitiveFloat", inputs: { value: { "const": 0.5 } } });
  assert(g["167"].inputs.value === 0.5 && r.dropped.indexOf("Number") !== -1,
         "a 'const' rule supplies an input the old node never had, and the " +
         "unmapped one is reported dropped: " + r.dropped.join(", "));
}

// ------------------------------------------- a fake ComfyUI /object_info

function fakeComfy(installed, cb) {
  const server = http.createServer((req, res) => {
    const m = /^\/object_info\/(.+)$/.exec(req.url || "");
    if (!m) { res.statusCode = 404; res.end("{}"); return; }
    const cls = decodeURIComponent(m[1]);
    // EXACTLY ComfyUI 0.32.0: 200 either way, body empty when unknown.
    const out = {};
    if (installed.indexOf(cls) !== -1) out[cls] = { input: {}, output: [] };
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    cb(server, { isHttps: false, host: "127.0.0.1", port: port,
                 label: "127.0.0.1:" + port });
  });
}

function run(steps, done) {
  let i = 0;
  (function next() {
    if (i >= steps.length) { done(); return; }
    steps[i++](next);
  })();
}

// The owner's machine: every pack the template names is registered.
const ALL_INSTALLED = OPTIONALS.map((o) => o["class"])
  .concat(["CreateVideo", "PrimitiveFloat"]);
// A bare ComfyUI: core only. PrimitiveFloat is core, which is the whole
// reason it can stand in for ComfyLiterals' Float.
const CORE_ONLY = ["CreateVideo", "PrimitiveFloat"];

fakeComfy(ALL_INSTALLED, (server, base) => {
  run([
    // ---------------------------------------------------- classInstalled
    (next) => {
      Comfy.classInstalled(base, "RTXVideoSuperResolution", (err, present) => {
        assert(!err && present === true,
               "classInstalled: a registered class reads as installed");
        next();
      });
    },
    (next) => {
      Comfy.classInstalled(base, "NoSuchNodeKJ", (err, present) => {
        assert(!err && present === false,
               "THE TRAP: an unknown class answers 200 with {} and must " +
               "read as NOT installed (got " + present + ")");
        next();
      });
    },
    // ------------------------------------------- resolveOptionalNodes
    (next) => {
      const g = template();
      const applied = [];
      Comfy.resolveOptionalNodes(base, g, manifest, applied, (err) => {
        assert(!err, "installed: resolveOptionalNodes succeeds");
        assert(!!g["168"], "and KEEPS the node when the pack is present");
        const said = applied.join(" | ");
        assert(/is installed, keeping it/.test(said),
               "saying so: " + said);
        assert(said.indexOf("1920x1080") !== -1,
               "and surfacing the manifest's keptNote about the fixed " +
               "output size, which silently overrides the injected " +
               "megapixels: " + said);
        next();
      });
    },
    (next) => {
      // when:"always" must not consult the server at all.
      const g = template();
      const m = JSON.parse(JSON.stringify(manifest));
      m.optionalNodes[rtxAt].when = "always";
      const applied = [];
      Comfy.resolveOptionalNodes(base, g, m, applied, (err) => {
        assert(!err && !g["168"],
               "when:'always' bypasses even though the class IS installed");
        assert(/manifest says always/.test(applied.join(" ")),
               "and says that is why: " + applied.join(" | "));
        next();
      });
    },
    (next) => {
      // Sidecar/template drift: bypassing by id alone would delete whatever
      // node inherited that id.
      const g = template();
      const m = JSON.parse(JSON.stringify(manifest));
      m.optionalNodes[rtxAt]["class"] = "SomeOtherClass";
      Comfy.resolveOptionalNodes(base, g, m, [], (err) => {
        assert(err && /is a RTXVideoSuperResolution/.test(err.message),
               "a manifest naming the wrong class for that id is FATAL: " +
               (err && err.message));
        assert(!!g["168"], "and the graph is left alone");
        next();
      });
    },
    (next) => {
      const g = template();
      delete g["168"];
      const applied = [];
      Comfy.resolveOptionalNodes(base, g, manifest, applied, (err) => {
        assert(!err && /already absent/.test(applied.join(" ")),
               "a node an earlier step already removed is noted, not fatal");
        next();
      });
    },
    (next) => {
      const g = template();
      Comfy.resolveOptionalNodes(base, g, { }, [], (err) => {
        assert(!err && !!g["168"],
               "a manifest with no optionalNodes is a no-op");
        next();
      });
    }
  ], () => {
    server.close(() => afterInstalled());
  });
});

// The half that matters on a machine WITHOUT the NVIDIA SDK.
function afterInstalled() {
  fakeComfy(CORE_ONLY, (server, base) => {
    const g = template();
    const feeder = String(g["168"].inputs.images[0]);
    const applied = [];
    const modelFeeder = String(g["153"].inputs.model[0]);
    Comfy.resolveOptionalNodes(base, g, manifest, applied, (err) => {
      assert(!err, "not installed: resolveOptionalNodes still succeeds");
      assert(!g["168"],
             "and the node is BYPASSED on a machine without the pack");
      const said = applied.join(" | ");
      assert(/not installed on this ComfyUI/.test(said),
             "the reason is recorded: " + said);
      assert(said.indexOf("NVIDIA") !== -1,
             "including the manifest's reason, so a user who wonders why " +
             "their output is not upscaled can find out");

      // THE bare-machine result: nothing but core is left, and the graph
      // still hangs together. This is the assertion the 2026-08-27 scan
      // could not make, because no rule existed to make it about.
      const core = (manifest.customNodes || [])
        .filter((e) => e.pack === "(comfy-core)")
        .reduce((s, e) => s.concat(e.nodes || []), []);
      const left = [...new Set(Object.keys(g).map((k) => g[k].class_type))]
        .filter((c) => core.indexOf(c) === -1);
      assert(left.length === 0,
             "every custom-pack node is gone from the bare graph" +
             (left.length ? " — STILL THERE: " + left.join(", ") : ""));

      // The four model patches sat in a CHAIN (148 -> 153 -> 163 -> 164 ->
      // 165 -> 162 -> 139). Bypassing them one at a time must collapse the
      // chain, not leave a link pointing at a node that no longer exists.
      ["153", "164", "165", "162", "160", "159"].forEach((id) => {
        assert(!g[id], "optional node " + id + " is gone");
      });
      assert(String(g["163"].inputs.model[0]) === modelFeeder,
             "SigmaShift (core) now reads the loader directly (" +
             JSON.stringify(g["163"].inputs.model) + ")");
      assert(String(g["139"].inputs.model[0]) === "163",
             "and BasicGuider reads SigmaShift, the chain having collapsed " +
             "through four separate bypasses (" +
             JSON.stringify(g["139"].inputs.model) + ")");
      assert(String(g["134"].inputs.images[0]) === "132",
             "the image path collapses past cleanGpuUsed AND the upscaler " +
             "straight to VAEDecode (" +
             JSON.stringify(g["134"].inputs.images) + ") — " + feeder +
             " was itself bypassed");

      // The value source could not be bypassed, so it was swapped instead.
      assert(g["167"] && g["167"].class_type === "PrimitiveFloat" &&
             g["167"].inputs.value === 0.98,
             "and the megapixel source is core PrimitiveFloat carrying 0.98");
      assert(/substituted optional node 167/.test(said),
             "recorded as a substitution, not a bypass: " + said);

      // Nothing may point at a node that is no longer in the graph — the
      // failure mode a POST would only reveal after validation.
      const dangling = [];
      Object.keys(g).forEach((k) => {
        Object.keys(g[k].inputs || {}).forEach((ik) => {
          const v = g[k].inputs[ik];
          if (Array.isArray(v) && !g[String(v[0])]) {
            dangling.push(k + "." + ik + " -> " + v[0]);
          }
        });
      });
      assert(dangling.length === 0,
             "no dangling link survives the collapse" +
             (dangling.length ? " [" + dangling.join(", ") + "]" : ""));

      server.close(() => substituteMissing());
    });
  });
}

// A substitute is only an answer if the REPLACEMENT is installed. Trading
// one missing class for another must be caught here, before the POST —
// otherwise the user pays for the round trip to learn the same thing.
function substituteMissing() {
  fakeComfy(["CreateVideo"], (server, base) => {
    const g = template();
    Comfy.resolveOptionalNodes(base, g, manifest, [], (err) => {
      assert(err && /neither is the manifest's substitute/.test(err.message),
             "a substitute class that is ALSO missing is a grounded error: " +
             (err && err.message));
      assert(err && err.message.indexOf("PrimitiveFloat") !== -1 &&
             err.message.indexOf("Float") !== -1,
             "naming both classes so the user knows what to install");
      server.close(() => bothRules());
    });
  });
}

// passthrough and substitute are different answers to the same question.
// A manifest that sets both has not decided, and picking one silently
// would render something nobody chose.
function bothRules() {
  fakeComfy(["CreateVideo", "PrimitiveFloat"], (server, base) => {
    const g = template();
    const m = JSON.parse(JSON.stringify(manifest));
    const at = m.optionalNodes.map((o) => o["class"]).indexOf("Float");
    m.optionalNodes[at].passthrough = "Number";
    Comfy.resolveOptionalNodes(base, g, m, [], (err) => {
      assert(err && /both "passthrough" and "substitute"/.test(err.message),
             "a manifest setting both is refused: " + (err && err.message));
      assert(g["167"].class_type === "Float", "graph untouched");
      server.close(() => unreachable());
    });
  });
}

// A server that is not there must be a grounded error, not a silent
// "assume it is missing" — bypassing on a network blip would quietly
// change what the user renders.
function unreachable() {
  const base = { isHttps: false, host: "127.0.0.1", port: 1,
                 label: "127.0.0.1:1" };
  Comfy.classInstalled(base, "RTXVideoSuperResolution", (err) => {
    assert(err && /unreachable/.test(err.message),
           "an unreachable ComfyUI is a grounded error: " +
           (err && err.message));
    const g = template();
    Comfy.resolveOptionalNodes(base, g, manifest, [], (err2) => {
      assert(err2, "and it stops the run rather than guessing");
      assert(!!g["168"], "leaving the graph untouched");
      kreaBare();
    });
  });
}

// The whole KREA2 template on a machine with none of its three packs. This
// is the stub half of the real --bare render: five rules, two of them shapes
// the H3 template never exercised (a slot map, and a substitute whose target
// is nowhere in the graph).
function kreaBare() {
  const kCore = (kManifest.customNodes || [])
    .filter((e) => e.pack === "(comfy-core)")
    .reduce((acc, e) => acc.concat(e.nodes || []), []);
  fakeComfy(kCore, (server, base) => {
    const g = kTemplate();
    const applied = [];
    const modelSrc = String(g["604"].inputs.model[0]);
    const clipSrc = String(g["604"].inputs.clip[0]);
    const promptSrc = String(g["601"].inputs.any_02[0]);
    Comfy.resolveOptionalNodes(base, g, kManifest, applied, (err) => {
      assert(!err, "KREA2 resolves on a bare ComfyUI: " + (err && err.message));

      const left = [...new Set(Object.keys(g).map((k) => g[k].class_type))]
        .filter((c) => kCore.indexOf(c) === -1);
      assert(left.length === 0,
             "no custom-pack class survives" +
             (left.length ? " - STILL THERE: " + left.join(", ") : ""));

      assert(String(g["267"].inputs.text[0]) === promptSrc &&
             String(g["280"].inputs.text[0]) === promptSrc,
             "both text encoders read the manual-prompt primitive directly, " +
             "the Any Switch having collapsed (" +
             JSON.stringify(g["267"].inputs.text) + ")");
      assert(String(g["264"].inputs.model[0]) === modelSrc &&
             String(g["267"].inputs.clip[0]) === clipSrc &&
             modelSrc !== clipSrc,
             "MODEL and CLIP land on their OWN loaders across the lora " +
             "loader's two output slots");

      // The upscale is the one rule that had to be a substitution: dropping
      // it would run the second pass at the first pass's size and save an
      // image 1.6x smaller than the graph promises, silently.
      assert(g["476"] && g["476"].class_type === "LatentUpscaleBy",
             "SesquiLatentUpscale is SWAPPED for core LatentUpscaleBy, not " +
             "bypassed (" + (g["476"] && g["476"].class_type) + ")");
      assert(g["476"].inputs.scale_by === 1.6,
             "carrying the authored 1.6x scale (" +
             JSON.stringify(g["476"].inputs.scale_by) + ")");
      assert(g["476"].inputs.upscale_method === "bislerp",
             "with the const method the manifest names");
      assert(!("model_format" in g["476"].inputs) &&
             !("half_precision" in g["476"].inputs),
             "and Sesqui's own widgets dropped - an inherited stray key " +
             "fails validation at the server");
      assert(String(g["450"].inputs.latent_image[0]) === "476",
             "the second sampler still reads node 476, same id, same socket");

      const dangling = [];
      Object.keys(g).forEach((k) => {
        Object.keys(g[k].inputs || {}).forEach((ik) => {
          const v = g[k].inputs[ik];
          if (Array.isArray(v) && !g[String(v[0])]) {
            dangling.push(k + "." + ik + " -> " + v[0]);
          }
        });
      });
      assert(dangling.length === 0,
             "no dangling link survives" +
             (dangling.length ? " [" + dangling.join(", ") + "]" : ""));

      server.close(() => {
        console.log(failures ? "\n" + failures + " FAILED"
                             : "\nall optional-node tests passed");
        process.exitCode = failures ? 1 : 0;
      });
    });
  });
}
