/*
 * test-workflow-manifests.js — every node a bundled workflow uses must be
 * attributed to something that can be installed.
 *
 * A manifest is the only thing telling an installer which custom-node packs a
 * workflow needs. Until 2026-08-27 the H3 i2v manifest — the one marked
 * "attribution scanned", not a placeholder — named four packs, while the
 * template the panel actually ships used SEVEN. ComfyUI-sol-attn and
 * ComfyLiterals were simply absent, so on any machine without them the graph
 * fails to load and nothing in the repo said why. Two entries were positively
 * wrong as well: ComfyMathExpression was credited to a pack when the loader
 * reports it as core, and PlaySound was recorded under a class name
 * (`PlaySound`) that no installed pack registers.
 *
 * That bug class is invisible to a validator — ComfyUI's own validate_prompt
 * passes happily on the machine where every pack happens to be installed.
 * It is only catchable by comparing the manifest against the graph, which
 * needs no ComfyUI at all. This file does exactly that, using the same
 * enumerator scripts/attribute-workflow-nodes.js writes manifests with, so
 * the check cannot drift from the tool.
 *
 * What is NOT checked here: whether the packs exist upstream, or resolve on
 * any particular disk. That needs a running server; it is what
 * `node scripts/attribute-workflow-nodes.js` does, and its output is what
 * gets committed.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const attributor = require("../scripts/attribute-workflow-nodes.js");

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log("ok  - " + label); }
  else { failures++; console.log("FAIL- " + label); }
}

const REPO = path.join(__dirname, "..");

// Every workflow the repo bundles, authored (UI) and adapted (API) alike.
//
// The SHIPPED half is a directory WALK, not a list. A hardcoded list only
// covers what someone remembered to add to it, and WORKPLAN §18 adds a
// template per catalog entry — a graph landing in the bundle without its
// pack attribution is exactly the failure this file exists for (the H3
// manifest once named four packs while the graph used seven, and the
// graph simply would not load on a machine lacking the other three).
//
// The AUTHORED half stays an explicit list: those are the owner's own UI
// exports, they do not all ship (H3_R2V_V1 has no API counterpart), and
// under the §18 reframe they are a personal layer rather than a set that
// grows with the product.
const AUTHORED = [
  ["extension/workflows/AE_LLAMA_KREA2_V1.json", "authored"],
  ["extension/workflows/AE_LLAMA_H3_R2V_V1.json", "authored"],
  ["extension/workflows/AE_LLAMA_H3_I2V_V1.json", "authored"]
];

const SHIPPED_DIR = "extension/comfy-workflows";
const SHIPPED = fs.readdirSync(path.join(REPO, SHIPPED_DIR))
  .filter((n) => /\.json$/i.test(n))
  .filter((n) => !/\.manifest\.json$/i.test(n))
  .filter((n) => n.charAt(0) !== ".")
  // The format example carries the CHANGE-ME placeholder and can never
  // render, so it has no packs to attribute.
  .filter((n) => fs.readFileSync(
    path.join(REPO, SHIPPED_DIR, n), "utf8").indexOf("CHANGE-ME") === -1)
  .sort()
  .map((n) => [SHIPPED_DIR + "/" + n, "shipped"]);

const PAIRS = AUTHORED.concat(SHIPPED);

function read(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
}

// ---------------------------------------------- the enumerator itself

{
  const krea = attributor.classesOf(
    path.join(REPO, "extension/workflows/AE_LLAMA_KREA2_V1.json"));
  // KREA2's UNETLoader/VAELoader/CLIPLoader live ONLY inside the "Initial
  // Loader" subgraph. A walk that stops at the top level sees a bare UUID
  // node type and misses three real dependencies.
  assert(krea.indexOf("UNETLoader") !== -1 &&
         krea.indexOf("VAELoader") !== -1 &&
         krea.indexOf("CLIPLoader") !== -1,
         "subgraph inner nodes count as dependencies");
  assert(!krea.some((c) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(c)),
         "the subgraph container UUID is not reported as a node class");

  // Moved out of the bundle by WORKPLAN 18 P9 (tests/fixtures/authored-h3/
  // README.md says why); still the repo's richest API-format graph.
  const api = attributor.classesOf(
    path.join(REPO, "tests/fixtures/authored-h3/AE_LLAMA_H3_I2V_V1.json"));
  assert(api.indexOf("SaveVideo") !== -1,
         "API-format graphs are enumerated by class_type");
}

// ---------------------------------------------- per-workflow invariants

PAIRS.forEach(function ([rel, kind]) {
  const name = path.basename(rel);
  const mfRel = rel.replace(/\.json$/, ".manifest.json");
  let manifest;
  try { manifest = read(mfRel); }
  catch (e) { assert(false, name + ": manifest reads (" + e.message + ")"); return; }

  // classesFor, not classesOf: a class an optionalNodes rule SUBSTITUTES in
  // is a real dependency of the shipped template and appears nowhere in the
  // graph, so a walk of nodes alone would call it a stale declaration and
  // demand its removal — leaving check 7 nothing to check against.
  const used = attributor.classesFor(path.join(REPO, rel));
  const entries = manifest.customNodes || [];
  const virtual = manifest.frontendOnly || [];

  assert(Array.isArray(manifest.customNodes),
         name + ": has a customNodes array");

  // 1. The placeholder that stood in for two days must never come back.
  assert(!entries.some((e) => /UNKNOWN/i.test(String(e.pack || ""))),
         name + ": no UNKNOWN pack placeholder");

  // 2. Declared exactly once, and only where it belongs.
  const declaredBy = new Map();
  let dupes = [];
  entries.forEach(function (e) {
    (e.nodes || []).forEach(function (n) {
      if (declaredBy.has(n)) dupes.push(n);
      declaredBy.set(n, e.pack);
    });
  });
  virtual.forEach(function (v) {
    if (declaredBy.has(v.type)) dupes.push(v.type);
    declaredBy.set(v.type, "(frontend-only)");
  });
  assert(dupes.length === 0,
         name + ": no class declared twice" +
         (dupes.length ? " [" + dupes.join(", ") + "]" : ""));

  const packs = entries.map((e) => String(e.pack));
  assert(new Set(packs).size === packs.length,
         name + ": no duplicate pack entries");

  // 3. THE invariant: nothing the graph uses is undeclared.
  const missing = used.filter((c) => !declaredBy.has(c));
  assert(missing.length === 0,
         name + ": every node class is attributed" +
         (missing.length ? " — UNDECLARED: " + missing.join(", ") : ""));

  // 4. …and nothing declared is stale. A pack listed for a node the graph
  //    dropped makes an installer fetch what nobody needs.
  const usedSet = new Set(used);
  const stale = [...declaredBy.keys()].filter((c) => !usedSet.has(c));
  assert(stale.length === 0,
         name + ": no stale declarations" +
         (stale.length ? " — NOT IN GRAPH: " + stale.join(", ") : ""));

  // 5. A pack without a repo cannot be installed, so it is not attribution.
  const repoless = entries
    .filter((e) => e.pack !== "(comfy-core)")
    .filter((e) => !/^https?:\/\/\S+$/.test(String(e.repo || "")))
    .map((e) => e.pack);
  assert(repoless.length === 0,
         name + ": every non-core pack carries a repo URL" +
         (repoless.length ? " [" + repoless.join(", ") + "]" : ""));

  // 6. Core is core: a pack entry claiming a class the loader ships would
  //    send an installer chasing a dependency that does not exist.
  const core = entries.find((e) => e.pack === "(comfy-core)");
  assert(core && (core.nodes || []).length > 0,
         name + ": core nodes are listed under (comfy-core)");

  // 7. optionalNodes must describe THIS graph. A bypass rule pointing at a
  //    class the template no longer holds silently stops protecting anything.
  (manifest.optionalNodes || []).forEach(function (o) {
    assert(usedSet.has(o.class),
           name + ": optionalNodes class " + o.class + " is in the graph");
    assert(declaredBy.has(o.class),
           name + ": optionalNodes class " + o.class + " is attributed");
  });

  // 8. Provenance. An attribution with no scan date behind it is a guess,
  //    and a guess is what put the wrong packs in this file to begin with.
  assert(/^\d{4}-\d{2}-\d{2}/.test(String(manifest.nodeAttributionScannedOn || "")),
         name + ": records when the attribution was scanned");

  // 9. PORTABILITY, and only for the templates the panel actually POSTS.
  //    Attribution answered "which packs does this need"; the answer for the
  //    shipped H3 template was SEVEN, six of them hard-required — so it ran
  //    on the machine it was authored on and nowhere else, and nothing in
  //    this file said so. A shipped template must be loadable on a bare
  //    ComfyUI: every non-core class needs a rule for removing it.
  //    Authored-only templates are exempt until they are adapted; that
  //    conversion is where the rules get written.
  if (kind === "shipped") {
    const coreNodes = new Set((core && core.nodes) || []);
    const optional = manifest.optionalNodes || [];
    const ruledFor = new Map(optional.map((o) => [o["class"], o]));
    const hard = used.filter((c) => !coreNodes.has(c) && !ruledFor.has(c) &&
                                    !virtual.some((v) => v.type === c));
    assert(hard.length === 0,
           name + ": every non-core class can be removed on a machine " +
           "without its pack" +
           (hard.length ? " — HARD-REQUIRED: " + hard.join(", ") : ""));

    optional.forEach(function (o) {
      const hasRule = !!o.passthrough || !!o.substitute;
      assert(hasRule,
             name + ": optionalNodes " + o["class"] + " says HOW to remove " +
             "it (passthrough or substitute)");
      assert(!(o.passthrough && o.substitute),
             name + ": optionalNodes " + o["class"] + " picks ONE of " +
             "passthrough / substitute");
      if (o.substitute) {
        // A substitute pointing at another custom class would trade one
        // missing pack for another.
        assert(coreNodes.has(o.substitute["class"]),
               name + ": " + o["class"] + " is substituted by a CORE class " +
               "(" + o.substitute["class"] + ")");
      }
    });

    // A pack every one of whose classes is removable is an optional pack.
    // Saying so in the entry is what an installer would read.
    entries.filter((e) => e.pack !== "(comfy-core)").forEach(function (e) {
      const allRuled = (e.nodes || []).every((n) => ruledFor.has(n));
      if (!allRuled) return;
      assert(e.optional === true,
             name + ": pack " + e.pack + " contributes only removable " +
             "classes, so it is marked optional");
    });
  }
});

// ---------------------------------------------- the specific corrections

{
  // These three pin measurements from the running loader on 2026-08-27. Each
  // replaced a claim that read entirely plausible and was wrong.
  const mf = read("tests/fixtures/authored-h3/AE_LLAMA_H3_I2V_V1.manifest.json");
  const packOf = (cls) => {
    const e = (mf.customNodes || []).find((e) => (e.nodes || []).indexOf(cls) !== -1);
    return e ? e.pack : null;
  };

  assert(packOf("ComfyMathExpression") === "(comfy-core)",
         "ComfyMathExpression is core, not ComfyUI-MiniMaxH3-FirstBlockCache");
  assert(packOf("ResolutionSelector") === "(comfy-core)",
         "ResolutionSelector is core, not ComfyUI-UtilsCollection");
  assert(packOf("PlaySound|pysssss") === "comfyui-custom-scripts" &&
         packOf("PlaySound") === null,
         "PlaySound is registered as PlaySound|pysssss — the bare name is nobody's class");

  // The two packs the shipped template needed and the manifest never named.
  assert(packOf("MiniMaxH3ScheduledSolAttentionPatch") === "ComfyUI-sol-attn",
         "the sol-attn patch node the shipped template loads is attributed");
  assert(packOf("Float") === "ComfyLiterals",
         "the ComfyLiterals Float node the shipped template loads is attributed");
}

// ---------------------------------------------- frontend-only nodes

{
  // Absent from /object_info is ambiguous — it means "the server never had
  // this class", which is correct for an annotation node and a broken install
  // for anything else. Only the known-virtual set may be filed this way.
  PAIRS.forEach(function ([rel]) {
    const name = path.basename(rel);
    const mf = read(rel.replace(/\.json$/, ".manifest.json"));
    const bad = (mf.frontendOnly || [])
      .map((v) => v.type)
      .filter((t) => !(t in attributor.KNOWN_VIRTUAL));
    assert(bad.length === 0,
           name + ": frontendOnly holds only known virtual nodes" +
           (bad.length ? " [" + bad.join(", ") + "]" : ""));
  });

  const krea = read("extension/workflows/AE_LLAMA_KREA2_V1.manifest.json");
  const types = (krea.frontendOnly || []).map((v) => v.type);
  assert(types.indexOf("Label (rgthree)") !== -1 &&
         types.indexOf("Fast Groups Bypasser (rgthree)") !== -1,
         "rgthree's canvas-only nodes are recorded as frontend-only, not as " +
         "a missing rgthree install");
}

console.log(failures === 0
  ? "\nAll workflow-manifest checks passed."
  : "\n" + failures + " check(s) FAILED.");
process.exit(failures === 0 ? 0 : 1);
