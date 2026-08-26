/*
 * test-comfy-optional-nodes.js — nodes a bundled template can run WITHOUT.
 *
 * The H3 i2v template ends in RTXVideoSuperResolution, which ships in
 * comfyui_nvidia_rtx_nodes and needs the NVIDIA app's video SDK. It
 * registers on some machines and not others, so a template that hard-requires
 * it fails validation on every machine without the SDK — including, one day,
 * a customer's. The manifest's `optionalNodes` block says which nodes may be
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

const TEMPLATE = path.join(REPO, "extension", "comfy-workflows",
                           "AE_LLAMA_H3_I2V_V1.json");
const MANIFEST = path.join(REPO, "extension", "comfy-workflows",
                           "AE_LLAMA_H3_I2V_V1.manifest.json");
const template = () => JSON.parse(fs.readFileSync(TEMPLATE, "utf8"));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

// ------------------------------------------------- the shipped template

const g0 = template();
assert(g0["168"] && g0["168"].class_type === "RTXVideoSuperResolution",
       "the shipped template still ends in RTXVideoSuperResolution at 168");
const entry = (manifest.optionalNodes || [])[0] || {};
assert(String(entry.nodeId) === "168" &&
       entry["class"] === "RTXVideoSuperResolution" &&
       entry.passthrough === "images",
       "and the manifest marks it optional, passing through 'images'");
assert(Array.isArray(g0["168"].inputs[entry.passthrough]),
       "whose 'images' input really is a LINK, so there is something to " +
       "rewire consumers to");

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

fakeComfy(["RTXVideoSuperResolution", "CreateVideo"], (server, base) => {
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
      m.optionalNodes[0].when = "always";
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
      m.optionalNodes[0]["class"] = "SomeOtherClass";
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
  fakeComfy(["CreateVideo"], (server, base) => {
    const g = template();
    const feeder = String(g["168"].inputs.images[0]);
    const applied = [];
    Comfy.resolveOptionalNodes(base, g, manifest, applied, (err) => {
      assert(!err, "not installed: resolveOptionalNodes still succeeds");
      assert(!g["168"],
             "and the node is BYPASSED on a machine without the pack");
      assert(String(g["134"].inputs.images[0]) === feeder,
             "CreateVideo reads straight from " + feeder + " instead");
      const said = applied.join(" | ");
      assert(/not installed on this ComfyUI/.test(said),
             "the reason is recorded: " + said);
      assert(said.indexOf("NVIDIA") !== -1,
             "including the manifest's reason, so a user who wonders why " +
             "their output is not upscaled can find out");
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
      console.log(failures ? "\n" + failures + " FAILED"
                           : "\nall optional-node tests passed");
      process.exitCode = failures ? 1 : 0;
    });
  });
}
