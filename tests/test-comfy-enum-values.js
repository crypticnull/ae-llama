#!/usr/bin/env node
/*
 * test-comfy-enum-values.js — a shipped template may not name an enum value
 * the SHIPPED backend does not have.
 *
 * The bug this exists to catch (WORKPLAN 17f, measured 2026-09-09). The KREA2
 * template's node 278 is a CORE `KSamplerSelect` whose `sampler_name` was
 * authored as `res_2s` — a value the RES4LYF custom node pack ADDS to that
 * core node's enum. The author's ComfyUI has RES4LYF; the vendor backend
 * `comfy-install.js` downloads does not, and offers 44 samplers without it.
 * ComfyUI dropped every output branch of the graph at validation, so the
 * template a user got could not render at all.
 *
 * Nothing in the repo could see it:
 *
 *   - the optional-NODE machinery (test-comfy-optional-nodes.js) checks that
 *     every class_type exists. This class does exist. What was missing was one
 *     VALUE inside it, and no node-type check can reach that.
 *   - `Comfy.missingWeights` checks weight slots and passed the template
 *     clean, which is 17g: a preflight that says "ready" about a graph
 *     ComfyUI refuses.
 *   - scripts/comfy-node-defs.json has the enums, and would have PASSED
 *     `res_2s` — it was harvested from the author's install and carries 63
 *     samplers. It is a picture of the one machine where the bug is invisible.
 *
 * So the reference here is tests/fixtures/comfy-core-enums.json, harvested by
 * scripts/harvest-core-enums.js from a VENDOR backend with no packs. Only
 * BUILD-CONSTANT enums are pinned; enums populated from the user's model
 * folders (ckpt_name, vae_name, ...) are a picture of one disk and are the
 * weight preflight's job, not this one.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const API_DIR = path.join(ROOT, "extension", "comfy-workflows");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "comfy-core-enums.json");

let passed = 0;
const failures = [];
function ok(cond, what) {
  if (cond) { passed++; return; }
  failures.push(what);
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const enums = fixture.enums || {};

/* ---------------------------------------------------------------- 1. fixture
 * A fixture that quietly went empty would make every check below vacuous, and
 * this file would keep printing PASS while checking nothing. */
ok(Object.keys(enums).length > 0,
  "the vendor enum fixture is not empty");
ok(enums.KSamplerSelect && Array.isArray(enums.KSamplerSelect.sampler_name) &&
   enums.KSamplerSelect.sampler_name.length > 10,
  "the fixture pins KSamplerSelect.sampler_name (the enum that shipped broken)");
ok(enums.KSamplerSelect &&
   enums.KSamplerSelect.sampler_name.indexOf("res_2s") === -1,
  "the fixture is from a build WITHOUT RES4LYF — it must not offer res_2s, " +
  "or it is the author's install again and proves nothing");

/* -------------------------------------------------------- 2. the real check
 * Every literal string a shipped API template sets on a pinned enum must be
 * one the vendor build offers. */
function apiTemplates() {
  return fs.readdirSync(API_DIR)
    .filter((f) => f.endsWith(".json") && !f.includes(".manifest."))
    .map((f) => ({ file: f,
                   graph: JSON.parse(
                     fs.readFileSync(path.join(API_DIR, f), "utf8")) }))
    .filter((t) => !Array.isArray(t.graph.nodes));   // skip UI exports
}

const templates = apiTemplates();
ok(templates.length > 0, "there are shipped API templates to check");

let checked = 0;
templates.forEach(function (t) {
  Object.keys(t.graph).forEach(function (id) {
    const node = t.graph[id];
    if (!node || !node.class_type || !node.inputs) return;
    const pinned = enums[node.class_type];
    if (!pinned) return;
    Object.keys(node.inputs).forEach(function (name) {
      const value = node.inputs[name];
      if (typeof value !== "string") return;         // a link, not a literal
      const options = pinned[name];
      if (!options) return;
      checked++;
      ok(options.indexOf(value) !== -1,
        t.file + " node " + id + " (" + node.class_type + ") ." + name +
        " = '" + value + "' — the shipped backend does not offer that. It " +
        "has " + options.length + ": " + options.join(", "));
    });
  });
});

