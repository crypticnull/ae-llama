# ComfyUI templates — a basic, provable graph per catalog model, on a foundation the UI arranges

**Status 2026-09-06: planned, not built. Authoritative for WORKPLAN §18.**
Produced by a planning pass: five grounded readers (437 facts, 48
surprises), three drafts from distinct angles, three judges (all three
picked the foundation-first draft), one synthesis, five skeptic lenses
plus a completeness critic (79 findings: 35 confirmed, 39 contested, 5
refuted, 3 blocking), and 14 hand re-verifications against source of
everything that changed the plan. §0 lists what the review overturned —
including two claims §18 itself made yesterday.

The owner's two halves, kept distinct throughout:

> "keep it strict and basic proof of function for now, while laying the
> foundation for more complex workflows in the future arranged and
> accessible via the plugin UI"

---

## 0. What the review changed

Corrections to §18's own text (filed 2026-09-06, wrong the same day):

1. **"Manifests need `sizeMB`" — STALE.** `genNeedMBFor`
   (`tools.js:1579-1596`) treats `models[].sizeMB` as an optional
   override and otherwise prices off the DISK via `modelFileMB`; that is
   what 0.10.9 built. What a manifest must get right is `file` + `dir`,
   so the disk lookup finds the weight — a wrong `dir` is the failure
   this hides, not a missing size.
2. **"H3 may have no t2v path" — WRONG.** H3's manifest marks
   `procedural.firstFrame.detachable: true`; with no image the panel
   deletes the LoadImage node and runs text-to-video (`comfy.js:495-525`,
   landed 2026-08-26, LOG 2226-2296). The first end-to-end render on
   2026-08-27 (LOG 2445-2515) was exactly that — `comfy-probe`'s
   defaults pass no image — 5 frames, 28,379 MiB peak, AE read the mp4
   back. What H3 lacks is a `catalog-vram-probe` reading (`measured:
   false`, `version.js:170`).

Corrections to the synthesised draft:

3. **Ratchet `models[].file ⊆ catalog urls[]` would have gone RED on
   night one.** The shipped H3 manifest carries an optional lora
   (`MiniMax_H3/minimax_h3_turbo_4step_comfyui_pruned.safetensors`,
   `dir: loras`, `optional: true`) with a subfolder path that is in no
   catalog list. Rule as shipped: **non-optional entries only, compared
   by basename.**
4. **A `/object_info` checker script — cut.** `POST /prompt` refuses a
   bad class or input name before any execution and `comfy.js:1618-1630`
   surfaces the server's own message; `comfy-probe --no-ae` IS that
   check. Authoring still reads `/object_info`; validation is the
   server's.
5. **`setCatalog` push into tools.js — cut.** `version.js` loads before
   `tools.js` (`index.html:318`, `:327`), so `global.AELL.COMFY_CATALOG`
   is reachable. The feed override is moot: `update.json` carries
   `modelCatalog` only, no `comfyCatalog` producer exists.
6. **`edited` marker — dropped.** `.hash-history.json` is a dotfile the
   seeder skips (`setup.js:94`), so the seeded folder cannot answer it.
7. **`comfy_list_workflows` returning objects — dropped.** Its doc says
   "by name" (`tools.js:647`) and `comfy_generate`'s args say "name from
   comfy_list_workflows" (`:654`); changing the shape with the doc
   untouched is a contract change hidden from the model. Strings stay.
8. **"No drift test for KREA2" — wrong.** `test-workflow-adapt.js:652-658`
   byte-compares it (H3 at `:485-488`). Directly authored basics would
   be the first files WITHOUT one — an accepted risk, §8.
9. **"10 verdicts" — 9** for one mp4 (`comfy-probe.js:346-492`).
10. **Neither probe boots a backend** (`comfy-probe.js:338-352`,
    `catalog-vram-probe.js:609-616` both exit on unreachable), and a
    probe-booted backend would be an orphan on the owner's port. §5's
    `--boot`/`--stop` flags and §6's backend rule come from this.
11. **Manifest-less templates have no `kind`.** README line 23 promises
    user exports "work as-is"; the resolver keeps them as candidates
    AFTER described ones rather than refusing.
