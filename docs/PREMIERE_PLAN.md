# Premiere in the same ZXP — feasibility and plan

Filed 2026-09-02 by the remote session, from a research + design +
adversarial-review pass (four researchers, three architects, one
synthesis, three refuters). Everything below is graded: **REPO** = read
in this repository; **ADOBE-SRC** = quoted verbatim from Adobe's own
documentation-source repositories (the research pass could not open the
rendered pages; confirm each quote once from the owner's machine in P0);
**SNIPPET** = web-search summaries only, unread pages.

## 0. The answer

**Yes — the existing `.zxp` can carry a Premiere panel.** A CEP bundle
may hold more than one `<Extension>`, each with its own `<HostList>`
(ADOBE-SRC: ExtensionManifest v7 XSD; CEP 12 Cookbook "CEP 7.0 manifest
files now support the use of a HostList specific to an extension in the
bundle"). Every CEP host scans the same per-user folder
(`%APPDATA%\Adobe\CEP\extensions`), which is exactly where
`scripts/install.ps1` junctions and `scripts/install-zxp.ps1` extracts
today (REPO). `package-zxp.ps1` stages and signs `extension/` wholesale
and CI publishes one feed with one `panelVersion` (REPO). So: add a
second `<Extension Id="com.cptk.aellama.ppro">` with
`<Host Name="PPRO">`, its own `ScriptPath`, its own menu label — same
folder, same ZXP, same signature, same installer, same updater. No CI
change.

About 80% of the panel is already host-agnostic (REPO): `llama.js`,
`comfy.js`, `setup.js`, `settings.js`, `ffmpeg.js`, `whisper.js`,
`tiers.js`, `version.js`, `mogrt-read.js`, `libs/cep-bridge.js`, the
chat loop, `executeCommands`, the context ledger and budget. What is
AE-bound: `hostscript.jsx` (100%), `TOOL_DEFS` + the system prompt,
`fetchProjectState`/`budgetState`, the self-test step list, the
visualizer, and six label strings.

**The catch — Adobe is retiring the platform this panel would run on.**

- ADOBE-SRC (docsforadobe/premiere-scripting-guide `docs/index.md`):
  "ExtendScript-based integrations are still supported, and the plan is
  for them to remain so, **through September 2026**." That is this
  month.
- ADOBE-SRC (Adobe-CEP/Samples `PProPanel/ReadMe.md`, Nov 2025): "As of
  Premiere Pro 25.6, CEP extensions to Premiere Pro have been superseded
  by UXP Extensibility. If you are starting new development, start in
  UXP. CEP extensions continue to be supported; the plan is to support
  both CEP and UXP **for a calendar year**, after which we will remove
  support for CEP extensibility." That is roughly November 2026.
- ADOBE-SRC (AdobeDocs/uxp-premiere-pro): UXP has **no child_process**
  (`launchProcess` only opens files/apps; network permission allows
  fetch/WebSocket); packaging is `.ccx`, not `.zxp`; there is **no After
  Effects UXP host**. UXP Hybrid (C++) plugins exist since 26.2; whether
  native code may spawn a process is unmeasured.
- SNIPPET: Premiere 27.0 is already in public beta; Adobe shipped a
  cloud, credit-metered **Premiere AI Assistant** public beta on
  2026-06-18 covering bins, labels, markers, transcripts and stringouts —
  the surface a "chat for Premiere" MVP would otherwise demo.

**So the honest shape is a bridge, not a second product on CEP.** Build
the cheap, durable parts now (the probe, the harness door, the MOGRT
acceptance verdict, the host seam that a UXP client would reuse) and
gate every further phase on measurement and on an editor-demand signal
the owner does not have to produce alone.

**Recommendation.** Fund P0 now (days, no AE code touched, no bump). Do
not start P2+ until WORKPLAN roadmap item 13 (function over
conversation) is closed — the owner's stated priority — and P0 has
answered G0. Decide the UXP question on a date, not on an outage.

## 1. Facts the plan rests on

REPO (verified by reading):

- `extension/CSXS/manifest.xml`: one extension, `HostList` AEFT
  `[24.0,99.9]` only, `ScriptPath ./jsx/hostscript.jsx` (auto-loaded in
  every host that lists the extension), `Menu` "AE Llama", CSXS 11.
- Nothing reads `getHostEnvironment().appName`; `main.js:285-289` and
  `:1503-1506` hard-code "After Effects".
- The panel reaches the host through exactly two evalScript strings
  (`tools.js:2612` `AELL_call`, `:3042` `AELL_callBatch`) plus
  `main.js:556` `AELL_newRequest` and `main.js:1166` `$.evalFile`.
- `TOOL_DEFS` is single-sourced; schema, prompt docs, `isKnownTool`,
  batchability and dry-run all derive from it — swapping the table per
  host is mechanical. `selftest.js run(deps)` is host-agnostic; only
  `buildSteps()` is AE.
- `scripts/bump-version.js:73-74` and `:88-89` use a NON-global
  `<Extension Version>` regex — a second entry would be left stale and
  the check would not notice. Fix this regardless of the plan.
- Two panels open at once is new state: `llama.js:205-222` refuses the
  second panel on port 8737; orphan reaping keys on per-panel
  localStorage PIDs; `Settings.set` overwrites the whole file; both
  panels auto-pull at launch.
- `docs/WORKPLAN-LOG.md` has no BridgeTalk/PPRO measurement — WORKPLAN
  section 11's probes have never run.

ADOBE-SRC (quoted; confirm once in P0):

- Premiere Pro 25.0+ runs CEP 12 (host table row `Premiere Pro | PPRO`).
- Premiere's `BridgeTalk.appName` is `"premierepro"`; the debugger
  targets `premierepro-<major>.0`. AE→Premiere delivery is unmeasured.
- Premiere ExtendScript has **no undo grouping** (zero hits for
  undo/beginUndoGroup/executeCommand in the scripting guide); UXP has
  `executeTransaction`.
- The QE DOM (effects, transitions, razor, ripple, frame export) is
  "not supported, and not at all recommended" (Adobe staff), broke in
  14.3, and is reported to silently ignore razor/ripple **and vanilla
  effect-parameter writes** on some 26.3 installs.
- No script API in either DOM creates a text/graphic clip, reads caption
  text, or reads the native transcript (UXP 26.3: `hasTranscript` only).
- Times are ticks (254016000000/s) in several calls (`createSubClip`,
  `setPlayerPosition`, `importMGT`); argument order for `createSubClip`
  is `(name, startTicks, endTicks, hasHardBoundaries, takeVideo,
  takeAudio)`.
- A long-lived Premiere ExtendScript engine can degrade under repeated
  large payloads ("InternalError: Stack overrun", observed 26.2.2 by a
  third party) after which every evalScript dies opaquely.

## 2. Architecture (when built)

**Bundle.** `manifest.xml` gains a second `<Extension
Id="com.cptk.aellama.ppro">` in both `ExtensionList` and
`DispatchInfoList`, with its own `<HostList><Host Name="PPRO"
Version="[25.0,99.9]"/></HostList>`, `MainPath ./index.html`,
`ScriptPath ./jsx/ppro-hostscript.jsx`, same CEF flags, own `Menu`. The
AE `DispatchInfo` block stays byte-identical. P0 also tries the
one-extension/two-hosts shape with a 10-line ScriptPath loader, because
that is the shape every shipped multi-host manifest found in the wild
uses; whichever installs and lists in both hosts wins. Both shapes are
validated with `xmllint` against `ExtensionManifest_v_7_0.xsd` before
install so a schema rejection is never misread as a host rejection.
`.debug` gets a PPRO entry (port 8093). `install.ps1` writes
`PlayerDebugMode` under CSXS.13/14 defensively (third-party claim, no
Adobe source; P0 records which key Premiere actually reads).
`package-zxp.ps1` and CI gain `ZXPSignCmd -verify`.

**Host adapter — the seam that survives a UXP rewrite.** New
`extension/js/host.js`, loaded right after `libs/cep-bridge.js`, the
ONLY file that reads `appName` ("AEFT" → AE; "PPRO" pinned
provisionally, any other string fails loudly). Exports `Host = {id,
label, appVersion, jsxFile, toolDefs, promptIntro, promptRules,
fetchState, budgetState, selftestSteps, hasVisualizer,
composerPlaceholder, importGenerated, exec, execBatch, newRequest}`.
`exec`/`execBatch` deliver the existing `{ok,data}|{ok,error}` envelope;
the transport (evalScript strings today, HTTP for a UXP client later)
is private. The PPRO transport re-`$.evalFile`s its jsx once on an
`EvalScript error.` and retries once before returning a grounded error.
A Node test enforces: no `$.`, `evalScript`, `AELL_` or `PPL_` outside
`host.js`, the jsx, and test shims.

**Per-host tables, shared machinery.** `tools-ae.js` takes today's
`TOOL_DEFS`, prompt intro/rules, `fetchProjectState`, `budgetState` and
the AE-bound panel tools; `tools-ppro.js` holds the Premiere table and
an editor prompt written **from a blank page** with a hard ceiling
(≤5,000 tokens against the running `/tokenize`, pinned in CI) — not a
cut of the AE prompt, which is already 11,446 tokens compact.
`tools.js` keeps `window.Tools`' surface (pinned by
`tests/test-self-test.js` and `scripts/capability-report.js`) and
derives everything from `Host.toolDefs`. A `tests/lib/load-tools.js`
loader replaces the ad-hoc evals. Zero-behaviour-change gate for AE:
sha256 of `buildSystemPrompt()` (compact and full) and of the
capability-report bytes pinned before and asserted after; real-AE
self-test 593/593.

**Premiere host layer (`ppro-hostscript.jsx`, ES3, throwaway by
design, size-capped).** Vanilla DOM only at load; QE entered lazily
inside QE tools. `PPL_call/PPL_callBatch/PPL_newRequest` and `PPLJSON`
(verbatim copy of `AELLJSON`, byte-parity test). Grounded errors list
what exists, capped. **Receipts are the primitive**: every mutation
reads the mutated object back and returns `{before, after}`; a
mutator's return value is never the receipt; API-accepted-but-unchanged
returns `{ok:false, error:"accepted by API, state unchanged"}` — for
native tools too, not only QE. **STOPPED AT #k** is the permanent batch
contract (no undo groups exist; delete the rollback branch): rows after
the failure are `{ok:false, skipped:true}` and collapse to one line in
the chat. Fingerprint scoped to the active sequence with a clip budget
like AE's 4000 and `walkMs` in the receipt. Receipts carry ticks beside
seconds; time matches use half-a-frame tolerance. `app.project` absent
(Home screen) is a grounded error. Cross-engine state
(`$.engineName` may differ per extension/door) lives in
`<dataRoot>/ppro-state.json`, not `$.global`.

**Shared core, untouched:** `llama.js`, `setup.js`, `settings.js`
mechanism, `comfy.js`, `ffmpeg.js`, `whisper.js`, `tiers.js`,
`version.js`, `mogrt-read.js`, `cep-bridge.js`, the chat loop, CSS,
icons, workflows, CI. Data root stays `%APPDATA%\AE-Llama` (one 20 GB
model, one engine, one ComfyUI).

**Two panels open at once** — only matters once PPRO is in the SHIPPED
manifest (P4). Recommended: a detached **"llama service"** helper owning
llama-server/ComfyUI/ffmpeg and a lease file, both panels attach-only
clients — it is also exactly the process a UXP client needs, so it is
paid for once. Minimum if declined: lease without ownership (unload and
reload never kill anything; explicit Stop kills by lease PID; idle
reaper), attach-instead-of-refuse in `startServer`, `Settings.set`
read-merge-write, an update lock, and a feed `changedHosts` so a
Premiere-only patch does not reload every AE panel.

**UXP exit (designed on a date, built after G3).** UXP plugin (host
`premierepro`, `.ccx`, installs through the same aescripts ZXP/UXP
Installer as a second file) implementing `Host.exec` over localhost to
the helper; `tools-ppro.js` docs/prompt/receipt conventions reused;
`ppro-hostscript.jsx` is the only part that dies. `executeTransaction`
restores round rollback.

## 3. Phases and gates

Owner = who does the work: **remote** writes, **local** runs in real
Premiere, **owner** decides/clicks.

### P0 — Feasibility probes (remote writes, local + owner run; days; no bump)

A throwaway probe bundle **outside `extension/`**
(`probe/com.cptk.aellama.probe/`, own bundle id, AEFT+PPRO, ~40-line
jsx, one html page) junctioned by `scripts/install-probe.ps1`, so CI can
never publish it into `AE-Llama.zxp`.

Measures, each written to `%APPDATA%\AE-Llama\probes\*.json`:

1. **Install/listing** in AE 2026 and Premiere 2026 via (a) junction,
   (b) signed ZXP through `install-zxp.ps1`, (c) **the aescripts ZXP/UXP
   Installer — mandatory**, it is the only path testers use. Both
   manifest shapes. Which `HKCU\Software\Adobe\CSXS.*` key Premiere
   reads. Whether `AutoVisible` opens the panel. Survives restart.
2. **Runtime**: exact `appName`, `appVersion`,
   `__adobe_cep__.getCurrentApiVersion()`, `nodeRequire` of
   `child_process`/`fs`/`http`, evalScript JSON round-trip,
   `$.engineName` (panel vs each door), `typeof BridgeTalk` +
   `BridgeTalk.appName`, History-panel entries after three mutations in
   one evalScript (expect three), localStorage scoping across hosts, a
   **500-round-trip soak** watching for `EvalScript error.` / Stack
   overrun, `$.evalFile` of `hostscript.jsx` (informational).
3. **Premiere 27.0 BETA**: install from Creative Cloud, run the same
   probe. Beta-green is a prerequisite for P2. Record build and date.
4. **Headless doors**, 1-day timebox each, opportunistic: BridgeTalk
   relay from an `AfterFX -r` script (dump `getTargets()`, try
   `premierepro`, `premierepro-26.0`, every listed target); `Adobe
   Premiere Pro.exe /C es.processFile <jsx>` with `extendscriptprqe.txt`
   beside the exe (one admin write, launch-only); a dev-only invisible
   `StartOn` extension (fires on every OS focus per Adobe's own manifest
   comment — sentinel-gated, idempotent, never in the ZXP). Capture a
   Premiere **window census first**; a door counts as dead only when no
   result file appears AND no dialog is up. All three die with
   ExtendScript — record that.
5. **MOGRT acceptance read-back**: `importMGT` of
   `logs\mogrt-verify\AELL Probe Card.mogrt`, then
   `getMGTComponent().properties` by name; blanked text = rejected.
   This retires `docs/SELF-VERIFY-PLANS.md` step 7 and WORKPLAN 11 with
   a machine verdict, whatever else happens.
6. **What Adobe ships** (measured, dated): open the Premiere AI
   Assistant on the owner's install and record what it does, what it
   refuses, credits, cloud upload; read the three helpx pages. Export
   one transcript as TXT/CSV/SRT and keep the files (which formats carry
   timecode).
7. Freeze the owner's Premiere version for the P0–P3 window (disable
   CC auto-update for Premiere); re-run the runtime probe on every
   Premiere release before any Premiere-side push.