ok(checked > 0,
  "at least one shipped literal was actually checked against a pinned enum");

/* ------------------------------------------------- 3. the regression itself
 * Pin the specific value, so a re-export from the author's machine that
 * reintroduces res_2s fails HERE with the story attached rather than in a
 * user's render. */
const krea = templates.filter((t) => /KREA2/i.test(t.file))[0];
ok(!!krea, "a KREA2 template is shipped");
if (krea) {
  const picks = Object.keys(krea.graph).filter(
    (id) => krea.graph[id].class_type === "KSamplerSelect");
  ok(picks.length > 0,
    "the shipped KREA2 template still chooses its sampler with a " +
    "KSamplerSelect, which is the node this regression is about — has: " +
    Object.keys(krea.graph).map((id) => krea.graph[id].class_type).join(", "));
  picks.forEach(function (id) {
    ok(krea.graph[id].inputs.sampler_name !== "res_2s",
      "shipped KREA2 node " + id + " is not on res_2s — that is a RES4LYF " +
      "value the shipped backend does not have, and it stops the graph at " +
      "validation");
  });
}

/* The AUTHORED graph is no longer shipped (WORKPLAN 18 P8 replaced the krea2
 * entry's template with the core-only AE_LLAMA_KREA2_T2I_V1), so the loop
 * above no longer reaches it — but it is still checked in, still the expected
 * output of scripts/adapt-workflow.js, and a re-export from the author's
 * machine is still the exact event that put res_2s in the repo. Pin it where
 * it lives now, or this regression quietly stops being tested. */
const AUTHORED = path.join(ROOT, "tests", "fixtures", "authored-krea2",
                           "AE_LLAMA_KREA2_V1.json");
ok(fs.existsSync(AUTHORED),
  "the authored KREA2 graph is still checked in at " + AUTHORED +
  " — see that folder's README for why it is a fixture and not a template");
if (fs.existsSync(AUTHORED)) {
  const authored = JSON.parse(fs.readFileSync(AUTHORED, "utf8"));
  const n278 = authored["278"];
  ok(n278 && n278.class_type === "KSamplerSelect",
    "authored KREA2 node 278 is still the KSamplerSelect this regression " +
    "is about");
  ok(n278 && n278.inputs.sampler_name !== "res_2s",
    "authored KREA2 node 278 is not back on res_2s. The manifest's " +
    "panelAdaptation.setInputs is where the substitution lives; re-run " +
    "scripts/adapt-workflow.js after any re-export");
}

/* --------------------------------------- 4. the guard the harvester needs
 * An install-dependent enum must never be pinned: those options are one
 * disk's files, so pinning them fails everywhere else. */
const FILEISH =
  /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|yaml|json|png|jpg|jpeg|webp|gif|bmp|tiff?|mp4|webm|mov|npy|txt)$|[\\/]/i;
Object.keys(enums).forEach(function (cls) {
  Object.keys(enums[cls]).forEach(function (name) {
    const bad = enums[cls][name].filter((o) => FILEISH.test(o));
    ok(bad.length === 0,
      cls + "." + name + " is pinned but looks install-dependent (" +
      bad.slice(0, 3).join(", ") + ") — an enum built from the harvester's " +
      "own model/input folders must be skipped, not pinned");
  });
});

/* ------------------------------------------------------------------ report */
console.log("comfy enum values: " + passed + "/" + (passed + failures.length) +
  " passed (" + checked + " shipped literal(s) against " +
  Object.keys(enums).length + " pinned class(es), vendor build " +
  fixture.comfyuiVersion + ")");
if (failures.length) {
  failures.forEach((f) => console.log("  FAIL " + f));
  process.exit(1);
}
