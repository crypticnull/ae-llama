# Self-verification harness plans — MOGRT, captions, inpainting

Owner request (2026-08-30): "built in plans and recursive checks for
the more advanced tools ... so I dont need to manually test nearly as
much." Each plan below was designed against the current code and then
ADVERSARIALLY REFUTED by an independent pass; everything under
"Requirements from refutation" is a design constraint, not a
suggestion — the refuter showed the naive version lies.

Shared rules (all three probes):
- Instruments are INDEPENDENT of the code under test: Node fs/stat,
  zip parse, ffmpeg pixel reads, PNG IHDR, whisper reference runs —
  never the producing code grading itself, and never a fixture
  authored by the module it validates.
- Probes run on the overnight loop's machine under the EXISTING
  dialog triage: the PowerShell side (run-ae-selftest.ps1 stage)
  owns AE launch + modal watch; Node owns verification. A probe that
  cannot run writes a grounded SKIP line to docs/WORKPLAN-LOG.md —
  an aborted probe that logs nothing is the lost-coverage failure
  class and counts as a harness bug.
- Every checker is proven against PLANTED defects before it gates
  anything (the "fails on the reverted file" standard).
- Any AE state a probe touches is restored: prior project recorded
  and reopened, suppression state cleared on failure paths
  (app.endSuppressDialogs), artifacts swept by name-scoped globs.

---

## 1. MOGRT export (export_mogrt + expose_property)

Today the positive export path has ZERO unattended coverage (selftest
holds only the refusal wall, by design — exporting requires saving a
project). The tool never opens the file it celebrates: bytes +
existence are the whole verdict.

**Live bug found during design (fix first):** AELL_mogrtFound
(hostscript.jsx:9482) returns on the first folder-diff hit with no
size-stability wait — the bytes receipt can be a mid-write number and
the file a partially-written zip. Fix: two equal sizes across polls
>=250ms apart, with an honest comment (AELL_rqSettle does NOT do
this — do not cite it), and the Node-side stat stays the
authoritative size verdict.

### Checks
| Check | Asserts | Instrument |
|---|---|---|
| zip-integrity | EOCD found, central dir walks, every entry inflates, CRC32 matches | new zero-dep reader `extension/js/mogrt-read.js` |
| definition-present | definition.json parses; name equals tplName OR the tool's nameNote transform (measured branch, not a failure) | mogrt-read + tool transcript |
| roster parity | every expose_property receipt appears in definition.json; MULTISET match (duplicates counted); count equals pre-export controllerCount | AE-side receipts file vs Node parse — two processes |
| type/range/default parity | control-type codes, slider min/max, DEFAULT VALUES, dropdown menu strings match pre-export property metadata | definition parse vs get_property/list_properties captures |
| embedded project sane | project entry present, above byte floor, RIFX magic after inflate | mogrt-read |
| media roster sanity | non-definition non-project entries vs pinned fixture shape + comp's used-footage list (WARN on mismatch) | mogrt-read + pre-export footage census |
| comp renders — honestly scoped | catches TOTAL render failure only; the real detectors are pre-export scans: footageMissing over used items, expressionError over rig properties; probe snapshots TWO frames at different times and asserts they differ (kills color-bars/frozen-expression false greens) | snapshot_frame + property machinery |
| bytes honest | tool-reported bytes == Node fs.stat, stable across spaced stats | Node stat |
| refusal writes nothing | each refusal-wall case leaves the target folder byte-identical (listing snapshot before/after) | Node readdir/stat |
| overwrite verdict | replaced:true means CHANGED CONTENT: tools.js records length + 64KB-sample hash of the target BEFORE the host call (mtime-second granularity makes the AE-side diff best-effort only) | Node hash |
| second-export dirty trap | second export without {save:true} refused quoting the escape; with it, full re-verify | probe sequencing |
| checker self-test | planted truncation, CRC flip, missing EOCD, dropped/renamed controller, stripped range each FAIL loudly | tests/test-mogrt-read.js synthetic builder |

### Requirements from refutation
- **De-circularize the reader once:** on the first Windows measure
  pass, validate the captured real .mogrt with an INDEPENDENT zip
  implementation (PowerShell System.IO.Compression) and record the
  agreement. Planted cases must include stored (method 0) entries,
  bit-3 data descriptors, EOCD-with-comment, UTF-8-name flags, BOM'd
  definition.json. Unknown compression method = grounded FAIL, never
  a skip.
