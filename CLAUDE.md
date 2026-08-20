# AE Llama — agent briefing

Commercial After Effects CEP panel ("AE Llama") that drives AE via a local
llama.cpp model + tool-calling, with a hidden ComfyUI backend for image/
video generation. Windows 11 + AE 2024+ (field-tested on AE 2026).

## Two agents, two roles

- **Remote session** (claude.ai/code): builds features, ships releases,
  manages PRs/merges into `main`, publishes the auto-update feed via CI.
- **Local session** (this machine, has real After Effects): its superpower
  is RUNNING the panel's tool suite inside real AE and reporting/fixing
  what the stubs can't see. If both are active, coordinate through the
  human: local verifies + commits small fixes; remote ships releases.

Development branch: `claude/ae-plugin-llama-cpp-f13g3x`. The remote
session periodically force-resets this branch onto `main` after merges
(with lease — it will not clobber unseen pushes, but pull before you
start). Never push tags (branch-scoped credentials reject them).

## Working the backlog

`docs/WORKPLAN.md` is the queue; `docs/WORKPLAN-LOG.md` is what has
already been done. Read the log FIRST — an unattended pass is a fresh
session with no memory of the previous one, and the log is the only
thing carrying state across passes. Append an entry before you stop,
even when the pass accomplished nothing (say why).

For long unattended runs the human starts `scripts/run-local-agent.ps1`,
which loops: pull -> one headless pass -> commit -> repeat. A plain
interactive session does NOT self-start; it answers one prompt and waits.

## Verify changes

1. **Stubbed suite (fast, no AE):** `node tests/test-<name>.js` for each
   file, or all of them — CI runs exactly this on every push.
2. **REAL AE self-test (the one that matters):**
   `powershell -ExecutionPolicy Bypass -File scripts/run-ae-selftest.ps1`
   Drives AfterFX.exe through the panel's 24-step suite in a scratch comp
   (grid rig expressions, padded-dims eases, batch keys, masks, shape
   contents, effects, mattes, parenting) and prints PASS/FAIL. Exit 0 =
   green. Needs AE's "Allow Scripts to Write Files and Access Network"
   preference. The same steps power the panel's Settings -> "Run
   self-test" button; both reuse `extension/js/selftest.js`, so add new
   coverage THERE and both runners get it.
3. To exercise a single tool in real AE, generate a temp `.jsx` that
   `$.evalFile`s `extension/jsx/hostscript.jsx` and calls
   `$.global.AELL_call("<tool>", "<json args>")`, run it with
   `AfterFX.exe -r <file.jsx>`, and write results to a temp file
   (ExtendScript has no stdout).

## Hard-won AE facts (do not relearn these the painful way)

- The SCRIPTING API pads 2D layers' Position/Anchor/Scale values to 3
  components (`[x, y, 0]`), but the EXPRESSION engine sees 2 dims there —
  `value[2]` in an expression on a 2D layer is an out-of-range subscript.
  3D-ness comes from `layer.threeDLayer`, never from `value.length`.
- `setTemporalEaseAtKey` wants ease arrays matching the PADDED scripting
  dims (3 for Scale on 2D layers) — the opposite rule from expressions.
- Generated expressions use only the inline chained pickwhip form
  (`thisComp.layer("X").effect("Y")(1)`), no stored Property refs.
- Adding any layer selects it and deselects everything else; creation
  tools here restore the user's selection (`AELL_keepSelection`).
- `.jsx` is ES3: no JSON (use `AELLJSON`), no Array extras, no `const`.
- `.ps1` must be pure ASCII (Windows PowerShell 5.1, BOM-less).
- Every failed lookup must list what actually exists (grounded errors) —
  it is how the small local model self-corrects.

## Release ritual (remote session usually does this)

Bump ALL of: `extension/CSXS/manifest.xml` (ExtensionBundleVersion AND
Extension Version), `extension/js/version.js` VERSION, `update.json`
panelVersion — `scripts/package-zxp.ps1` fails the build on mismatch.
Push -> CI builds the signed ZXP, stages the `feed` branch, syncs the
public updates repo -> installed panels auto-update and reload in place.
Model identity strings must never appear in committed artifacts.

## Layout

- `extension/jsx/hostscript.jsx` — ALL AE-side tools (`AELL_TOOLS`), ES3
- `extension/js/tools.js` — tool docs + system prompt + panel-side tools
- `extension/js/{main,llama,comfy,setup,settings,visualizer,selftest}.js`
- `tests/` — stubbed-AE regression suites (stubs model REAL AE quirks —
  keep them faithful, e.g. padded value arrays)
- `docs/NATIVE_COVERAGE_PLAN.md` — the tool-coverage roadmap