12. **The Settings row must say what a template NEEDS** — the owner's
    words — and the data already exists one hop away (`minVramGB`,
    `requiresBlackwell`, `requiresImage`). Added as a pure derived
    phrase; per-workflow on-disk state is NOT duplicated (the model rows
    two blocks down already show it, `main.js:62-142`).

---

## 1. Principle

**Basic (ships now).** The smallest core-node API graph per catalog
entry that renders through `comfy_generate` (`tools.js:1932-2112`)
under the README injection contract
(`extension/comfy-workflows/README.md:21-51`): no `procedural` block
unless the generic walk (`comfy.js:684-769`) provably cannot land a
param, no `optionalNodes`, no upscaler, no control branch, no enhancer
node. Every seed pinnable — a basic template doubles as §13a step 4's
fixed-seed instrument. Frozen under its name once shipped: refinements
are SIBLINGS under new names, because a seeded copy a user has edited is
preserved forever by the hash-history seeder (`setup.js:103-115`) and an
edit to the basic file would silently diverge from what tests pin.

**Foundation (ships now, minimal).** The manifest becomes the source of
truth for kind / inputs / catalog link, read by ONE pure describer that
feeds (a) the nameless-default resolver and (b) the Settings Workflows
rows. Compound tools later (§9 item 5 animate-this-frame, §9 item 9
`repaint_region`) call the same resolver — one chooser, never two.

**Hooks only (named here, zero code).** `procedural.denoise` /
`maskImage` / `audio` inputs; a stored default per kind; a feed
`comfyCatalog` guard; a renderable predicate on `recommendGen`;
`catalog-vram-probe --out docs/measured/`.

**Out.** Upscalers, control branches, r2v, the tier-copy rewrite
(`tiers.js:56-75` promises Flux / Wan 14B), §17a itself (filed, not
built — `settings.js:59` is still 8188).

---

## 2. The basic template contract

**Name.** `AE_LLAMA_<MODEL>_<MODE>_V1`, MODE ∈ `T2I` | `T2V` | `I2V`.
Keep the `AE_LLAMA_` prefix — `weight-availability-probe.js:136` filters
on it. Siblings: `_V2` or `_<TAG>_V1`, never overwriting the basic.

**Graph** (`extension/comfy-workflows/<name>.json`, API format —
`loadWorkflow` accepts it directly, `comfy.js:257-277`):

- every class and input name read from the RUNNING backend's
  `/object_info` at authoring time — never from memory (the harvest in
  `scripts/comfy-node-defs.json` holds 52 classes and lacks `KSampler`,
  `CheckpointLoaderSimple` and every Wan class, measured);
- prompt / negative on `CLIPTextEncode` nodes reached through the
  sampler's `positive` / `negative` links (`comfy.js:696-721`);
- exactly ONE node with numeric `width` + `height` — the walk stamps
  every numeric pair it finds (`:723-735`);
