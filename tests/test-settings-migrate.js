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

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