Also lands in P0 regardless: `bump-version.js` global regex with a
two-entry fixture test; `ZXPSignCmd -verify` in `package-zxp.ps1` and
CI.

**Exit — Gate G0 (owner):** listed and opens in Premiere 2026 from all
three install paths, evalScript round-trips, Node works, beta probe
green, every field measured; facts into CLAUDE.md and
`docs/PREMIERE-PLATFORM.md`; WORKPLAN 11 closed. **G0 FAIL** = stop the
CEP path, write the limit, decide on UXP from §2's design.

### P1 — DOM inventory (remote writes, local runs)

`ppro-inventory.jsx` on a scratch project Premiere builds itself
(`newBarsAndTone` → `createNewSequenceFromClips`), one row per API the
tiers depend on, PASS/FAIL/ABSENT with the read-back: bins
(create/move/rename/delete, `name` writability, `ProjectItemType`
values), `getMediaPath/changeMediaPath`, `isOffline`, colour labels,
`deleteAsset`, sequence settings/selection/playhead (seconds vs ticks),
clip fields and `move` semantics, in/out writability, `remove(ripple)`,
`insertClip/overwriteClip` return + `setScaleToFrameSize`, component
params + keyframes, markers, `createSubsequence/createSubClip`,
`importFiles`, `importMGT` + text set/read-back, `createCaptionTrack`,
`exportAsMediaDirect` (bytes on disk), `encodeSequence` +
`BridgeTalk.getStatus("ame")`, and every QE call followed by a vanilla
read-back. Output: `docs/PREMIERE-MEASURED.md`. Any row NOT POSSIBLE or
SILENTLY IGNORED is struck before a doc or prompt promises it; the stub
spec derives from the table.