- video: a LITERAL numeric `length` / `frames` (`:738-747` skips links —
  H3's node 138 is why it needed `procedural.durationSeconds`), never
  both conventions; ends in `SaveVideo {format: mp4, codec: h264}` (the
  shipped H3 node 92 is the shape);
- all randomness on `seed` / `noise_seed` (`:749-758`); a RELATIVE
  `filename_prefix`; no `CHANGE-ME` (`:239-242` flags it as example);
- weight filenames are the exact basenames of the entry's `urls[]`
  (`version.js:96-206`), so `catalog-vram-probe`'s graph regex
  (`:261-274`) and `catalogModelStatus` (`tools.js:1485`) agree.

**Manifest** — runtime-read keys only; a key with no consumer is
documentation and is not added:

| key | rule |
|---|---|
| `workflow` | the file's own name |
| `kind` | `image` \| `video` — gets its FIRST consumer here (today unread, measured) |
| **`catalogEntry`** (NEW) | the `COMFY_CATALOG.name` it renders. One-directional: the catalog's `workflowTemplate` keeps naming the BASIC graph; siblings point back |
| `models[]` | `{file, dir ∈ Comfy.MODEL_SUBS, role, optional?}`; `sizeMB` optional override (§0 #1) |
| `procedural.firstFrame` | only when `/object_info` marks the image input OPTIONAL → `{nodeId, input, detachable: true}` (the H3 pattern); a true i2v whose image is REQUIRED carries it without `detachable` |
| `customNodes` | one `(comfy-core)` entry + `nodeAttributionScannedOn` |
| `enhancerInstruction` | short and machine-neutral, or omitted for the generic one (`tools.js:3254-3258`) |

No `label` — the row shows the catalog's (`version.js:94`).

**Selection** — replaces `tools.js:1958` `chosen = list[0]`, which today
hands "a red apple" to the 40 GB Blackwell H3 VIDEO graph because
`ae_llama_h3` sorts before `ae_llama_krea2` (pinned by
`test-comfy-workflow-choice.js:148-161`). The model may still name a
workflow (`:1959-1982`). When it names none:

1. `want.kind = (args.frames > 0 || args.durationSeconds > 0) ? "video" : "image"`;
2. candidates = DESCRIBED workflows of that kind, not example, not
   disabled; `requiresImage` ones excluded when no image was given;
   `takesImage` ones preferred when one was;
3. ordered by `Tiers.entryFits(catalogEntry, ctx)` FIRST (fitting before
   unfit — never silently unfit while a fitting one exists), then
   weights-present (`catalogModelStatus`, disk only, no backend), then
   highest `minVramGB` among those (recommendGen's own rule,
   `tiers.js:203-206`), then name;
4. UNDESCRIBED (manifest-less) templates remain candidates after the
   described ones — README line 23's "most workflows work as-is" stays
   true for a user's own export;
5. none → grounded error naming what exists per kind.

Zero prompt bytes: no `kind?` arg, no doc reword. `planEnhancement` is
keyed on `chosen.name`, not `args.workflow` (`tools.js:2061` — today an
opt-out is silently bypassed on a nameless or miscased call).

---

## 3. Per-entry table

| entry (`version.js`) | graph — author from `/object_info`; check these | weights | unknown | order |
|---|---|---|---|---|
| **sd15** (:93) | `AE_LLAMA_SD15_T2I_V1`: the `example-txt2img.json` shape (`CheckpointLoaderSimple`, `KSampler`, `EmptyLatentImage`, 2× `CLIPTextEncode`, `VAEDecode`, `SaveImage`) with the real ckpt, 512². Neither loader nor sampler is in the harvest — confirm every input name | 2,034 MiB, `checkpoints` | VRAM | **1** — cheapest proof of the whole chain |
| **sdxl** (:102) | same shape, ckpt swap, 1024² | 6,617 MiB | VRAM; whether `slowBelowGB: 8` is real | 2 |
| **minimax-h3** (:168) | EXISTS and has RENDERED t2v (§0 #2). Add `catalogEntry`. Core-only sibling is owner-optional (Q6) | shipped | quality without a frame — rendered, never judged | 3 — a regression re-run + the missing measured block |
| **wan22-5b** (:153) | `AE_LLAMA_WAN22_5B_T2V_V1`: `UNETLoader` / `CLIPLoader` / `VAELoader` (in harvest) + the 5B latent / sampler nodes — **class names unknown here, read them from `/object_info`**; literal numeric `length`; `CreateVideo` + `SaveVideo` mp4/h264. If `/object_info` marks the image input optional → ONE graph with `firstFrame.detachable`; if required → i2v is a second file later | 3 files, 17,304 MiB; `minVramGB: 8` (:155) | VRAM — if the delta exceeds 8 GiB, raise the floor and re-pin in the same commit | 4 — first new video graph |
| **krea2** (:114) | EXISTS (authored; ran bare at 10 s in 0.9.23). Add `catalogEntry`. Core-only sibling owner-optional (Q6) | 3 files, urls unpinned | §17d re-take | done |
| **minimax-h3-int8** (:188) | almost certainly the H3 graph with one encoder swapped: a second API file from the H3 UI source via `adapt-workflow.js --manifest` (`:702`) with `panelAdaptation.setInputs` on the CLIPLoader (node 137, `clip_name`). **Confirm from the UI source; do not assume** | int8 encoder 25,884 MiB | "usable at all is a P4 measurement" (:191-193); no non-Blackwell card here | owner (Q2) |
| **ltx-small** (:144) | none: `urls: []` (:148), so no Settings row either (`main.js:83-86`) | none | pin or drop | owner (Q1) |

The two authored graphs are **grandfathered** as their entries' basic
tier: §2's contract binds NEW files. Whether a core-only sibling per
entry is worth a pass is Q6 (default: no).

---

## 4. Foundation — what ships vs what is a hook

**Ships in P1 (`extension/` → patch bump):**

1. `Comfy.describeWorkflows(dir)` → `[{name, file, example, kind,
   catalogEntry, takesImage, requiresImage, lengthIn}]` from
   `listWorkflows` (`comfy.js:213-254`) + `readManifest` (`:205-211`).
   `takesImage = !!procedural.firstFrame`; `requiresImage = takesImage &&
   !firstFrame.detachable`; `lengthIn = procedural.durationSeconds ?
   "seconds" : "frames"`. One function, two consumers.
2. `Comfy.resolveWorkflow(descs, want, ctx, settings)` — pure,
   stub-tested, per §2. `ctx = Tiers.resolveTier(gpuCache, s)`; the
   catalog is `global.AELL.COMFY_CATALOG` read in tools.js.
3. `settings.comfyWorkflows: {name: {enabled}}` in `defaults()` —
   `settings.js:150-151` drops any saved key absent from defaults.
4. `_graphCarriesValue` exported (`comfy.js:779-791` is unexported today;
   the `_applyExtraModelPaths` precedent) so the bundle test can replay
   injection over the real files.
5. `catalogEntry` on both shipped manifests; hash history regenerated.
6. `comfy_list_workflows` UNCHANGED (strings). If chat-probe's new kind
   verdict (§5) shows the model needs kind, one parallel key
   `video: [names]` — a hook until measured.

**Ships in P4 (`extension/` → patch bump):** the per-workflow list
(`index.html:184-191`, `main.js:21-50`) becomes **Workflows** rows:
catalog label + kind badge + "renders `<catalog label>`" + a NEEDS
phrase derived purely from the catalog entry and the manifest ("needs
24+ GB", "RTX 50 series only" via `Tiers.entryFits` against `gpuInfo`;
"needs an image" via `requiresImage`) + enhancement checkbox + **enabled**
checkbox. Example rows HIDDEN (today they get a checkbox, `main.js:37-49`,
while `tools.js:1913-1915` hides them from the model). Row content comes
from `describeWorkflows` + a pure `workflowRowModel()` so it is
stub-tested — `main.js` has no executed coverage. Mode-independent of
§17's `comfyBackend` switch: it reads the seeded folder either way.

**Hooks (named, no code):** `procedural.denoise` / `maskImage` / `audio`
= one key + one handler cloned from the firstFrame branch
(`comfy.js:495-525`) + `describeWorkflows` exposing it;
`want.requiredInputs {image, mask, audio}` on the resolver; stored
`comfyDefaultWorkflow` per kind; a feed `comfyCatalog` guard (no
producer); `catalog-vram-probe --out docs/measured/` for §13a step 4;
a renderable predicate on `recommendGen` (moot once §5's allowlist
empties — a gate now would re-pin three test files to change nothing).

---

## 5. Verification

### CI ratchet — no backend, runs on every push

**New `tests/test-workflow-bundle.js`** walks `extension/comfy-workflows/`.
For every non-example template: a manifest exists with `kind ∈ {image,
video}`; `catalogEntry ∈` catalog names (P0: warn if absent, P1: assert);
`models[].dir ∈ Comfy.MODEL_SUBS`; non-optional `models[]` basenames ⊆
the entry's `urls[]` basenames ∪ `files[]` (optional exempt — §0 #3);
every `procedural.*.nodeId` / `input` exists in the graph; replay
`injectParams` over the REAL file with a fixed prompt / seed / size and
assert via `_graphCarriesValue` that the prompt landed, every seed key is
pinned, and size landed on ONE node OR `procedural.resolution` was
written (H3's 138 `width`/`height` are links); video graphs carry
`SaveVideo {mp4, h264}`.

**`test-model-catalog.js:229` flips from skip to assert** with two
allowlists that fail in BOTH directions (a name removed without its
template; a name still listed once the template exists):

- `ALLOW_NO_TEMPLATE = [sd15, sdxl, ltx-small, wan22-5b, minimax-h3-int8]`
- `ALLOW_UNMEASURED = [minimax-h3]` — every entry with `workflowTemplate`
  must be `measured: true` unless listed. **Existence is not proof**; a
  graph committed with `workflowTemplate` set and never rendered passes
  the first list and fails this one.

`test-workflow-manifests.js`: the shipped half becomes a directory walk;
the authored `PAIRS` stay (R2V exists only there).
`test-comfy-workflow-choice.js:148-162` re-pinned: "a red apple" → the
image fixture; `durationSeconds` → H3; a manifest-less fixture is still
runnable, after the described ones; a disabled one is never chosen and
is named in the error. `test-settings-migrate.js` `loadWith()` shape:
`{comfyWorkflows: {X: {enabled: false}}}` survives `load()`, and the
resolver never returns X. `test-context-budget.js` measured before /
after — must be unchanged (zero prompt bytes is the design).

### Instruments — `scripts/` only, no bump (P2)

- `comfy-probe --frames N` (today it always sends `durationSeconds`,
  `:375`, so a frames graph renders at authored length with
  "durationSeconds ignored", `comfy.js:467-469`).
- `--boot` / `--stop` on `comfy-probe` and `catalog-vram-probe`: boot
  the MANAGED backend via `Comfy.ensureRunning` on an explicit non-8000
  port and `Comfy.stopManaged()` on EVERY exit path when the probe
  booted it. Pre-§17a this must refuse when 8000 answers — `ensureRunning`
  step 2 will find it and refuse anyway (`comfy.js:2110-2115`), and a
  probe-booted backend nothing reaps is the squatting defect §17a names.
- `download-gen-weight.js --entry <name>` wrapping `Setup.downloadGenWeight`
  (one caller, `main.js:175` — every "download via Settings" step is
  otherwise a human click). It lands in `comfyModelsDir`, else the
  vendor tree, else REFUSES (`setup.js:669-694`) — see §6's backend rule.
- chat-probe step 13 gains one verdict: the template `comfy_generate`
  ran carries `kind: image` for a picture request.
- **Gate 0 of every local pass:** print `Settings.origin()` and refuse
  when `appdata` is empty (`settings.js:215-224`) — the WMI-detached
  loop once had no APPDATA and a pass reported the default port as the
  owner's setting (2026-09-02).

### Per template, in order

(a) CI above. (b) backend, no GPU: `weight-availability-probe --url`
prices off disk and refuses nothing; `comfy-probe --no-ae` — the
server's validation is the `/object_info` check (`comfy.js:1618-1630`).
(c) GPU: `catalog-vram-probe --entry <name>` → the reading goes into the
LOG with its environment named; `version.js` gets `workflowTemplate` but
stays `measured: false` until a reading is taken on the VENDOR backend
(§17c / §17d — "it worked here" on the owner's install is not evidence
about the shipped path). When a vendor reading exceeds `minVramGB`,
raise it AND re-pin `test-tiers.js:101-129`, `test-model-catalog.js:69-82`,
`test-tier-ladder.js:99-124` in the same commit. (d) AE: `comfy-probe
--workflow <name>` — 9 verdicts: reachable, listed, generated, a file
came back, >1024 bytes, `ftyp` for mp4, AE imported it, real dimensions
and duration > 0 for video, cleaned up. (e) `chat-probe --steps 12,13`.

**One measurement the owner's ask depends on, taken in P5:** can the
ComfyUI frontend open a basic API-format graph as an EDITABLE canvas?
Unverified in this repo. Drop the sd15 basic onto the running frontend
and log the answer. If it cannot, "improve manually" starts from a blank
canvas — so basics ship as UI exports + `adapt-workflow.js` instead,
which forces a re-harvest of `comfy-node-defs.json` (KSampler,
CheckpointLoaderSimple, Wan\*) first.

---

## 6. Passes — one item each, smallest first

**Backend rule — two routes, both named per pass.**

- **(a) attended, the owner's ComfyUI on 8000** (Q5). Until §17a lands
  `ensureRunning` finds 8000 and refuses to boot anything else, and
  `genWeightDest` has no vendor tree — so downloads need
  `comfyModelsDir` SET (never to the owner's own store) and 8000
  UN-BLINDED to read it (§7b bullet 1: `extra_model_paths.yaml` in
  `Documents\ComfyUI`). Every VRAM number taken here is a §17d re-take.
- **(b) unattended, after §17a + §17c:** the loop boots the managed
  backend with `--boot`. This is the real unblock; §17a/§17c are rows
  below with owners, not assumptions.

**P0–P2 are remote and are pushed BEFORE the first overnight run** — P5
depends on all three, and the loop reads the workplan fresh each pass.

| # | who | files | bump | instrument | needs |
|---|---|---|---|---|---|
| P0 | remote | `test-workflow-bundle.js` (catalogEntry warn-mode), `test-model-catalog.js` two allowlists, `test-workflow-manifests.js` walk, §18 rewrite, memory index | no | `node tests/*` | — |
| P1 | remote | `comfy.js` describe/resolve/`_graphCarriesValue`; `tools.js` :1958 :2061; `settings.js` `comfyWorkflows`; both manifests + `catalogEntry`; hash; choice + settings re-pins; bundle test → assert | **yes** | stub suite; budget unchanged | P0 |
| P2 | remote | `comfy-probe` `--frames`/`--boot`/`--stop`; `catalog-vram-probe` `--boot`/`--stop`; `download-gen-weight.js`; chat-probe kind verdict; `Settings.origin()` gate | no | dry-run attended on 8000 | P1 |
| P3 | local | H3 t2v regression re-run + `catalog-vram-probe --entry minimax-h3` → reading in LOG | no | `comfy-probe` (no `--image`), 9 verdicts | P2; route (a) Q5 or (b); AE |
| P4 | remote | `index.html:184-191`, `main.js:21-50` → Workflows rows via `describeWorkflows` + pure row model | **yes** | stub on the row model; owner eyeballs | P1 |
| P5 | local | `AE_LLAMA_SD15_T2I_V1` + manifest; `version.js` `workflowTemplate`; `ALLOW_NO_TEMPLATE` −sd15; hash; the frontend-editable measurement | **yes** | download → (b)–(e) | P0–P2; route (a) or (b); AE |
| P6 | local | sdxl as P5 | **yes** | as P5 | P5 |
| P7 | local | wan22-5b: `/object_info` decides one graph or two; `--frames` | **yes** | as P5 + ftyp / AE duration; floor re-pin rule | P5; 17 GB disk |
| P8 | local | h3-int8: second API file via `adapt --manifest` setInputs — confirm from the H3 UI source first | **yes** | (a)–(c) on a non-Blackwell card | P1; owner Q2 |
| P9 | owner → local | ltx-small pin or drop; `test-tiers.js:105-107` re-pin | **yes** | stub | owner Q1 |
| P10 | remote | `ALLOW_NO_TEMPLATE → []`; `ALLOW_UNMEASURED → []` as vendor readings land; ratchet hard | tests only, unless `tiers.js` | CI | P5–P9; §17d |
| §17a | remote | managed backend by default (filed) | **yes** | §17a's matrix | owner decision on port |
| §17c | local | vendor install on this machine (filed) | no | `weight-availability-probe` | §17a, or owner stops 8000 |

Every pass: log entry, `node scripts/memory-index.js`,
`capability-report.js` when CAPABILITIES changes. Every local pass: gate
0 first, and `Settings.origin()` in the log.

---

## 7. Owner decisions — the ones that change the build

1. **ltx-small:** pin files or drop the entry (drop removes the 6 GB
   video pick — `test-tiers.js:105-107` and the T2 copy re-pin).
2. **minimax-h3-int8:** download the 26 GB encoder to prove it on a
   non-Blackwell card, or leave the entry unproven? There is no shipping
   path for an unmeasured template.
3. **Refinement round-trip:** a hand-improved graph comes back as a UI
   export under a NEW name in `extension/workflows/` (regenerable via
   `adapt-workflow.js` after re-harvest), never as an edit of the seeded
   basic — confirm.
4. **KREA2 `enhancerInstruction`** carries machine-specific lines
   ("ACTIVE LORA TRIGGERS", "ASPECT: portrait", manifest :164) — strip
   in the bundle, or keep?
5. **Until §17c lands, may the loop probe your ComfyUI on 8000?** Route
   (a) is attended by definition — nothing unattended may touch it
   without this.
6. **Core-only siblings for krea2 / h3** (`AE_LLAMA_KREA2_T2I_V1`,
   `AE_LLAMA_H3_T2V_V1`), or grandfather the authored graphs as their
   basic tier? Default: grandfather.

---

## 8. Risks not mitigated, and why

- **CI never renders.** Every render proof is a local pass whose
  transcript is gitignored; only the LOG entry and the measured block
  survive. Accepted — that is what the ALLOW_UNMEASURED ratchet is for.
- **Basic graphs have no UI source**, so no byte-equality rebuild test
  (both SHIPPED graphs have one — §0 #8). Accepted: ≤10 core nodes,
  siblings are separate files — unless P5's frontend measurement says
  basics must be UI exports, in which case they get one.
- **Node-name drift after a vendor-build upgrade** is caught by the
  probes (`/prompt` validation), not by CI.
- **Kind inference** sends a length-less "make me a video" to an image
  graph; only the chat-probe verdict sees it. If that verdict fails, a
  `kind?` arg (24 chars) is the fix — measured, not pre-emptive.
- **`recommendGen` still ignores renderability** (`tiers.js:197-224`)
  until the allowlist empties; the Settings tier line can name a model
  the generation path will not pick. The resolver's `entryFits` ordering
  keeps the GENERATION honest; the COPY is §16's problem.
- **Tier copy promises Flux / Wan 14B** (`tiers.js:56-75`) — §16.
- **Feed `comfyCatalog`** could name an unbundled template — no producer
  exists, so unvalidated by choice.
- **H3 t2v quality without a frame:** rendered, never judged.
- **KREA2 refuses images; `import_as_layer` duplicates** — §9 items.

---

## 9. Provenance

| decision | from | changed by |
|---|---|---|
| One `describeWorkflows` + pure resolver feeding default and rows; caller-args kind inference; `enabled` key; `catalogEntry` one-directional; `AE_LLAMA_` prefix; P-ordering | foundation-first draft (best, all three judges) | — |
| `--frames` on comfy-probe; two-way allowlists; hide example rows; row model stub-tested; directory walk keeping authored PAIRS | proof-first draft | judges 1–3 grafts |
| Refinement-under-new-name (Q3) | proof-first | judge 1 |
| chat-probe kind verdict; resolver as the compound tools' chooser; §17 mode-independence | risk-first draft | judges 1–3 grafts |
| Weights-present tiebreak; floor-raise + same-commit re-pin; headless weight download; per-pass backend/AE needs | ground truth (missed by all drafts) | judge 3 |
| `entryFits` FIRST in the resolver; `requiresImage`; the NEEDS phrase on the row | attack: future-foundation | confirmed |
| Optional-exempt basename ratchet; `ALLOW_UNMEASURED`; `_graphCarriesValue` export; manifest-less candidates; `setCatalog` cut; `edited` cut; checker cut; strings on `comfy_list_workflows` | attack: true-in-code, scope-creep, verification-honesty | confirmed / blocking |
| `--boot`/`--stop`; two backend routes with owners; gate 0 `Settings.origin()`; P0–P2 before night one; P5 needs column | attack: verification-honesty, constraints, completeness | blocking / confirmed |
| §0 #1 (`sizeMB` stale) and #2 (H3 t2v rendered) | attack: true-in-code, verification-honesty | refuted §18 claims; re-verified by hand against `tools.js:1579-1596`, LOG 2226-2296 and 2445-2515 |
| Rejected: copied `sizeMB`; image-only default; two-way ratchet; `kind?` arg; `inputs:{image}` alias; feed guard; stored default radio; renderable `recommendGen` in-plan; h3-int8 "ship hidden unmeasured" | proof-first / risk-first / foundation-first | judges 1–3 rejects |
