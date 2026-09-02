# AE Llama — agent briefing

Commercial After Effects CEP panel ("AE Llama") that drives AE via a local
llama.cpp model + tool-calling, with a hidden ComfyUI backend for image/
video generation. Windows 11 + AE 2024+ (field-tested on AE 2026).

## Two agents, two roles

- **Remote session** (claude.ai/code): builds features, owns minor/major
  version bumps and the merges into `main`, reviews what the local
  session pushes.
- **Local session** (this machine, has real After Effects): its superpower
  is RUNNING the panel's tool suite inside real AE and reporting/fixing
  what the stubs can't see. It ships its own verified fixes — patch bump,
  push, done — without waiting for the remote session or the human.

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
   Drives AfterFX.exe through the panel's 39-step suite in a scratch comp
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
- **`instanceof AVLayer` is NOT "is this a visual layer".** Measured AE
  2026: it is FALSE for a TextLayer and a ShapeLayer as well as for a
  camera and a light — only a plain solid/footage layer answers true.
  Test the specific class (`AELL_layerType`) instead. Cameras and lights
  also carry no `setTrackMatte`/`removeTrackMatte` at all, yet
  `camera.trackMatteType = LUMA` is ACCEPTED silently and reads back
  5015, so a matte tool that only try/catches AE sees success on a layer
  AE will never matte.
- **`trackMatteType` is not "does this layer have a matte".** Measured
  AE 2026: NO_TRACK_MATTE is **5012** (a fresh layer reads 5012, not 0),
  ALPHA 5013, ALPHA_INVERTED 5014, LUMA 5015, LUMA_INVERTED 5016 — and
  **`removeTrackMatte()` clears `trackMatteLayer` but LEAVES
  `trackMatteType` at the type it just removed**, forever. So the matte
  LAYER is the only honest existence test; the type only says what KIND,
  once there is one. `AELL_matteLayerOf` / `AELL_matteWord` are the one
  place this is read. A type-only read is wrong in both directions, which
  is how `scripts/chat-probe.js` shipped a step that called every
  unmatted layer matted AND failed a matte AE really made.
- Adding any layer selects it and deselects everything else; creation
  tools here restore the user's selection (`AELL_keepSelection`).
- `.jsx` is ES3: no JSON (use `AELLJSON`), no Array extras, no `const`.
- **ExtendScript parses `?:` LEFT-associatively.** `true ? 1 : true ? 2
  : 3` is **2** there and 1 everywhere else; `false ? 1 : true ? 2 :
  true ? 3 : 4` is **3**, not 2. It groups as `((a?b:c)?d:e)?f:g`, so
  the first branch's VALUE becomes the next condition. Every nested
  conditional in an ES3-executed file needs explicit parentheses —
  `tests/test-es3-ternary.js` enforces it. A bare chain is only
  accidentally right when the earlier tests are false, which is why it
  hid: it shipped a `reorder_layers` warning on correct moves and told
  empty SHAPE layers "the text is empty". Measured AE 2026 /
  ExtendScript 4.5.6. This binds `extension/js/selftest.js` too — the
  CLI runner `$.evalFile`s it.
- `.ps1` must be pure ASCII (Windows PowerShell 5.1, BOM-less).
- **`$.fileName` inside a CEP `ScriptPath` names the HOST's folder**,
  not the script's own. Measured AE 26.3 / CEP 12.0.1: it returned
  `C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\`, so a
  ScriptPath file cannot resolve its siblings and a "branch then
  evalFile the right body" loader does not work. Load host code the way
  `main.js` always has: from the PANEL, with the absolute path from
  `getSystemPath("extension")`.
- **An XML comment may not contain `--` or end with `-`** (XML 1.0
  §2.5), and CEP reports a manifest parse error NOWHERE a user can see:
  the extension is just absent from Window > Extensions, which looks
  exactly like a rejected manifest shape or HostList. Measured
  2026-09-02: all four probe manifests shipped with `--` used as a dash,
  and the failure was misdiagnosed as "Adobe rejects this manifest
  shape" before `scripts/probe-doctor.ps1` read the real reason.
  `tests/test-manifest-xml.js` now refuses unparseable XML repo-wide.
- Every failed lookup must list what actually exists (grounded errors) —
  it is how the small local model self-corrects.
- **Context is a functional resource. Function over conversation**
  (owner, 2026-09-01). The system prompt + tool docs + state + results
  + history share one window (default ctx 16384), and when it
  overflows the panel drops HISTORY — refer-back turns break, which is
  function loss. Every prompt/doc addition must be measured
  (buildSystemPrompt().length before/after) and paid for by a cut;
  rules carry phrase lists, docs carry one phrase; the model's replies
  are receipts, not prose. See WORKPLAN roadmap item 13.
- Premiere has no `AfterFX -r` equivalent, and its script platform is
  being retired: Adobe's doc sources say Premiere ExtendScript is
  supported "through September 2026" and CEP "for a calendar year"
  after 25.6 (~Nov 2026), new work goes to UXP (no child_process,
  `.ccx` packaging, no AE host). A CEP Premiere panel is a bridge, not
  a destination — read `docs/PREMIERE_PLAN.md` before building
  anything Premiere-side. Owner-gated (WORKPLAN section 12).

## Shipping (BUMP OR IT DOES NOT SHIP)

CI runs on every push to `main` AND `claude/**`, and the feed-publish
step has no branch condition — so **a push to the dev branch already
ships**. Merging to `main` is bookkeeping; it gates nothing.

The one real gate is the version. The panel updates only when
`compareVersions(feed.panelVersion, VERSION) > 0`, so an unbumped push
reaches the repo and never reaches a panel. Do not treat "merged" as
"shipped" — that mistake left a whole day of fixes sitting in `main`
while the installed panel ran the old code.

    node scripts/bump-version.js patch     # one command, all four files

**The local session bumps PATCH itself** whenever it pushes a fix it has
verified in real AE. That is the whole point: a fix you proved works
should reach the panel without waiting on anyone. The remote session
owns MINOR/MAJOR (feature sets, anything needing release notes) and the
merges into `main`, which can be batched whenever.

Model identity strings must never appear in committed artifacts.

## Layout

- `extension/jsx/hostscript.jsx` — ALL AE-side tools (`AELL_TOOLS`), ES3
- `extension/js/tools.js` — tool docs + system prompt + panel-side tools
- `extension/js/{main,llama,comfy,setup,settings,visualizer,selftest}.js`
- `tests/` — stubbed-AE regression suites (stubs model REAL AE quirks —
  keep them faithful, e.g. padded value arrays)
- `docs/NATIVE_COVERAGE_PLAN.md` — the tool-coverage roadmap
- `docs/CAPABILITIES.md` — the whole product in one place; tool table is
  GENERATED (`node scripts/capability-report.js`, CI-enforced fresh).
  Check it before building any tool; update the curated half when you
  ship anything user-visible.
