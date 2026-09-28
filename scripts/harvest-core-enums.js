#!/usr/bin/env node
/**
 * harvest-core-enums.js — record what the SHIPPED backend's enums actually are.
 *
 * Why this exists, and why scripts/comfy-node-defs.json cannot do the job:
 * that file was harvested from the AUTHOR's ComfyUI, which carries custom
 * node packs. Those packs do not only ADD nodes -- they add VALUES to the
 * enums of nodes that are already core. Measured 2026-09-09: the author's
 * KSamplerSelect offers 63 samplers and the vendor portable build offers 44,
 * and the shipped KREA2 template was authored against `res_2s`, one of the 19
 * that only exist where RES4LYF is installed. ComfyUI dropped every output
 * branch of that graph at validation on the backend a user gets (WORKPLAN
 * 17f). Checking a template against comfy-node-defs.json would have passed it,
 * because that file is a picture of the one machine where the bug is invisible.
 *
 * So this harvests the same enums from a VENDOR backend -- the build
 * comfy-install.js downloads, with no packs -- into a committed fixture that
 * tests/test-comfy-enum-values.js reads with no network and no ComfyUI.
 *
 *   node scripts/comfy-install.js --boot
 *   node scripts/harvest-core-enums.js --url http://127.0.0.1:8288
 *
 * Only enums that are BUILD-CONSTANT are recorded. An enum whose options come
 * from the user's model folders (ckpt_name, lora_name, vae_name, ...) is a
 * picture of one disk, not of the build, and pinning it would fail on every
 * machine but the harvester's. Those are detected by their options looking
 * like filenames and skipped, and the skip is written into the fixture so a
 * reader can see what is NOT covered.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const API_DIR = path.join(ROOT, "extension", "comfy-workflows");
const OUT = path.join(ROOT, "tests", "fixtures", "comfy-core-enums.json");

let url = "http://127.0.0.1:8288";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--url") url = argv[++i];
  else if (argv[i] === "--out") { /* reserved */ }
}

/* A file-backed combo is a picture of one disk. Options for those carry an
 * extension or a path separator; a build-constant enum ("euler", "simple",
 * "bislerp") never does. An EMPTY list is also install-dependent by
 * definition -- a build-constant enum is never empty. */
const FILEISH =
  /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|yaml|json|png|jpg|jpeg|webp|gif|bmp|tiff?|mp4|webm|mov|npy|txt)$|[\\/]/i;
function buildConstant(options) {
  if (!Array.isArray(options) || options.length === 0) return false;
  return !options.some((o) => typeof o === "string" && FILEISH.test(o));
}

/* ComfyUI has shipped two shapes for a combo spec: the old [[...options]] and
 * the newer ["COMBO", {options: [...]}]. Read both -- a harvester that knows
 * only one silently records nothing. */
function comboOptions(spec) {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === "COMBO" && spec[1] && Array.isArray(spec[1].options)) {
    return spec[1].options;
  }
  return null;
}

function get(u) {
  return new Promise((resolve, reject) => {
    http.get(u, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(u + " -> HTTP " + res.statusCode));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

/* Every (class, input) pair the shipped API templates set a LITERAL string on.
 * A linked input is an array [nodeId, slot] and is not a value to check. */
function shippedLiterals() {
  const pairs = {};
  for (const f of fs.readdirSync(API_DIR)) {
    if (!f.endsWith(".json") || f.includes(".manifest.")) continue;
    const g = JSON.parse(fs.readFileSync(path.join(API_DIR, f), "utf8"));
    if (Array.isArray(g.nodes)) continue;          // a UI export, not API
    for (const id of Object.keys(g)) {
      const n = g[id];
      if (!n || !n.class_type || !n.inputs) continue;
      for (const k of Object.keys(n.inputs)) {
        if (typeof n.inputs[k] !== "string") continue;
        (pairs[n.class_type] = pairs[n.class_type] || new Set()).add(k);
      }
    }
  }
  return pairs;
}

(async function main() {
  const stats = await get(url + "/system_stats").catch(() => null);
  const version = (stats && stats.system && stats.system.comfyui_version) ||
    (stats && stats.comfyui_version) || null;
  // The version is what lets comfy-install.js name a stale fixture
  // (lib/enum-fixture-drift.js, WORKPLAN §17l). A fixture without one can
  // never be checked, so refuse to write it rather than record "unknown".
  if (!version) {
    throw new Error(url + "/system_stats gave no comfyui_version; not " +
      "writing a fixture whose build cannot be named");
  }
  const pairs = shippedLiterals();
  const enums = {};
  const skipped = {};
  const absentClasses = [];

  for (const cls of Object.keys(pairs).sort()) {
    let info;
    try { info = await get(url + "/object_info/" + encodeURIComponent(cls)); }
    catch (e) { info = null; }
    if (!info || !info[cls]) { absentClasses.push(cls); continue; }
    const req = (info[cls].input && info[cls].input.required) || {};
    const opt = (info[cls].input && info[cls].input.optional) || {};
    for (const name of Array.from(pairs[cls]).sort()) {
      const spec = req[name] || opt[name];
      const options = comboOptions(spec);
      if (!options) continue;                       // a free string, not an enum
      if (!buildConstant(options)) {
        (skipped[cls] = skipped[cls] || {})[name] =
          "install-dependent (" + options.length + " option(s) from this disk)";
        continue;
      }
      (enums[cls] = enums[cls] || {})[name] = options;
    }
  }

  const out = {
    _comment:
      "Build-constant enum values offered by the VENDOR ComfyUI backend " +
      "(the build scripts/comfy-install.js downloads), with NO custom node " +
      "packs. Generated by scripts/harvest-core-enums.js; read by " +
      "tests/test-comfy-enum-values.js. This is deliberately NOT " +
      "scripts/comfy-node-defs.json, which came from the author's install " +
      "and carries pack-contributed values a user does not have.",
    harvestedFrom: url,
    harvestedOn: new Date().toISOString().slice(0, 10),
    comfyuiVersion: version,
    classesNotInThisBuild: absentClasses,
    skippedInstallDependent: skipped,
    enums: enums
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");

  const n = Object.keys(enums).reduce(
    (a, c) => a + Object.keys(enums[c]).length, 0);
  console.log("wrote " + path.relative(ROOT, OUT));
  console.log("  " + n + " build-constant enum(s) across " +
    Object.keys(enums).length + " class(es)");
  console.log("  not in this build (custom nodes): " +
    (absentClasses.join(", ") || "none"));
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