### P2 — Seams, zero AE behaviour change (remote builds, local verifies; MINOR bump)

`host.js`, `tools-ae.js`, `tools-ppro.js` (empty table + prompt
ceiling test), `tools.js`/`main.js`/`index.html`/`selftest.js` routed
through `Host`, `ppro-hostscript.jsx` skeleton (envelope, JSON parity,
ping, grounded-error helpers, fingerprint, STOPPED AT #k), the
"no host strings outside host.js" invariant, `load-tools.js`, ES3
suites extended, `capability-report.js --host`. **No lease/attach/
ownership work here** — PPRO is not in the shipped manifest yet, so
there is no two-panel state to protect. Gate: sha256-pinned prompt and
capability bytes identical, all Node suites green, real-AE self-test
593/593, one field chat session in AE.

In parallel, a **1–2 day UXP spike** (remote writes, local runs): a
UDT-loaded hello plugin on the owner's Premiere with network permission
fetching `http://127.0.0.1:8737/health` from the AE-panel-owned
llama-server, one `Markers` action, one `exportSequence`; and a
Windows-x64 hybrid `.uxpaddon` probe of whether native code can spawn a
process. Result decides in-process addon vs helper service.

### P3 — MVP on the dev junction, ≤8 host tools, differentiators first (remote builds, local verifies)

`get_project_info`, `get_sequence_details`, `list_markers`,
`add_markers` (batch, receipted), `insert_clips` (the one placement
primitive: import + place at playhead/seconds/end, insert|overwrite,
track, scale-to-frame — also comfy placement and the SRT import path),
`export_sequence` (`exportAsMediaDirect` + `fs.stat` byte receipt + the
AE disk/time guard), `insert_mogrt` + `get_mogrt_params`/
`set_mogrt_params` (read-back; blanked text = rejected). Panel side:
`comfy_status/comfy_list_workflows/comfy_generate` placed via
`insert_clips`; `read_transcript_file` only over the export formats P0
measured to carry timecode. Dropped from the MVP (Adobe's assistant now
demos them): `create_bin`, `move_to_bin`, `rename_items`, `set_marker`,
`find_unused` — readmitted only as rule ops with except-lists, preview
gates and receipts if G3 shows demand. `selftest-ppro.js` opens its own
scratch `.prproj` and refuses to build inside the user's project.
`tests/stubs/ppro-stub.js` built only from `PREMIERE-MEASURED.md`, with
the silent-ignore switch ON for native tools in one suite run.
`docs/USEFULNESS-TESTS-PPRO.md` with paraphrase variants. **PPRO stays
on the owner's dev junction — not in the shipped manifest.**

**Exit — Gate G3 (editors, not the owner):** recruit 2–3 working
Premiere editors (aescripts Premiere-category buyers or the alpha
pool), give them the one-paragraph pitch, collect 10 asks each in their
own words with a project open, score the MVP's paraphrase runs the
USEFULNESS way — ≥7/10 useful-with-receipts, zero harmful misses.
**Two-week recruitment deadline: no editors = that is the demand
measurement; stop at P0 + MVP and record it.**

### P4 — Ship (only after G3; remote MINOR bump)

PPRO enters the shipped manifest as an explicitly labelled **preview**
behind a settings toggle ("Premiere (CEP bridge) — Adobe has announced
the end of CEP support; expected ~Nov 2026"), horizon in release notes
and README. Two-panel coordination per §2 (helper service preferred).
Separate aescripts listing in the Premiere category ("Llama for
Premiere"), **shared ZXP** — confirm with aescripts that one ZXP can
back two listings and how licensing binds. Per-host release notes.

### P5 — Tiers 1–7 target the UXP host layer, not CEP

Hygiene by rule, transcript/marker editorial, timeline batch ops,
delivery/QC, MOGRT round-trip at scale, generation into the timeline,
QE structural edits: each admitted per tool by a measured self-test
verdict, each reusing `tools-ppro.js` conventions. **UXP decision is
date-based**: due at the first Premiere release after P3 or
**2026-11-01**, whichever comes first; no Premiere work beyond the MVP
starts after the first Premiere release in which the P0 probe fails, or
after 2026-11-30 without a fresh Adobe statement extending CEP.

## 4. Tool tiers — re-ranked against what Adobe ships

Ranked by "what Adobe's AI Assistant (cloud, credit-metered, beta) and
Premiere's on-device natives cannot or will not do", dated 2026-09-02,
to be re-checked against P0 step 6 before any "Adobe does not do X"
phrase reaches a doc, prompt or listing:

1. **Nothing leaves the machine** — no upload, no credits, no daily
   cap. Every tier below inherits this.
2. **Receipts + grounded errors + preview gates** on destructive ops.
3. **Delivery with bytes-on-disk receipts**: `export_sequence`,
   `batch_export` N×M with naming rules, `queue_to_ame` gated on
   `BridgeTalk.getStatus("ame")`, disk/time guard, pre-flight QC
   verdicts (offline media, gaps, mixed frame rates) judged from reads.
4. **The AE↔Premiere MOGRT round-trip** — AE panel exports, Premiere
   panel `insert_mogrt` at playhead or at every marker of a colour,
   fills params from a transcript or list, reads back what Premiere
   accepted. Nobody else has this; it also closes SELF-VERIFY step 7.
5. **Rule ops with except-lists + preview over hundreds of items**
   (the owner's D1–D4 cases): bins/labels/renames by rule, relink
   report, consolidate + remove-unused with the list BEFORE deletion.
6. **Private generation placed into the timeline** (`comfy.js`
   unchanged; only placement is host-specific). Positioned as
   free/unlimited/private, never as a Generative Extend clone.
7. **Transcript- and marker-driven editorial** over an exported
   transcript (chapters, mark-every-mention, selects reel via
   `createSubClip`/`createSubsequence`, offline caption translation →
   `.srt` → `createCaptionTrack`). Adobe's assistant does transcripts
   and stringouts in the cloud; ours is offline — a narrower pitch.
8. **Timeline batch ops** (`set_clip_property`, keyframes by
   interpolation TYPE only, `move_clips`, `remove_clips` with preview).
9. **QE structural edits** last (effects, transitions, razor, ripple,
   frame export) — per-install verdict, present in the prompt only
   while green.

**NOT BUILT** (written into the PPRO prompt so the model never
promises them): whisper captions in Premiere (native S2T is free,
on-device, word-level since 26.3), filler/pause removal, scene edit
detection, Enhance Speech, object masks, semantic media search,
Generative Extend / Firefly B-roll / music-SFX clones, toolless chat;
and AE concepts with no Premiere analogue — text/shape/solid creation,
masks, expressions/nulls/parenting/controls, `expose_property`,
`export_mogrt`, 3D, `audio_to_keyframes`, `get_bounds`, ease handles,
caption text read/edit. Roughly half of the 79 AE tools.

## 5. Verification ladder

- **Rung 0 — receipts are the primitive** (every mutator reads back;
  self-test asserts on the read-back, never on a return value).
- **Rung 1 — stubbed suite in CI**: `ppro-stub.js` models only measured
  quirks (ticks, 0-based tracks, silent-ignore switch); per-tool tests;
  JSON parity; ES3 suites; the host-strings invariant; both
  CAPABILITIES tables fresh; `bump-version.js` asserts every entry.
- **Rung 2 — in-panel Settings → Run self-test** (the planned rung for
  Premiere; writes `%APPDATA%\AE-Llama\logs\ppro-selftest.json`).
- **Rung 3 — headless door**, if P0 found one. Consequence stated in
  every Premiere ship note: **with no door, Premiere is not covered by
  the overnight loop and the local PATCH rule does not apply**;
  `bump-version.js` refuses a bump touching `ppro-hostscript.jsx`/
  `tools-ppro.js` unless a Premiere self-test result newer than the
  last such commit exists.
- **Rung 4 — model and context**: PPRO prompt ceiling pinned in CI
  against `/tokenize`; state block measured on a 500-clip sequence;
  `chat-probe.js` PPRO scenarios scored USEFULNESS-style.
- **Rung 5 — packaging**: every ship verified as a signed ZXP through
  `install-zxp.ps1` AND the aescripts installer; AE harness 593/593
  after every seam or shared-core change.

## 6. Owner decisions

1. **Fund now?** (a) P0 only — probes, harness door, MOGRT verdict,
   `bump-version.js` fix; (b) P0 + P1–P3 on the dev junction; (c) the
   whole plan. **Recommend (a) now**, (b) after roadmap 13 closes.
2. **Premiere 27.0 beta on the machine for the probe** (needed for G0;
   installs beside 26.x). Recommend yes.
3. **Admin write of `extendscriptprqe.txt`** beside the Premiere exe
   for door 2, and a dev-only invisible runner for door 3. Recommend:
   allow both, dev-only, never shipped.
4. **Branding/listing**: separate aescripts listing "Llama for
   Premiere", shared ZXP, data root unchanged until after G3.
   Recommend yes; confirm licensing with aescripts.
5. **UXP bet**: (A) bridge-only, (B) design + spike now, build after
   G3 (**recommended**), (C) build UXP now.
6. **Two-panel core**: helper "llama service" (recommended; also the
   UXP client's backend) vs peer lease coordination.
7. **Whisper in Premiere**: omit (recommended).
8. **Patch-bump authority**: local bumps Premiere fixes only after
   real-Premiere verification (rung 2 or 3); stub-only never bumps.

## 7. Risks

- **Sunset platform** — ExtendScript "through September 2026", CEP ~Nov
  2026; a 27.0 beta exists today. Mitigation: date-based UXP decision,
  beta probe as a P2 prerequisite, CEP scope capped at the MVP,
  `ppro-hostscript.jsx` throwaway and size-capped.
- **CEP may not list in 26.x / installer may reject a two-extension
  bundle** — conflicting reports. Mitigation: P0 measures all three
  install paths and both manifest shapes before anything is built.
- **Silent-ignore is a whole-DOM property**, not QE-only. Mitigation:
  read-back on every native mutator; stub switch ON for native tools.
- **Engine degradation** over a long session. Mitigation: soak in P0;
  re-evalFile recovery in the transport; small payloads.
- **No headless door** → no overnight coverage. Mitigation: stated in
  every ship note; bump refusal without a Premiere result; QE tiers do
  not ship without a door.
- **Context budget** — a second prompt cannot share the 16k window.
  Mitigation: blank-page prompt with a CI-pinned ceiling; AE prompt
  sha256-pinned across the seams.
- **AE momentum** — roadmap 13 is the owner's priority and every local
  hour on Premiere is an hour off AE field truth. Mitigation: P0 only
  now; P2+ after 13 closes.
- **Two panels** — cross-kill on unload/reload, port refusal, settings
  last-writer-wins, concurrent auto-update. Mitigation: nothing to
  protect until PPRO ships (P4); helper service or lease-without-
  ownership before that.
- **One version gate, two hosts** — a Premiere patch reloads every AE
  panel and shows AE notes in Premiere. Mitigation: feed
  `changedHosts`, per-host notes, batched Premiere patches.
- **Competitive claims** — "no native equivalent" was true in April and
  false by June. Mitigation: dated measured table in
  `PREMIERE-PLATFORM.md` gates every such phrase.
- **Demand** — the owner has not opened Premiere for a one-minute
  check in days; owner-scored demand is decorative. Mitigation: G3
  scored by recruited editors, with a deadline that itself is a
  measurement.

## 8. Rejected

- Single extension with both hosts as the ONLY shape: `hostscript.jsx`
  would evaluate in Premiere's engine at panel start. Kept as a P0
  alternate because it is the shape shipped manifests actually use.
- A separate Premiere shell (`ppro/index.html`, `ppro-main.js`):
  duplicates the chat wiring for six strings and one hidden pane.
- Extracting `AELLJSON` into a shared jsx: touches AE's load path for
  no gain; a byte-parity-tested copy is safer.
- Probe mode inside the main panel: loads the whole AE stack before
  Node/evalScript are known to work.
- Shipping the invisible `StartOn` runner in the ZXP: an always-on
  invisible extension in customers' Premiere is not acceptable.
- A rollback branch behind `Host.supportsRollback`: no undo API exists
  in Premiere ExtendScript; STOPPED AT #k is permanent.
- Two-panel coordination in P2: no two-panel state exists until PPRO
  is in the shipped manifest.
- Building UXP now: a second file and a second DOM before any demand
  signal; spike it, design it, build it after G3.
- Renaming the data root/settings key/feed now: a migration with its
  own failure modes; only the Premiere menu label changes before G3.
- Whisper as a Premiere tool: native S2T wins on every axis.

## 9. Unverified after review (each with the step that measures it)

| Claim | Measured by |
|---|---|
| CEP panels list and open in Premiere 26.x / 27.0 beta | P0-1, P0-3 |
| aescripts installer accepts a two-extension bundle; one license for two listings | P0-1, P4 |
| Exact `appName` string ("PPRO" expected) and CEP API version | P0-2 |
| Which CSXS.* key Premiere 26 reads (13/14 claim is third-party) | P0-1 |
| localStorage scoping across hosts | P0-2 |
| `AutoVisible` behaviour in Premiere | P0-1 |
| `$.engineName` per extension / per door | P0-2 |
| BridgeTalk AE→Premiere delivery; `es.processFile` on 26.x | P0-4 |
| `exportAsMediaDirect` on 26.x; `importMGT` text blanking | P1 |
| Whether a hybrid `.uxpaddon` can spawn a process | P2 spike |
| Transcript export formats that carry timecode | P0-6 |
| The exact Premiere version that drops CEP | P0-3, every release |
| Adobe AI Assistant's measured capability list | P0-6 |