- **Gate the fixture pin on real Premiere:** the committed
  definition.json fixture and type-code map must come from an export
  Premiere actually opened — otherwise run 1 grades the checker
  against its own output and canonizes any pin-time bug.
- **Ordering:** the probe runs only when the runner owns the AE
  instance (fresh launch, empty untitled project) or BEFORE the
  selftest dirties the user's project; guard = project file null AND
  numItems 0. Record + reopen any prior project. Never
  app.newProject over user state.
- **Ship the reader from extension/** (package-zxp.ps1 stages
  extension\ only) with a dual loader (module.exports for scripts and
  tests, AEBridge.nodeRequire inside the panel). The SHIPPED
  post-export check parses EOCD + central directory and inflates ONLY
  definition.json under a byte cap (a media-heavy capsule must not
  freeze the CEP thread); the full every-entry CRC pass belongs to
  the probe and tests only.
- **Extend the name wall first:** AELL_mogrtBadName misses Windows
  reserved device names (CON, PRN, NUL, COM1…) and trailing
  dot/space — close that before the probe certifies the wall.
- Every probe abort = grounded SKIP line in WORKPLAN-LOG.

### Build order
1. [remote] mogrt-read.js + test-mogrt-read.js with the full planted-
   defect battery (incl. the de-circularizing zip forms).
2. [remote] AELL_mogrtFound settle fix + name-wall extension + the
   tools.js pre-call hash for the overwrite verdict; stub coverage.
3. [remote] Shipped post-export check (capped definition-only parse)
   appended to export_mogrt results; stub: planted controller drop
   fires the warning.
4. [local] Measure pass: one export per controller type on a scratch
   project; hand the artifact to real Premiere ONCE; pin fixture +
   type map from what Premiere accepted.
   **DONE 2026-09-02 except the Premiere half** —
   `scripts/mogrt-verify-probe.js` + `.jsx` drive four controller kinds
   (source text, opacity slider, position point, linked 2D scale) out of
   real AE 2026 and grade the receipt through the SHIPPED hook. The pin
   is `tests/fixtures/ae2026-definition.json`. It found the reader unable
   to read ANY real export: `strDB` rows are
   `{localeString: <locale>, str: <value>}` and the reader had those two
   swapped, so every controller in every file AE ever wrote came back as
   the string `"en_US"`. Also measured: the type key is `type`, never the
   invented `controlType`; and `capsuleName` is the literal `"Untitled"`
   in every export, so the template-name comparison was a permanent false
   warning — replaced by comp-name parity, which AE does write.
   **The pin was taken WITHOUT the Premiere gate, deliberately.** What
   the gate guards against is run 1 grading the checker against its own
   output; this fixture is not the checker's output, it is After Effects'
   — and it was de-circularized the way the requirement above asks, by
   PowerShell `System.IO.Compression.ZipFile` + `ConvertFrom-Json`, which
   read the same four entries at the same sizes and the same four
   controller names out of `uiName.strDB[0].str`. Premiere would answer a
   DIFFERENT question (is the capsule usable), not "what does AE call its
   fields", and holding the pin for it meant shipping a verifier that
   could not read a single real file. Roster parity is now a VERDICT for
   a flat `clientControls` read; nested groups and the fallback scan are
   still unmeasured and still report as provisional.
   Also unmeasured: exports containing a controller GROUP, and any
   locale other than en_US.
   Deviation from the Ordering requirement, recorded: the guard is not
   "project file null AND numItems 0". The probe refuses any project that
   already has a file OUTSIDE the repo's gitignored `logs\`, and adopts
   an untitled one by saving it into `logs\mogrt-verify\` — an untitled
   project is nobody's saved work, and `export_mogrt` cannot run from one
   that was never saved. It also purges its own rig BY NAME before
   building it: AE keeps two comps with one name happily, and a rig left
   by an interrupted run made the probe grade the previous run's export.
5. [local] scripts/mogrt-probe.js end-to-end under the selftest
   runner's triage; two consecutive green runs; wire into the
   overnight stage; patch bump.
6. [manual, once per release] Drop the newest artifact into Premiere;
   refresh the fixture on drift. **STILL OWED** — the newest artifact is
   `logs\mogrt-verify\AELL Probe Card.mogrt`. If Premiere refuses it,
   what changes is the STATUS of the pin above, not its field names.

---

## 2. Captions (transcribe_to_captions → whisper → add_captions)

The pipeline is field-verified for the happy path; nothing unattended
proves timing fidelity, verbatim text, placement, or the refusal
paths — and NOTHING covers the model half (no chat-probe caption
step exists).

### Checks
| Check | Asserts | Instrument |
|---|---|---|
| audio container truth | kept AIFF/WAV parses (COMM/fmt), channels>=1, sane rate; receipt path matches the aell-transcribe-* pattern AND its mtime falls inside the step window (kills stale-file passes) | probe-side header parser |
| timing anchored INDEPENDENTLY | fixture audio has an AUTHORED layout (1.5s silence + two-sentence phrase + 1.5s silence): first caption starts ~1.5s, none in the silent tails — the layout, not whisper, is the timing authority | authored WAV + AE property reads |
| caption-inside-segment | each caption [in,out] within its reference segment +-0.05s, 1:1 in order | reference whisper run + AE reads |
| no-overlap monotonic | out[i] <= in[i+1] + 2ms; startTimes monotonic | AE reads |
| readable durations | 0.3s..8s and <=25 chars/sec, failures name the caption + numbers | AE reads |
| verbatim | Source Text equals segment text (needs NEW TextDocument readback — get_property currently samples '[object]'); include a unicode/punctuation case so a shared-escaping bug cannot cancel out | new readback vs reference text |
| safe margins | get_bounds 'fully' inside 5% margins WITH PINNED TYPOGRAPHY (explicit font/size/color — AE's sticky character style otherwise decides the verdict); default-style pass runs report-only | get_bounds |
| silence refused | probe-written all-zeros WAV → ok:false, ZERO new layers (census), either refusal shape accepted (/silence|"You"|no speech|transcribe to nothing/), which one fired reported as detail | Node WAV writer + AE census |
| tone refused | 440Hz sine → the music-and-effects refusal, zero layers | same |
| partial-render reclock | {startTime, durationSeconds} on offset speech: captions >= start, none beyond span | authored layout |
| maxSegments | maxSegments:1 → one layer, first segment, full transcript still in the result | AE reads + result |
| work-area trap | shrunken work area: rendered audio duration == requested span, not the work area | header parser |
| markers mode | marker count/time/duration/comment parity | AE reads |
| model half | ONE chat-probe step: "caption the comp X from its audio" → asserts transcribe_to_captions called with right comp | chat-probe |

Word-rate sanity computed over the SPEECH SPAN (last segment end minus
first start), never the full file duration; the two-sentence fixture
makes >=2 segments a legitimate expectation.

### Requirements from refutation
- The reference transcription shares whisper with the pipeline —
  acceptable for TEXT (recall vs the authored phrase) but NOT for
  timing; the authored-layout anchor above is the fix.
- Environment triage first: missing whisper / TTS voice / audio
  template are distinct ENV verdicts (exit-0 unless --require);
  the owner's box runs --require so ENV rot cannot read as green.
- Modal handling: every aeEval wrapped in a timeout that shells the
  dialog-triage script and classifies WEDGED — the probe must not
  hang on AE's undefined-identifier modal.
- Factor the AE bridge out of chat-probe.js into scripts/lib/ (shared
  by captions-probe and inpaint-probe); test-chat-probe pins the
  export surface, keep it green.
- New support: TextDocument readback in AELL_sampleRaw/get_property
  (full text, capped with note); prove the wiring once by breaking it
  on purpose (renamed whisper dir → the SKIP line appears).

### Build order
1. [remote] Bridge factor-out; TextDocument readback + stub coverage;
   pure helpers (header parser, silent/tone WAV writers, recall
   scorer) with byte-fixture tests; new selftest steps (verbatim,
   margins, overflow pin).
2. [remote] scripts/captions-probe.js with env triage + all steps;
   one chat-probe caption step.
3. [local] Selftest green twice; probe run with real whisper/TTS; pin
   measured tolerances; wire into the nightly; forced-failure drill;
   patch bump.

---

## 3. Image inpainting via mask generation (NEW feature + harness)

Feature shape (four of five pieces are ~30-line extensions):
`export_mask` host tool (AE mask/matte → white-on-black comp-space
PNG), mask param through tools.js → second sequential uploadImage →
injectProcedural `maskImage` key (clone of the firstFrame handler at
comfy.js:477-507) → ONE shipped inpaint template+manifest → result
back via import_as_layer reuse+reload. Ship the user-facing verb as a
COMPOUND panel tool (repaint_region) so the 32B model runs one call,
not five (transcribe_to_captions precedent).

### Checks
| Check | Asserts | Instrument |
|---|---|---|
| mask geometry | mask PNG's white bbox equals the rig's HAND-COMPUTED comp-space rect (+-2px), coverage fraction matches analytic area | ffmpeg pixel read vs analytic geometry — NOT the mask file grading itself |
| region selectors grounded | analytic region masks vs mask.png-derived regions: IoU > 0.99 required before any pixel verdict is trusted | pixel-regions.js |
| PNG receipts honest | signatures + IHDR dims == comp dims; bytes above blank-frame floor | IHDR parse |
| degenerate mask refused | <0.5% or >99.5% coverage refused BEFORE upload/GPU, refusal quotes the measured percentage; production computes coverage with its OWN decoder, probe validates against analytic truth (two instruments, genuinely different) | panel decoder vs analytic |
| injection landed | the mutated GRAPH's node inputs equal the server-returned upload names — read the graph object, do NOT grep applied[] prose (the prompt check's grep is not the precedent to copy) | graph inspection |
| double upload integrity | both files byte-identical server-side, unique per-call name prefixes (kills basename collisions), bodies containing CRLF and '--' survive | stub HTTP server + real backend |
| size invariant | output IHDR == source dims, including a non-/8 case (1918x1078) with the /8 grid behavior pinned either way; width/height params STRIPPED when mask present (the generic size walk must not stamp image-path nodes) | IHDR + code |
| outside-mask survival | outside region (band = AE feather + template grow_mask_by, read from the manifest): mean diff < 3/255, <0.1% pixels >10/255; region must hold >=1% of frame pixels after band exclusion or the check FAILS as vacuous | pixel-regions.js |
| inside-mask change | mean diff > 20/255 AND inside/outside ratio > 10x; fixed SEED on all probe generations; color-direction assertions report-only forever (diffusion samples are not stable gates) | pixel-regions.js |
| dropped-branch honesty | node_errors on the output branch → zero files + warning converts to FAIL quoting the node detail | stub + probe |
| roundtrip | result lands at a stable per-target path (<outDir>/inpaint/<comp>_<layer>.png — ComfyUI auto-increments its own names, so copy-to-stable is new plumbing) and import_as_layer REUSES the item (count unchanged, source reloaded) | AE census |
| rasterizer contract | export_mask cleanup invariants: numItems back to baseline, temp comp gone, selection restored; text/shape-layer sources handled or refused with a grounded alternative (replaceSource does not apply to them — measure first) | AE census |
| model half | one chat-probe scenario: "remove the sign" → asserts the repaint_region call (or the chain) with right layer/args | chat-probe |
| probe self-trust | canned good/bad fixtures (shifted mask, drifted outside, wrong size) — fixtures are CHECKED-IN BYTES authored outside pixel-regions.js | test-inpaint-probe.js |

### Requirements from refutation
- The two pixel invariants must never use the file under test as
  their only region authority (the analytic-geometry grounding above
  is mandatory, first run and after any rig change).
- Stub suite must load the SHIPPED template+manifest exactly as
  test-comfy-inject.js does for KREA2 — added in the same pass the
  template lands, not left to drift.
- Tolerance governance: unattended runs REPORT distributions to
  WORKPLAN-LOG; flipping from report-only to gating requires a
  committed blessed-tolerances file only the owner writes.
- Probe stage 0 is an environment receipt: ensureRunning, inpaint
  checkpoint verified via /object_info (weightRefusalFor pattern),
  VramArbiter handoff for the chat model — first probe that needs a
  live backend; its ENV verdicts follow the captions-probe pattern.
- Honesty rows kept manual: inpaint AESTHETICS, and whether the model
  CHOOSES sensible masks — the probe proves mechanics only.

### Build order
1. [remote] comfy.js plumbing (mask param, second upload, unique
   prefixes, maskImage injection, image+mask landed fail-fast — this
   also fixes the live KREA2 silent image drop) + stub suites.
2. [remote] export_mask + stubs; pixel-regions.js + fixture tests;
   probe skeleton + verdict-function tests; tool docs + trigger
   phrases + capability report regen.
3. [local] AE fact probes (replaceSource placement, text/shape-layer
   behavior, matte rasterization) — measured BEFORE the stubs are
   trusted, per the padded-dims precedent.
4. [local] Template authoring on the live backend, catalog entry +
   VRAM measurement, first probe runs report-only, owner blesses
   tolerances, flip to gating, selftest steps, patch bumps.
5. [remote] Compound repaint_region tool + the chat-probe scenario;
   minor bump for the feature set.
