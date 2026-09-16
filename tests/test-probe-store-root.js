#!/usr/bin/env node
/*
 * test-probe-store-root.js — chat-probe must never run against the owner's
 * memory store (WORKPLAN §15 item 3, memory-layer-REFINED §9).
 *
 * The store is not built yet. This pins the seam it will plug into: a temp
 * root by default, removed at exit, a --store-root that is honoured but
 * refused inside the panel's data folder, and chat-probe resolving it
 * before its first measurement. No AE, no model.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PS = require(path.join(ROOT, "scripts", "lib", "probe-store-root.js"));

let failed = 0, passed = 0;
function check(ok, label, detail) {
  if (ok) { passed++; console.log("ok   - " + label); }
  else { failed++; console.log("FAIL - " + label + (detail ? "\n       " + detail : "")); }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "aell-test-psr-"));
const dataRoot = path.join(sandbox, "AppData", "AE-Llama");
fs.mkdirSync(dataRoot, { recursive: true });

try {
  // 1. Default: a fresh temp root, outside the data folder, removed at exit.
  const t = PS.resolve({ storeRoot: null, dataRoot: dataRoot },
                       { tmpdir: sandbox });
  check(t.ok && t.temp && t.from === "temp", "no flag -> temp store", JSON.stringify(t));
  check(t.ok && fs.existsSync(t.root) &&
        path.basename(t.root).indexOf(PS.TEMP_PREFIX) === 0,
        "temp root exists and carries the probe prefix");
  check(!PS.isInside(t.root, dataRoot), "temp root is not in the data folder");
  const t2 = PS.resolve({ dataRoot: dataRoot }, { tmpdir: sandbox });
  check(t2.root !== t.root, "two runs never share a temp root");
  check(/temp, removed at exit/.test(PS.describe(t, false)[0]) &&
        PS.describe(t, false)[0].indexOf(t.root) !== -1,
        "provenance names the folder and its fate");
  check(/kept \(--keep\)/.test(PS.describe(t, true)[0]), "--keep is reported");
  fs.writeFileSync(path.join(t.root, "global.json"), "{}");
  check(PS.cleanup(t, true) === false && fs.existsSync(t.root), "--keep leaves the temp root");
  check(PS.cleanup(t, false) === true && !fs.existsSync(t.root),
        "cleanup removes the temp root and what the run wrote");

  // 2. --store-root: honoured, created, never removed.
  const named = path.join(sandbox, "probe-store", "nested");
  const s = PS.resolve({ storeRoot: named, dataRoot: dataRoot });
  check(s.ok && !s.temp && s.from === "--store-root" && s.root === path.resolve(named),
        "--store-root is used as given", JSON.stringify(s));
  check(fs.existsSync(named), "--store-root is created when missing");
  check(PS.cleanup(s, false) === false && fs.existsSync(named),
        "a named root is never removed");
  check(/never removed/.test(PS.describe(s, false)[0]), "named provenance says it stays");

  // 3. Refusals: the owner's data folder, in any spelling, and a bare flag.
  for (const bad of [dataRoot, path.join(dataRoot, "memory"),
                     dataRoot.toUpperCase() + path.sep,
                     path.join(dataRoot, "..", "AE-Llama", "store")]) {
    const r = PS.resolve({ storeRoot: bad, dataRoot: dataRoot });
    check(!r.ok && /data folder/.test(r.error), "refused inside data folder: " + bad,
          JSON.stringify(r));
    check(/REFUSED/.test(PS.describe(r)[0]), "refusal is printed as REFUSED");
  }
  check(PS.resolve({ storeRoot: dataRoot + "-copy", dataRoot: dataRoot }).ok,
        "a sibling that only shares the prefix is allowed");
  for (const bare of ["", "--keep"]) {
    const r = PS.resolve({ storeRoot: bare, dataRoot: dataRoot });
    check(!r.ok && /wants a folder/.test(r.error), "bare flag refused: " + JSON.stringify(bare));
  }
  const fakeTemp = { ok: true, temp: true, root: path.join(sandbox, "not-ours") };
  fs.mkdirSync(fakeTemp.root);
  check(PS.cleanup(fakeTemp, false) === false && fs.existsSync(fakeTemp.root),
        "cleanup refuses a folder without the probe prefix");

  // 4. chat-probe wiring: parsed, resolved right after the settings origin,
  //    refused runs exit, temp cleaned at exit.
  const src = fs.readFileSync(path.join(ROOT, "scripts", "chat-probe.js"), "utf8");
  check(/require\(path\.join\(__dirname, "lib", "probe-store-root\.js"\)\)/.test(src),
        "chat-probe loads the resolver");
  check(/storeRoot: argv\.indexOf\("--store-root"\) === -1 \? null\s*: \(argValue\("--store-root"\) \|\| ""\)/.test(src),
        "a bare --store-root reaches the resolver as \"\" (refused), not null (temp)");
  const main = src.slice(src.indexOf("function main()"));
  const iOrigin = main.indexOf("reportSettingsOrigin();");
  const iStore = main.indexOf("ProbeStore.resolve(");
  const iFirst = main.indexOf("OPT.bridgeCheck");
  check(iOrigin !== -1 && iStore > iOrigin && iStore < iFirst,
        "store resolved after the settings origin, before any AE or model work");
  check(/dataRoot: Settings\.dataRoot\(\)/.test(main), "the data folder comes from Settings");
  check(/if \(!store\.ok\) process\.exit\(2\)/.test(main), "a refused store stops the probe");
  check(/process\.on\("exit", function \(\) \{ ProbeStore\.cleanup\(store, OPT\.keep\); \}\)/.test(main),
        "temp store removed at exit unless --keep");
  check(/--store-root D/.test(src.slice(0, 3000)), "usage header lists --store-root");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed) { console.log("SOME CHECKS FAILED"); process.exit(1); }
console.log("ALL CHECKS PASSED");
