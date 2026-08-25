// Regression test: VRAM-tier model recommendation (version.js + setup.js).
"use strict";
const fs = require("fs");
const path = require("path");

const window = {
  AEBridge: { nodeRequire: require, getExtensionPath: () => __dirname },
  Settings: { dataRoot: () => __dirname, get: () => ({}) },
  Llama: {},
  setInterval, clearInterval, setTimeout, clearTimeout
};

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js", "version.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js", "tiers.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js", "setup.js"), "utf8"));

const cat = window.AELL.MODEL_CATALOG;
function rec(gpu) {
  const m = window.Setup.recommendModel(cat, gpu);
  return m ? m.name : null;
}
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

assert(rec({ hasNvidia: true, vramGB: 32 }).indexOf("32B") > 0,
       "32GB (5090) -> Qwen2.5 32B");
assert(rec({ hasNvidia: true, vramGB: 24 }).indexOf("32B") > 0,
       "24GB (4090/3090) -> Qwen2.5 32B (tight but fits)");
assert(rec({ hasNvidia: true, vramGB: 16 }).indexOf("14B") > 0,
       "16GB -> Qwen2.5 14B");
assert(rec({ hasNvidia: true, vramGB: 12 }).indexOf("14B") > 0,
       "12GB -> Qwen2.5 14B");
assert(rec({ hasNvidia: true, vramGB: 8 }).indexOf("7B") > 0,
       "8GB -> Qwen2.5 7B");
assert(rec({ hasNvidia: true, vramGB: 6 }).indexOf("3B") > 0,
       "6GB -> Llama 3.2 3B");
assert(rec({ hasNvidia: true, vramGB: 4 }).indexOf("3B") > 0,
       "4GB -> Llama 3.2 3B");
assert(rec({ hasNvidia: true, vramGB: 2 }).indexOf("3B") > 0,
       "2GB (nothing fits) -> lightest model, not the CPU pick");
assert(rec({ hasNvidia: false, vramGB: null }).indexOf("7B") > 0,
       "no NVIDIA GPU -> CPU default (7B)");
assert(rec({ hasNvidia: true, vramGB: null }).indexOf("7B") > 0,
       "GPU present but VRAM unknown -> safe default (7B)");
assert(window.Setup.recommendModel([], {}) === null, "empty catalog -> null");
// hosted override wins over built-in
const overridden = window.Setup.modelCatalog({ modelCatalog: [{ name: "X.gguf", sizeMB: 1, minVramGB: 1 }] });
assert(overridden.length === 1 && overridden[0].name === "X.gguf",
       "manifest modelCatalog overrides built-in list");

// vramOverrideGB flows through Setup.recommendModel via live settings:
// a 32 GB card impersonating 6 GB gets the 6 GB pick.
window.Settings.get = () => ({ vramOverrideGB: 6 });
assert(rec({ hasNvidia: true, vramGB: 32 }).indexOf("3B") > 0,
       "vramOverrideGB 6 makes a 32GB card recommend the 6GB model");
window.Settings.get = () => ({});

// The generation catalog rides the same feed mechanism.
assert(window.Setup.comfyCatalog(null).length > 0 &&
       window.Setup.comfyCatalog(null) === window.AELL.COMFY_CATALOG,
       "built-in comfyCatalog serves when the manifest has none");
const cOver = window.Setup.comfyCatalog({ comfyCatalog: [
  { name: "y", kind: "image", minVramGB: 4, sizeMB: 1 }] });
assert(cOver.length === 1 && cOver[0].name === "y",
       "manifest comfyCatalog overrides the built-in list");

// The combined first-run recommendation: one tier, both picks, honest copy.
const combo = window.Setup.recommendSetup(null,
  { hasNvidia: true, name: "RTX 4060", vramGB: 8, computeCap: 8.9 });
assert(combo.tier.id === "T3" && combo.chat &&
       combo.chat.name.indexOf("7B") > 0 &&
       combo.gen.image && combo.gen.image.name === "sdxl" &&
       combo.gen.video && combo.gen.video.name === "wan22-5b",
       "recommendSetup(8GB): T3, 7B chat, SDXL images, Wan video (got " +
       JSON.stringify({ t: combo.tier.id,
                        c: combo.chat && combo.chat.name,
                        i: combo.gen.image && combo.gen.image.name,
                        v: combo.gen.video && combo.gen.video.name }) + ")");
assert(/RTX 4060/.test(combo.copy) && /pauses chat/i.test(combo.copy),
       "…and its copy names the card and says generation pauses chat");

console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
