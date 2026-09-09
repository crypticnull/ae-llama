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
 * template a buyer got could not render at all.
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
 * buyer's render. */
const krea = templates.filter((t) => /KREA2/i.test(t.file))[0];
ok(!!krea, "the KREA2 template is present");
if (krea) {
  const n278 = krea.graph["278"];
  ok(n278 && n278.class_type === "KSamplerSelect",
    "KREA2 node 278 is still the KSamplerSelect this regression is about");
  ok(n278 && n278.inputs.sampler_name !== "res_2s",
    "KREA2 node 278 is not back on res_2s — that is a RES4LYF value the " +
    "shipped backend does not have, and it stops the graph at validation. " +
    "The manifest's panelAdaptation.setInputs is where the substitution " +
    "lives; re-run scripts/adapt-workflow.js after any re-export");
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
