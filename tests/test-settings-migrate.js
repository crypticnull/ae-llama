// Regression test: settings.js migrations. comfyPauseLlm grew from a
// boolean to auto|always|never for the VRAM arbiter — a stored true
// must land on "auto" (the old behavior WAS pause-by-default, and auto
// still pauses whenever the fit is unprovable), a stored false keeps
// its meaning as "never".
"use strict";
const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

function loadWith(stored) {
  const window = {
    localStorage: {
      getItem: () => (stored ? JSON.stringify(stored) : null),
      setItem: () => {},
      removeItem: () => {}
    },
    AEBridge: {
      nodeRequire: (m) => (m === "fs"
        ? { existsSync: () => false, writeFileSync: () => {},
            mkdirSync: () => {} }
        : require(m)),
      getExtensionPath: () => __dirname
    }
  };
  window.window = window;
  eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                 "settings.js"), "utf8"));
  return window.Settings.get();
}

// Fresh install: the tri-state default plus the new tier fields.
{
  const s = loadWith(null);
  assert(s.comfyPauseLlm === "auto", "fresh default is 'auto'");
  assert(s.vramOverrideGB === 0, "vramOverrideGB defaults off (0)");
  assert(Array.isArray(s.comfyModelRoots) && s.comfyModelRoots.length === 0,
         "comfyModelRoots defaults to an empty list");
}

// A user upgrading from the boolean era.
{
  assert(loadWith({ comfyPauseLlm: true }).comfyPauseLlm === "auto",
         "stored true migrates to 'auto'");
  assert(loadWith({ comfyPauseLlm: false }).comfyPauseLlm === "never",
         "stored false migrates to 'never' — their opt-out survives");
}

// A user already on the tri-state keeps their exact choice.
{
  assert(loadWith({ comfyPauseLlm: "always" }).comfyPauseLlm === "always",
         "'always' survives a reload untouched");
  assert(loadWith({ comfyPauseLlm: "never" }).comfyPauseLlm === "never",
         "'never' survives a reload untouched");
}

// The older migrations still run beside the new one.
{
  const s = loadWith({ ctxSize: 8192, maxRounds: 4 });
  assert(s.ctxSize === 16384 && s.maxRounds === 6,
         "ctx 8192->16384 and rounds 4->6 upgrades still apply");
}

// ------------------------------------------------ where the values came from
//
// Field failure 2026-09-02: an unattended probe ran in the WMI-detached
// loop WITHOUT APPDATA, so dataRoot() pointed at a folder holding no
// settings.json, load() returned pure defaults, and the pass filed
// `comfyUrl: 8188` as the owner's setting. It was 8000 and had never
// been touched — two sessions then repeated the claim to the owner.
// Settings.origin() is what makes the two states tellable apart, and a
// probe that finds `saved: false` must not report the values as anyone's
// configuration.
function loadIn(env, fileContents) {
  const files = {};
  const window = {
    localStorage: { getItem: () => null, setItem: () => {},
                    removeItem: () => {} },
    AEBridge: {
      nodeRequire: (m) => {
        if (m === "process") return { env: env };
        if (m === "fs") {
          return {
            existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
            readFileSync: (p) => files[p],
            writeFileSync: () => {}, mkdirSync: () => {}
          };
        }
        return require(m);
      },
      getExtensionPath: () => path.join("X:", "ext")
    }
  };
  window.window = window;
  eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                 "settings.js"), "utf8"));
  if (fileContents) {
    files[window.Settings.origin().file] = JSON.stringify(fileContents);
    // Re-evaluate now that the file exists at the path settings.js picked.
    eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js",
                                   "settings.js"), "utf8"));
  }
  return window.Settings;
}

{
  // No APPDATA and no file: every value is a default, and origin says so.
  const S = loadIn({ USERPROFILE: path.join("X:", "home") }, null);
  const o = S.origin();
  assert(o.saved === false && o.from === "defaults",
         "with no settings file, origin() reports defaults, not a setting");
  assert(S.get().comfyUrl === "http://127.0.0.1:8188",
         "and the value handed out IS the shipped default (the number " +
         "that was misreported as the owner's port)");
  assert(typeof o.file === "string" && o.file.length > 0,
         "origin() names the file it looked for: " + o.file);
  assert(o.appdata === "",
         "and reports APPDATA missing, which is usually the cause");
}

{
  // The same machine with its real file: the saved value wins and
  // origin() calls it saved. This is the case the field report was
  // actually in.
  const S = loadIn({ APPDATA: path.join("X:", "roaming") },
                   { comfyUrl: "http://127.0.0.1:8000" });
  const o = S.origin();
  assert(o.saved === true && o.from === "file",
         "with a settings.json present, origin() reports it as saved");
  assert(S.get().comfyUrl === "http://127.0.0.1:8000",
         "and the user's own port is what comes back, never the default");
  assert(o.appdata === path.join("X:", "roaming"),
         "origin() carries the APPDATA the data root was built from");
}

{
  // localStorage is the panel's normal source and must be distinguishable
  // from both — a reinstall wipes it, which is why the file mirror exists.
  const S = loadWith({ comfyUrl: "http://127.0.0.1:9999" });
  assert(S.comfyUrl === "http://127.0.0.1:9999",
         "a localStorage value is loaded as-is");
}

// The probe harness must refuse rather than report defaults as settings.
{
  const probe = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "chat-probe.js"), "utf8");
  assert(/Settings\.origin\(\)/.test(probe),
         "chat-probe asks where the settings came from");
  assert(/refusing to probe against defaults/.test(probe),
         "and refuses when there is no settings file to measure");
  assert(/--defaults-ok/.test(probe),
         "with an explicit opt-in for measuring the shipped defaults");
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
