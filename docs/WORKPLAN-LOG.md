# Work log — local (real-AE) session

Append-only. Every unattended pass (`scripts/run-local-agent.ps1`) starts
a FRESH session with no memory of the last one, so this file is the only
thing carrying progress forward. Read it before picking work; write to it
before you stop.

One entry per pass, newest at the bottom:

```
## YYYY-MM-DD HH:MM — <workplan item>
- Changed: <files + what, one or two lines>
- Harness: <passed>/<total>  (or: could not run, why)
- Notes: <assumptions made, anything blocked, anything a human must look at>
```

Keep entries short. If something needs the remote session (a release, a
ComfyUI decision, an architecture call), say so under Notes rather than
building it here.

---

## 2026-08-20 — baseline

Nothing done yet. The first overnight attempt did zero passes: the local
clone predated `docs/WORKPLAN.md`, and a turn-based session has no loop —
it ran the harness once and idled. `scripts/run-local-agent.ps1` is the
fix. Start from item 1 of `docs/WORKPLAN.md`.

## 2026-08-20 09:41 — items 1 and 2 (first bullet)

- Changed: `scripts/ae-selftest.jsx` — `var final` was an ES3
  FutureReservedWord, so AE rejected the WHOLE file at compile time and
  the harness had never once run from the CLI. Added
  `tests/test-es3-syntax.js` (scans, does not execute — Node cannot
  catch this by running the code) covering every ExtendScript-compiled
  file. Added two steps to `extension/js/selftest.js` proving the grid
  rig EVALUATES, plus an args-aware stub in `tests/test-self-test.js`.
- Harness: 26/26 (was 24). Green under BOTH expression engines,
  `javascript-1.0` and legacy `extendscript`. Stubbed suite 11/11.
- Notes: the exit-3 message points at the "Allow Scripts to Write
  Files" preference — that is a RED HERRING. A compile error in the
  runner produces the same exit 3, because the try/catch that writes
  the results file never runs either. Worse, the resulting modal
  DISABLES AE's main window, so every later `AfterFX.exe -r` is
  silently swallowed while AE still looks healthy and responsive. If a
  pass ever sees exit 3, check for a `#32770` dialog on the AfterFX
  process before believing the preference story.
  Also verified (not just assumed) that bad expressions really are
  rejected under both engines — a bogus layer reference and the 2D
  `value[2]` trap — so the expression greens are not false passes.
  Left for the remote session: `run-ae-selftest.ps1` should surface a
  blocking dialog's text instead of its generic timeout, and
  `writeOut()` in the runner should not depend on `AELLJSON`, so a load
  failure can still report itself. Project expression engine was
  flipped during testing and restored to `javascript-1.0`.
  Next up in item 2: `center_anchor_point` on rotated/scaled/parented
  layers, then `scale_comp` with cameras and keyframed properties —
  the two most likely to be hiding a real bug behind stub-only proof.

## 2026-08-20 (remote) — the two follow-ups logged above

- Changed: `scripts/ae-selftest.jsx` — `writeOut()` no longer depends on
  `AELLJSON`; it serializes with a self-contained escaper, so a failure
  to load hostscript.jsx can now report itself instead of throwing
  inside the catch block meant to report it. Error text also carries
  `err.line` when AE provides it. `scripts/run-ae-selftest.ps1` — new
  exit code 4: polls for a `#32770` dialog owned by AfterFX during the
  wait and prints its caption plus child text, instead of timing out
  after 240s and blaming the scripting preference. The generated
  wrapper also try/catches `$.evalFile` and writes what it caught.
- Harness: NOT run from here (no AE, no PowerShell in the remote
  environment). Stubbed suite 11/11, both scripts verified pure ASCII.
- Notes: the dialog probe is the reliable path; the wrapper's try/catch
  is best-effort because a COMPILE error may surface as a modal rather
  than a catchable exception — unverified either way, so the probe does
  not depend on it. First real exercise of exit 4 happens on the AE
  machine. To test it deliberately: put `var final = 1;` in
  `scripts/ae-selftest.jsx`, run the harness, expect exit 4 with the
  dialog text rather than a 4-minute timeout.

## 2026-08-20 (remote) — harden the dialog probe

- Changed: `scripts/run-ae-selftest.ps1`. Three faults in the probe I
  shipped an hour ago, all found by asking what a green run actually
  exercises. (1) `Add-Type` and `FindDialog` failures were swallowed
  into `''`, making a BROKEN probe indistinguishable from "no dialog" —
  the same silent-degradation shape as the bug this all started with.
  Both now print a WARNING. (2) The probe keyed off window class
  `#32770`; AE also raises its own DroverLord-classed windows, which it
  would have missed. It now treats a DISABLED main window as the
  authoritative modal signal and uses class only to gather text.
  (3) `Add-Type` is guarded against re-entry via `PSTypeName`.
- Harness: NOT run from here. Stubbed suite 11/11, file pure ASCII.
- Notes: a green 26/26 run DOES execute `Get-BlockingDialog` at least
  once (the wait loop calls it before re-testing for results), so it
  proves the probe compiles and returns empty without throwing. It does
  NOT exercise the enumeration, the child-text walk, or exit 4 — that
  needs a real modal. Deliberate test: put `var final = 1;` in
  `scripts/ae-selftest.jsx`, run the harness, expect exit 4 naming the
  dialog within seconds instead of a 240s timeout, then revert.

## 2026-08-20 (remote) — center_anchor_point: real bug + the stub that hid it

- Changed: `extension/jsx/hostscript.jsx` `center_anchor_point`, and new
  `tests/test-anchor-point.js` (18 assertions). Also made
  `tests/test-curve-tools.js`'s `Prop.setValue` throw on keyframed
  properties, matching AE.
- Harness: NOT run from here. Stubbed suite 12/12.
- Notes: the tool wrote Position with `setValue()`, which real AE REFUSES
  on a keyframed property — so it failed on any animated layer, the
  normal case for this panel. It now offsets EVERY Position key by the
  compensation delta. An animated Anchor Point now returns a grounded
  error (there is no single value to centre) instead of AE's raw throw,
  and an expression-driven Position gets a WARNING in the note because
  the write is accepted but never visible.
  It had ZERO stubbed coverage — that is why it survived. The new stub
  models two things the older ones did not: `setValue` throws when
  `numKeys > 0`, and 2D Position/Anchor are PADDED to 3 components (the
  older stub padded only Scale, so `value.length > 2` was false there
  and true in AE — the exact infidelity behind the original grid bug).
  Parenting needs no special case: Position is already in the parent's
  space and the delta is carried there by the layer's own scale and
  rotation. That is reasoned, not observed — worth confirming.
- FOR THE LOCAL SESSION (item 2, next): verify in real AE, then promote
  to `selftest.js`. Build a layer with Position keys, rotate it, scale
  it, parent it to a null, run `center_anchor_point`, and confirm the
  layer does not visually jump at ANY key time (not just the current
  one). Then the same on a 3D layer and on a text layer, where
  `sourceRectAtTime` moves with the content.

## 2026-08-20 (remote) — scale_comp: cameras, driven transforms, honest counts

- Changed: `extension/jsx/hostscript.jsx` `scale_comp`; new
  `tests/test-scale-comp.js` (16 assertions, incl. a camera stub).
- Harness: NOT run from here. Stubbed suite 13/13.
- Notes: three faults, all invisible to the old plain-2D-layer coverage.
  (1) Cameras and lights AIM at a Point of Interest held in COMP space
  (matchName "ADBE Anchor Point" on those layer types). It was never
  re-centred, so resizing a comp silently re-framed the shot — the
  camera kept aiming where things used to be. Now re-centred like
  Position. (2) An expression-driven transform ACCEPTS the write and
  ignores it, so rigged layers were counted as "scaled" when they had
  not moved. Since grid_layout rigs Position with expressions, this hit
  a headline feature. Driven layers are now named in the result with a
  WARNING. (3) A layer that genuinely failed (locked, refused write) was
  folded into the "inherited" count, reading as though its parent had
  handled it. Failures are now listed separately with their reasons.
- FOR THE LOCAL SESSION (item 2): verify in real AE. Build a comp with a
  two-node camera aimed at an off-centre object, resize with scale_comp,
  and confirm the framing is IDENTICAL before and after — that is the
  one that cannot be proven by stub. Then run scale_comp on a comp built
  by grid_layout and confirm the WARNING appears and the rig really does
  need re-running. Confirm keyframed Position/Scale survive (that path
  goes through AELL_mapPropValues and is stub-proven only).

## 2026-08-20 (remote) — grounded refusals for animated/driven properties

- Changed: `extension/jsx/hostscript.jsx` — new `AELL_writeValue` helper,
  used by `set_transform`, `set_effect_param`, `set_property` and
  `distribute_property`. Cases added to `tests/test-curve-tools.js`.
- Harness: NOT run from here. Stubbed suite 13/13, ES3 clean.
- Notes: swept every `setValue` call site after noticing that the whole
  day's bugs were ONE bug — something fails or is ignored and reports
  success. AE refuses `setValue` on a KEYFRAMED property (raw throw) and
  silently ignores it on an EXPRESSION-DRIVEN one (false success). Four
  core setters hit one or both. They now return the keyframe count and
  name `{atTime: …}` as the way out, or warn that an expression is
  overriding the write. `distribute_property` additionally no longer
  ABORTS on the first unwritable layer — it applies the rest and reports
  which were skipped and why, instead of leaving a partial spread that
  claims full coverage.
- FOR THE LOCAL SESSION: worth a real-AE spot check that AE's refusal
  really is `numKeys > 0` and not something narrower (e.g. whether
  setValue on a keyed property throws or silently sets the value at the
  current time). Everything here assumes it throws. If it does NOT
  throw, these guards are still correct behaviour but the reasoning in
  the comments needs amending.

## 2026-08-20 10:29 — item 2: scale_comp with cameras (verified in real AE)

- Changed: `extension/jsx/hostscript.jsx` scale_comp — skip Scale on
  cameras/lights, and only re-centre Point of Interest when the layer
  actually aims at it. `tests/test-scale-comp.js` — stub now models
  hidden properties and autoOrient, plus a one-node camera case.
- Harness: 26/26 real AE. Stubbed suite 13/13.
- Notes: PR #28 ("keep the camera's aim") did NOT work in real AE. A
  camera HAS a Scale that resolves but is hidden; writing it throws, and
  that throw aborted the layer AFTER Position had been written — so any
  comp with a camera came out half scaled, zoom and aim untouched, and
  the camera reported in layersSkipped. The honest skip-reporting from
  #28 is what made this findable.
  Hard-won AE facts, both cost real time here:
  (1) resolvability is NOT settability, and the flags LIE — a hidden
  Scale still reports elided=false and enabled=true, so layer type is
  the only reliable test;
  (2) `addCamera` yields autoOrient=4214 (aims at POI, settable), while
  a one-node camera is 4212 and its POI throws.
  The old stub gave a FALSE GREEN on the camera assertions because its
  camera had a plain settable Scale. It now reproduces the real failure
  with AE's own message, and fails against the pre-fix host.
  Not done: no selftest.js step for cameras. The scratch comp's
  scale_comp step resizes the whole comp, so adding a camera there risks
  destabilising the other 25 steps — stub coverage is the safer home
  unless the remote session wants a dedicated camera scratch comp.

## 2026-08-20 (remote) — #30 merged; camera harness gap handed back

- Changed: `docs/WORKPLAN.md` — new item 2b specifying camera coverage
  for the real-AE suite.
- Harness: NOT run from here. Nothing else touched.
- Notes: #30 verified and merged (4316dfc). The finding was correct and
  the fix is right: #28's camera branch was unreachable because a
  camera's hidden Scale threw first, and its stub could not express
  that. Confirmed here independently by running the new test against the
  pre-fix host — four assertions fail with AE's real error text,
  including two that #28 itself had asserted and got wrong.
  The harness camera gap is NOT being built remotely on purpose. Blind
  AE code from this session was wrong twice today (the ES3 reserved
  word, and #28's unreachable branch), each time costing a local pass to
  debug. Item 2b is a spec instead — build and verify it in one pass
  where AE is.

## 2026-08-20 10:56 — item 2b: cameras in the real-AE suite (built + verified)

- Changed: `extension/js/selftest.js` — 10 camera steps in their OWN
  scratch comp (`AELL Self-Test Cam`, created and deleted inside the
  group). `extension/jsx/hostscript.jsx` — add_camera gained
  `oneNode`. `extension/js/tools.js` — documented it.
  `tests/test-self-test.js` — canned camera responses.
- Harness: 36/36 real AE (was 26). Stubbed suite 13/13.
- Notes: PROVEN to catch the regression, not just to pass. Ran the new
  suite in real AE against the pre-fix host (f1db027): 32/36, failing
  exactly the four camera steps, with `layersSkipped` naming AE's own
  "property or a parent property is hidden" for BOTH cameras. That is
  the assertion item 2b asked for.
  Needed a host change to be buildable at all: there was NO way to make
  a one-node camera through the tool layer, so add_camera now takes
  `oneNode: true` (sets autoOrient NO_AUTO_ORIENT). It must be set
  BEFORE any Point of Interest write, because a one-node camera hides
  that property and the write throws — passing both `oneNode` and
  `pointOfInterest` is now a grounded error instead.
  Expectations are absolute, not relative: an 800x600 comp halved makes
  zoom 1000 -> 500 and POI [400,300] -> [200,150], so the steps cannot
  pass vacuously by comparing a value to itself.
  NOT done: the light. The spec said "if cheap" and it is not — there
  is no add_light tool at all, so covering lights means a new tool.
  Flagging rather than building it: a new tool is the remote session's
  call, and the same aim-not-scale rule is already proven for cameras.

## 2026-08-20 (remote) — 0.9.0 released

- Changed: version bumped in all four places (manifest x2, version.js,
  update.json) plus release notes.
- Notes: everything merged today sat in `main` at 0.8.0, and the panel's
  update gate is `compareVersions(feed.panelVersion, VERSION) > 0` —
  equal versions offer NO update, and the dev-install git pull only runs
  after an update is detected. So the installed panel was still running
  the morning's code, including the center_anchor_point bug that breaks
  on any animated layer. Merging to main is NOT shipping; the feed is
  version-gated. Bump when the fixes should reach a real panel.

## 2026-08-20 14:07 — item 2: text (add_text_layer / set_text_style)

- Changed: `extension/jsx/hostscript.jsx` — validate fonts before
  writing them (new `AELL_fontProblem`), and accept `leading: "auto"`.
  `extension/js/tools.js` docs. 3 text steps in
  `extension/js/selftest.js`. New `tests/test-text-style.js`.
- Harness: 39/39 real AE (was 36). Stubbed suite 14/14.
- Notes: real bug — an UNINSTALLED font was silently accepted. AE stores
  the bogus PostScript name verbatim, renders a substituted face, and
  the tool returned ok=true, so the model believed "use Futura" worked.
  The obvious check does NOT work: getFontsByPostScriptName ECHOES
  whatever name it is handed, so comparing names proves nothing. The
  only reliable tell is `isSubstitute` on the FontObject — false for a
  real font, true for a made-up one. Also note `app.fonts.allFonts` is
  an array of ARRAYS (FontObject is one level in), and a FontObject
  cannot be string-concatenated at all ("invalid numeric result").
  Refusals are grounded: asking for "Arial" now answers "not installed
  ... Installed and matching: ArialMT" — the PostScript-vs-family-name
  confusion is exactly what the small model will hit.
  Second, smaller gap: once leading was a number there was no way back
  to auto. AE clamps leading 0 to ~0.01 and leaves autoLeading false, so
  line spacing collapsed instead of resetting. `leading: "auto"` now
  works and the summary reports "auto".
  The refusal cannot live in the real-AE suite: its runner treats
  ok=false as a step FAILURE, so negative cases have no home there. That
  is why the font work is covered by a stub test instead — it fails on
  7 assertions against the pre-fix host. If negative coverage matters in
  the harness, the runner needs an expectFail flag; flagging rather than
  changing the runner unilaterally.

## 2026-08-20 (remote) — shipping no longer waits on anyone

- Changed: `scripts/bump-version.js` (new), `CLAUDE.md` shipping rules,
  the unattended-loop prompt in `scripts/run-local-agent.ps1`. Bumped to
  0.9.1 so the font/text work actually reaches a panel.
- Notes: CI runs on `main` AND `claude/**` and the feed-publish step has
  NO branch condition — a dev-branch push already ships. The PR/merge
  cycle gates nothing; it is bookkeeping. The only real gate is the
  version, and the old rules forbade the local session from bumping,
  which is what made shipping wait on the remote session.
  The local session now bumps PATCH itself for anything it verified in
  real AE. Remote keeps MINOR/MAJOR and the merges to main, batched.
  `bump-version.js` is Node, not PowerShell, so it can be tested
  anywhere — both paths exercised here (refuses an equal version,
  rewrites and re-verifies all four declarations).

## 2026-08-21 — item 2: center_anchor_point on rotated/scaled/parented

- Changed: `extension/jsx/hostscript.jsx` — compensation delta is now
  computed at EACH Position keyframe's own time (new `AELL_anchorDelta`,
  `AELL_isAnimated`) instead of once at the current time.
  `extension/js/selftest.js` — 19 steps in their OWN scratch comp
  (`AELL Self-Test Anchor`). `tests/test-anchor-point.js` +5 assertions
  and a `valueAtTime` stub; `tests/test-self-test.js` canned responses;
  `extension/js/tools.js` doc. Bumped to 0.9.2.
- Harness: 58/58 real AE (was 39). Stubbed suite 14/14.
- Notes: real bug. Scale and Rotation can be ANIMATED THEMSELVES, which
  makes the anchor->Position delta time-dependent. The old code took one
  delta at `comp.time` and applied it to every Position key, so the layer
  sat still at the current time and drifted everywhere else — measured
  37.6px at t=2 on a text layer with keyed Position + Rotation + Scale
  under a rotated, non-uniformly scaled parent. Now 0.0000 at both keys.
  Measurement method worth reusing: a probe null whose Position
  expression is `thisComp.layer("X").toComp([0,0], t)` reads the target's
  own origin in comp space, so "did the layer move" becomes an exact
  numeric comparison through parenting, rotation and scale — and
  `toComp` takes a TIME argument, so one probe per time needs no
  scrubbing (there is no tool to move the playhead). Read back with
  `get_property` on the probe; AE evaluates the expression for it.
  Proven to catch the regression, not just to pass: the pre-fix host
  scores 56/58 in real AE, failing exactly the t=2 step (27.36px jump)
  and the note step. The stub test fails 5 assertions pre-fix.
  Confirmed the remote session's reasoning that PARENTING needs no
  special case — with a static rig the drift is 0.0000 at every sampled
  time, not just at keys, under a parent scaled [80,120] and rotated 30.
  Residual, disclosed not fixed: when Scale/Rotation animate, the
  compensation is exact AT the Position keys and off by up to ~10px
  BETWEEN them, because the interpolated Position cannot follow a
  rotating frame. Making it exact would mean adding Position keys at
  every Scale/Rotation key — a change to the user's animation the tool
  should not make silently, so the note says so instead. If the remote
  session wants that, it belongs behind an explicit arg.
  Not done from the remote session's list: the same check on a 3D layer.
  `center_anchor_point` deliberately does not compensate 3D layers at
  all (it says so in the note), so there is nothing to verify until
  someone decides 3D compensation should exist — that is a feature call,
  not a fix.

## 2026-08-21 — item 2: scale_comp on keyframes and parented chains

- Changed: `extension/jsx/hostscript.jsx` — new `AELL_scaleKeyInterp` /
  `AELL_scalePropValues`; scale_comp now scales spatial tangents and
  temporal ease speeds alongside key values, re-zooms PARENTED cameras
  (new `parentedCamerasRezoomed`), and reports easing it could not
  rescale (`keyframeEasingNotScaled`) instead of swallowing it.
  `extension/js/selftest.js` — 16 steps in the existing camera scratch
  comp. `tests/test-scale-comp.js` +17 assertions and a keyframe-aware
  stub; `tests/test-self-test.js` canned responses; `tools.js` doc.
  Bumped to 0.9.3.
- Harness: 74/74 real AE (was 58). Stubbed suite 14/14.
- Notes: three real bugs, none of which touch a key VALUE — which is why
  every existing assertion passed over them. Measured in an 800x600 comp
  halved: (1) spatial tangents stayed full-size, so a curved motion path
  ran 37.3px off course between keys; (2) ease speed is units/second and
  did not scale, 33px off; (3) a camera parented to a null kept zoom
  1000, silently re-framing the shot — zoom lives in Camera Options, so
  parenting inherits none of it. Verified with a probe null whose
  expression is `<target>.position.valueAtTime(t)`: get_property reads
  the evaluated result, so "did the motion keep its shape" is an exact
  number without scrubbing (there is no tool to move the playhead).
  The first fix was WRONG and the harness is what caught it — my probe
  had set eases by hand with influence 33 on every side, so it passed,
  while apply_keyframe_ease eases only the FACING sides of a pair and
  the far sides read back influence 0. `new KeyframeEase(speed, 0)`
  THROWS ("Value 0 out of range 0.1 to 100"), so rebuilding an ease from
  what AE just reported aborted the whole key. Zero-speed sides are now
  passed through as the original objects. Two more AE facts, both now in
  the stub: `setTemporalEaseAtKey` flips BOTH sides of a key to BEZIER
  even a HOLD one (so the types are captured and restored), and it
  refuses an ease array of the wrong length — 3 for Scale on a 2D layer,
  1 for a spatial property. Auto-bezier keys are deliberately left
  alone: AE recomputes those handles from the scaled values, and writing
  them would only switch auto off.
  Proven to catch the regression, not just to pass: the pre-fix host
  scores 71/74 in real AE (parentedCamerasRezoomed empty, 35.9px off
  course, zoom 1000) and fails 6 stub assertions.
  Parented non-camera layers verified correct as-is: a child under a
  parent rotated 20 and scaled [80,120] tracked to 0.0000 at five
  sampled times, so the "children inherit" shortcut is sound.
  NOT done, disclosed: a LIGHT's pixel-valued options (falloff distance,
  shadow diffusion) are not scaled, same as the native script. There is
  still no add_light tool, so this cannot be covered in the harness
  either — flagging rather than building a tool.

## 2026-08-21 — item 2: split_layer_into_chunks on real footage

- Changed: `extension/jsx/hostscript.jsx` — cuts now land on whole COMP
  frames, sub-frame chunk lengths are refused with a grounded error, and
  a final remainder too short to hold a frame is folded away and
  reported (`dropped`) instead of shipped as an empty layer. Reported
  in/out went 2 -> 4 decimals so a frame time survives the rounding.
  `extension/js/selftest.js` — 6 steps in their OWN scratch comp
  (`AELL Self-Test Chunks`). `tests/test-layer-chunks.js` +16
  assertions, and the stub gained the two things it was missing.
  `extension/js/tools.js` doc. Bumped to 0.9.4.
- Harness: 80/80 real AE (was 74). Stubbed suite 14/14.
- Notes: real bug, and the honest version of "verify seamless playback"
  turned out to be about FRAMES, not seconds. AE does not snap in/out
  points for you — asking for 3.66667s stores 2.83570963541667-style
  values on its own fine internal time base, nowhere near the frame
  grid. Two consequences, both measured against a real 10s 24fps mp4
  (made with ffmpeg, imported, trimmed to 2s..7s in a 25fps comp):
  (1) every cut landed mid-frame, so the pieces came out arbitrary frame
  lengths and the edit could not be reproduced by hand;
  (2) worse, splitting a 0.5s span into 30 pieces left 17 of the 30
  layers rendering NOTHING — a piece whose in and out fall between the
  same two frames is accepted silently and never appears — while the
  tool reported "30 chunks, seamless". Same bug class as the rest of
  this week: it fails and says it worked.
  What was NOT broken, now measured rather than assumed: frame-level
  tiling was already gap-free and overlap-free (checked `activeAtTime`
  at every frame of the span); `startTime` survives on every duplicate,
  so each piece shows the source frames it did before the cut; a
  time-STRETCHED footage layer keeps its stretch through duplicate and
  trim (note the property is `layer.stretch` — `timeStretch` silently
  reads `undefined`, which cost a probe run); `offsetPerChunk` moves
  in/out along with startTime as intended.
  Proven to catch the regression, not just to pass: the pre-fix host
  scores 78/80 in real AE, failing exactly the two new frame steps
  ("cut 1 lands mid-frame at 62.70 frames", "chunk 3 spans
  85.071..107.357 frames"), and fails 10 stub assertions.
  Stub fidelity: the stubbed comps had NO frame rate at all, which is
  precisely why mid-frame cuts were invisible to CI. `Comp` now carries
  `frameRate`/`frameDuration` and `Layer` carries a footage
  `srcDuration` with AE's real clamping (measured: startTime 1 with a
  10s source, `inPoint = 0.2` comes back 1 and `outPoint = 13` comes
  back 11 — no throw, no warning).
- FOR THE REMOTE SESSION, two things this pass deliberately did not
  build:
  (1) There is NO way to put an imported footage item into a comp
  through the tool layer. `import_file` lands it in the project and
  nothing can place it — there is no `add_footage_layer`, and
  `comp.layers.add` is never called for footage anywhere in
  hostscript.jsx. That is a real hole in a panel that generates media
  with ComfyUI, and it is also why the permanent harness step above
  uses a trimmed SOLID: real footage cannot be built inside the suite
  without a new tool. Footage itself was verified by hand this pass
  (the mp4 above); a new tool is a feature call, so it is flagged, not
  built.
  (2) `set_layer_timing` reports ok=true after AE has silently clamped
  the write to the source range. It does return the actual values, so
  the truth is in the result, but nothing tells the model the number it
  asked for was not the number it got. Same shape as the writes
  `AELL_writeValue` already guards. Cheap fix, but it is a different
  tool from this item.

## 2026-08-21 — item 2: distribute_property step mode + reorder_layers

- Changed: `extension/jsx/hostscript.jsx` — new `AELL_stableSort` and
  `AELL_nameCompare`; `AELL_targetLayers` now treats an EXPLICIT `layers`
  list as an order and only sorts it when `order` is passed; every sort
  in `AELL_targetLayers` and `reorder_layers` is stable with a
  deterministic tie-break; `reorder_layers` sorts names naturally and
  reports the slots it landed in plus how many untargeted layers it
  pushed aside. `extension/js/selftest.js` — 11 steps in their OWN
  scratch comp (`AELL Self-Test Order`). `tests/test-curve-tools.js` +6
  assertions, `tests/test-layer-chunks.js` +8, both behind a shim that
  makes Node's sort unstable; `tests/test-self-test.js` canned
  responses; `extension/js/tools.js` docs for all three tools. Bumped to
  0.9.5.
- Harness: 91/91 real AE (was 80). Stubbed suite 14/14.
- Notes: real bug, and the one the stubs could never have found by
  running, because Node's `Array.sort` is STABLE and ExtendScript's is
  not. `AELL_targetLayers` re-sorted the caller's list by `inPoint` —
  and every layer in a fresh grid sits at inPoint 0, so the key tied on
  all of them. Measured on five solids in AE 2026: `distribute_property
  {layers: [P1..P5], property: position_x, from: 100, step: 100}`
  handed the slots out as P2,P3,P4,P5,P1, and the SAME call with the
  list reversed gave P4,P3,P2,P1,P5 — neither the caller's order nor
  the stack's, and not repeatable. "Space these six every 100px" was a
  shuffle that reported success. Note the existing stub tests all
  passed `order: "stack"` explicitly; whoever wrote them had already
  worked around the default without naming it.
  Second real bug, same probe: `reorder_layers {by: "name"}` compared
  names as strings, so 12 layers sorted to ST Ord, ST Ord 10, ST Ord
  11, ST Ord 12, ST Ord 2, … — and AE layer names are numbered far more
  often than alphabetic (`split_layer_into_chunks` alone emits "X 1"..
  "X 30"). Digit runs now compare as numbers.
  Third, milder: with tied keys `reorder_layers` restacked layers that
  had no reason to move (six solids all at startTime 0 came back with
  one yanked to the top). Ties now keep the stack they had, which means
  the tie-break direction has to FLIP with ascending/descending, since
  `sorted` is bottom-first for one and top-first for the other.
  Proven to catch the regression, not just to pass: the pre-fix host
  scores 84/91 in real AE, failing exactly the 7 new ordering steps
  ("slot 0 went to ST Ord 2, not ST Ord"; "ST Ord 12 sits at x=1100,
  not 1200"; "stacked ST Ord | ST Ord 10 | ST Ord 11 | ST Ord 12 | ST
  Ord 2 | …"), and fails 10 stub assertions.
  Stub fidelity, the interesting part: this bug class is INVISIBLE to
  Node, whose sort is stable, so a stub that just runs the code proves
  nothing. `withUnstableSort()` in both test files swaps
  `Array.prototype.sort` for one that permutes before sorting — a
  legal unstable sort, which disturbs tied keys ONLY. Correct code is
  unaffected; code that leans on stability fails. Worth reusing for any
  future ordering work.
  Also verified, not changed: reordering a SUBSET pulls its members
  contiguous and shoves whatever sat between them out of the way
  (measured: reordering s2/s4/s6 of six layers displaced s3 and s5).
  That is the tool's documented cluster behaviour and the right call,
  but it was silent — the result now carries `displaced` and says so in
  the note.
- FOR THE REMOTE SESSION: `AELL_targetLayers`'s default for a SELECTION
  (no explicit list) is still `inPoint`, and `comp.selectedLayers` has
  no meaningful order of its own, so "select nine squares and space
  them every 100px" still resolves through a key that ties on all of
  them. It is now deterministic (stable sort keeps AE's selection
  order) but it is not necessarily the order the user has in mind.
  Making the selection default `stack` would be a behaviour change to a
  shipped tool — flagging it rather than deciding it here.

## 2026-08-21 — item 2: set_mask_path keyframes (does the mask ANIMATE?)

- Changed: `extension/jsx/hostscript.jsx` — `set_mask_path` now refuses
  keys whose point counts disagree (new `AELL_maskKeyPoints` /
  `AELL_maskPointMix`), validates the WHOLE batch before writing any key,
  snaps key times onto whole comp frames, refuses two keys that land on
  the same frame, refuses a static path over an animated mask in its own
  words, checks tangent lists are one-per-vertex, and reports `points`,
  `keyTimes`, `keyFrames`, `snappedToFrames` and `stillFrame`.
  `scripts/ae-selftest.jsx` — the setTimeout shim QUEUES and drains from
  the top level instead of calling straight through.
  `extension/js/selftest.js` — new `expectError` step kind (the suite
  could not reach a single grounded refusal before) plus 17 steps in
  their own 25 fps comp (`AELL Self-Test Mask`).
  `tests/test-shape-mask-tools.js` +16 assertions and a stub that models
  AE's constant-vertex-count behaviour; `tests/test-self-test.js` canned
  mask host, an inverted-step check, and the flat-stack proof;
  `extension/js/tools.js` doc. Bumped to 0.9.6.
- Harness: 109/109 real AE (was 91). Stubbed suite 14/14.
- Notes: the worst bug found so far, and it is not really a mask bug.
  Feeding `set_mask_path` two keys with DIFFERENT point counts made AE
  queue a modal warning ("deleting points or feathers from an animated
  mask path deletes them from all keyframes… Preserve Constant Vertex and
  Feather Count") that appears AFTER the script returns and DISABLES AE's
  main window. Every later `AfterFX.exe -r` is then swallowed in silence
  while the process still reports Responding=True — which is exactly what
  happened to this pass: three probe runs and a one-line file-write test
  all "succeeded" with exit 0 and produced nothing. A chat panel cannot
  click that dialog, so one bad mask call ends the session. The dialog is
  the same failure mode the 2026-08-20 09:41 entry warned about for
  compile errors; the difference is that a TOOL can now cause it.
  It also does not animate. Measured in a 30 fps comp: a 3-point key at
  t=0 and a 5-point key at t=1 read back as the 5-point shape at every
  sampled frame after the first — AE holds and POPS, it does not tween,
  while numKeys read 2 and the tool returned "Mask path animated". The
  old selftest step checked `keysSet === 2`, which is true either way.
  Second real bug, same shape as the chunk fix: key times were stored
  exactly as asked. 0.34s and 0.71s in a 30 fps comp landed on frames
  10.2 and 21.3, and frame 21 then read 197.3px instead of the 200 that
  was asked for — the requested shape is on no renderable frame at all.
  Times now snap to the nearest frame, and two requests that collide on
  one frame are refused instead of one key silently vanishing (keysSet
  said 3, numKeys said 2, and nothing named the key that was lost).
  Third: the write loop was not atomic. A bad key in the middle left the
  earlier ones on the property, so a refusal still changed the animation.
  Measured pre-fix: the mismatch step left numKeys at 4 instead of 3.
  How "does it animate" is measured at all: there is no tool that moves
  the playhead and `keyValue` only returns the keys themselves, so the
  suite hangs a probe null on
  `thisComp.layer("X").mask("Y").maskPath.points(t)[1]` and reads its
  Position — the mask shape at an arbitrary time, as an exact number.
  Proven to catch the regression, not just to pass: the pre-fix host
  scores 102/109 in real AE, failing exactly the 7 new mask steps
  ("expected a refusal, but the tool accepted the call"; "vertex 1 sits
  at x=265.81 on frame 10, not 280"; "numKeys 4, not 3"; and AE's own
  raw "Can not call setValue() on a property with keyframes"). The stub
  suite fails 10 assertions.
  Stub fidelity: the stubbed comp had no frame rate (again), the stubbed
  Prop had no `valueAtTime` at all — so "does it interpolate" was a
  question CI could not even ask — and `setValue` never threw on a keyed
  property. All three are modelled now, including a module-level
  `AE_MODALS` list: any stubbed call that would have raised AE's modal
  pushes onto it, and the suite fails if anything is left there. That is
  the assertion that maps a CI failure onto "you just froze After
  Effects".
  One thing I could not pin down and am not claiming: AE raised the modal
  the FIRST time a mismatched write happened in a session, but the
  pre-fix harness run later did the same thing without blocking. It looks
  session-deduplicated. The refusal does not depend on how often it
  fires, but do not read "no dialog this time" as "it is safe".
- Also fixed, because it stopped the suite dead: adding these steps took
  the suite past ~100 and the CLI runner died with "Stack overrun". Its
  setTimeout shim ran `fn()` on the spot, and `selftest.js` ends each
  step with `setTimeout(step)`, so every step nested inside the previous
  one — a suite-length limit nobody knew was there, presenting as a
  crash rather than a failing step. The shim now queues and a top-level
  loop drains it, so depth is flat at any length.
  `tests/test-self-test.js` proves both halves: the queue stays one frame
  deep, and the old pass-through nests once per step (109 for 109).
- FOR THE REMOTE SESSION, one thing this pass deliberately did not build:
  refusing mismatched point counts is the honest call, but it does mean a
  deliberate POP (a hard cut between two different shapes) is now
  unreachable through this tool. If that is wanted it belongs behind an
  explicit arg, and it should still refuse when it would raise the modal
  — an intentional pop is not worth a frozen application.

## 2026-08-21 — item 1: the harness itself (cold-start false alarms)

- Changed: `scripts/run-ae-selftest.ps1` — AE is launched with
  `Start-Process` instead of the call operator; the window probe FINDS
  AE's application window by class instead of trusting
  `MainWindowHandle`; the wait loop decides through the new
  `scripts/lib/ae-dialog-triage.ps1` (verdicts clear / running / startup
  / unreadable / blocked, each with its own patience); exit 3 now says
  which kind of nothing happened, and exit 4 names the likely cause of a
  wordless popup. New `tests/test-selftest-runner.js` (31 assertions,
  drives the triage functions themselves plus a compile check on the
  probe's C#). Bumped to 0.9.7.
- Harness: 109/109 real AE, exit 0, from a COLD start in 9s. Stubbed
  suite 15/15.
- Notes: the suite was never broken this pass — the thing that reports on
  it was, and only when After Effects was not already running. That is
  exactly the unattended case, so every one of these bugs was invisible
  to a human who runs the harness with AE open.
  Bug 1, the false alarm. AE disables its main window for as long as a
  `-r` script runs and puts up its own progress window. The runner read
  "main window disabled" as "AE is stuck on a modal", so a cold run
  printed "After Effects is BLOCKED on a modal dialog" and exited 4 —
  with the dialog it named being `Executing Script
  aell-selftest-run.jsx...`, i.e. proof the suite was running fine. The
  results file, 109/109, landed one second later. Measured cold-launch
  timeline: nothing for ~6s, two untitled popups at 3-5s, application
  window at 7s, progress window 9-10s, results at 11s.
  Bug 2, and worse: `& $AfterFXPath -r $wrapper | Out-Null`. When AE is
  already up, `-r` hands the script to that instance and the launcher
  exits immediately — which is why this looked fine for months. Cold,
  the process PowerShell started IS After Effects, it holds stdout open
  for its whole life (GPU warnings, asio logs), and the pipeline waits
  for it. Measured: results file written at 24s, harness still blocked
  ten minutes later, never reaching its own wait loop. An unattended
  loop would hang there indefinitely, not fail.
  Bug 3, found while fixing 1 and 2 and the nastiest of the three: the
  probe could not see the ONE state where AE can never run a script.
  Before AE opens its application window there is no main window, so
  Windows hands out whatever popup is up as `MainWindowHandle` — and
  that popup is ENABLED, so "is the main window disabled?" answered no.
  After AE is killed or crashes it reopens behind a recovery prompt that
  blocks startup, and the harness reported that as the
  scripting-file-access preference, 240s later. The probe now locates
  `AE_CApplication*` itself and says "After Effects has not opened its
  main window yet".
  Why patience, not just filtering: an untitled popup is genuinely
  ambiguous. The same 381x237 wordless window shows up for one poll as
  the progress dialog tears down AND sits there forever when AE is
  wedged — AE draws its own dialogs, so Win32 reads no text out of
  either. So a verdict has to survive consecutive polls before it stops
  the run (blocked 3, unreadable 8), and "startup" never stops it at
  all, because a healthy cold launch looks stuck for its first 5s.
  Proven to catch the regression, not just to pass: with the pre-fix
  rules restored, 9 of the new assertions fail, including the recorded
  cold-start timeline and every startup case. Re-breaking the C#
  constant fails the compile assertion with AE's own "Newline in
  constant".
  Stub fidelity: the decision lives in a dot-sourced .ps1 so the Node
  test drives the REAL functions rather than a paraphrase, and every
  sample fed to them is verbatim probe output captured from AE 2026 on
  this machine — the progress window, the wordless teardown popup, the
  startup popups, and the mask warning from the 2026-08-21 entry. The
  test skips loudly on non-Windows (CI is windows-latest, where it runs).
- FOR THE REMOTE SESSION / the human, one thing measured and NOT fixed:
  every cold harness run ends with AE wedged behind its own "Save
  changes to 'Untitled Project.aep'?" prompt (screenshotted with
  PrintWindow to read it, since Win32 gets no text out of AE's
  dialogs). The suite never asks AE to quit, so the close request comes
  from the environment — AE is a child of the PowerShell that launched
  it, and when that exits AE is asked to close while the scratch project
  is dirty. Consequence for the loop: pass N leaves AE blocked, pass N+1
  meets a wordless popup and now exits 4 after ~16s with the right
  explanation instead of hanging, but it still loses the pass. Nothing
  scripted can clear it — no `-r` script runs while it is up. Two ways
  out, both a call for someone else: have the loop answer the prompt
  (Cancel is safe; WM_CLOSE to the `#32770` does it, verified twice
  here), or have the harness leave AE running rather than being torn
  down with its launcher. Do NOT reach for `Stop-Process` on AE: a hard
  kill is what makes the NEXT launch open the startup recovery dialog,
  which was bug 3's whole scenario.

## 2026-08-21 — item 2 (last bullet): for_each_layer at 50+ layers

- Changed: `extension/jsx/hostscript.jsx` — `for_each_layer` now validates
  the TOOL before the layers, against three explicit lists
  (`AELL_PER_LAYER_LIST` / `AELL_PER_LAYER_READ_LIST` /
  `AELL_ALREADY_BATCHED_LIST`) via `AELL_whyNotPerLayer`, and every
  refusal names what IS drivable. The 5-failure abort now says the
  earlier layers were already changed. `extension/js/tools.js` — the doc
  says which tools qualify and which are called once instead.
  `extension/js/selftest.js` — 15 steps in their own comp
  (`AELL Self-Test Batch`, 60 layers). New `tests/test-for-each-layer.js`
  (33 assertions). `tests/test-self-test.js` — canned batch host that
  reads the host's own three lists out of hostscript.jsx. Bumped to 0.9.8.
- Harness: 124/124 real AE (was 109). Stubbed suite 16/16 files.
- Notes: TIMING is a non-issue and that is worth writing down so nobody
  optimizes it again — 60 solids, `for_each_layer {tool: "apply_effect"}`
  in AE 2026: 89 ms, all 60 layers verified to carry the effect. Input
  payload for a 60-name call is 562 chars, the result is 83; the
  evalScript limits the workplan worried about are three orders of
  magnitude away. Also measured and NOT broken: the injected
  `layers[i].index` is a LIVE read, so tools that reshuffle the stack
  mid-loop still hit the right layer — `duplicate_layer` over A1/A3/A5 of
  six duplicated exactly those three, and `delete_layer` over B2/B4/B6
  deleted exactly those three.
  The real bug is that `for_each_layer` would run ANY name in
  `AELL_TOOLS`, not just layer tools. Measured pre-fix in AE 2026:
  `{tool: "add_solid"}` over two layers returned
  `{ok: true, succeeded: 2}` and made two solids BOTH named "spawned",
  and `{tool: "create_comp"}` over two layers returned
  `{ok: true, succeeded: 2}` and left two junk comps in the project. The
  injected `{layer}` was simply ignored, so the call silently became "run
  this comp-level tool N times" while reporting per-layer success — at
  the 60-layer scale this tool exists for, that is 60 junk comps and a
  green result. The tool's own error string already promised "'tool' must
  name a layer tool"; nothing enforced it.
  Two smaller ones on the same gate. Tools with their own `{layers}` list
  (grid_layout, set_keyframes, distribute_property, …) were run once per
  layer with `sub.layers` deleted, so a 60-layer grid_layout became 60
  single-layer grid_layouts reported as success. And READ tools were
  accepted although `for_each_layer` returns only counts:
  `{tool: "get_property"}` over 60 layers answered "succeeded: 60" and
  discarded all 60 values, which for a model asking a question is worse
  than a refusal. Both are refused in the tool's own words now.
  Proven to catch the regression, not just to pass: with the old
  permissive check restored, the pre-fix host scores 118/124 in real AE,
  failing exactly the 6 new refusal steps — including the two that
  measure the DAMAGE rather than the message ("project grew from 159 to
  161 items — the refused tool ran anyway", "comp holds 120 layers, not
  60"). The stub suite fails 7 assertions on the same host.
  Stub fidelity: `tests/test-for-each-layer.js` does not hard-code the
  three lists. It re-derives them by scanning hostscript.jsx for each
  `AELL_TOOLS.<name>` body and classifying it by what it reads
  (`args.layer` / `AELL_layerOrSelection` = per-layer; `args.layers` /
  `AELL_layersOrSelection` / `AELL_targetLayers` = already batched;
  neither = not a layer tool), then asserts the shipped tables agree —
  so a NEW tool added later cannot quietly fall through unclassified, and
  a typo in a table shows up as a ghost name. `tests/test-self-test.js`
  reads the same three lists out of the host rather than paraphrasing
  them, so a suite step that expects a refusal for a tool the host
  actually drives fails there too.
- FOR THE REMOTE SESSION, two things deliberately not built here:
  (1) There is still no BATCH READ. `for_each_layer` now refuses
  get_property honestly, but "what is the position of these 60 layers"
  has no one-call answer short of get_comp_details, which does not carry
  property values. A `get_property {layers: [...]}` returning one row per
  layer is the obvious shape; it is a new tool surface, not a fix.
  (2) `for_each_layer` is one undo group but is NOT atomic — the 5-failure
  abort returns ok:false with 55 layers already changed. It now SAYS so,
  which is the honest minimum, but a real two-phase version (validate the
  sub-call against every layer, then write) would be better and is a
  design call.
- Housekeeping for whoever runs the next pass: the live AE scratch project
  is up to ~206 items, mostly solid footage accumulated by every selftest
  run plus this pass's probes (probe comps removed; the loosened-host run
  deliberately created junk comps and those are gone too). The harness is
  green at that size and create_comp auto-numbers on collision, so it
  breaks nothing — but nothing prunes it either, and no pass has ever
  reset the project. If it ever needs doing, do it with
  `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)` + `app.newProject()`
  from a `-r` script, never `Stop-Process` (see the 2026-08-21 harness
  entry: a hard kill is what brings up the startup recovery dialog).

## 2026-08-21 — item 4: undo hygiene (one chat command, one Ctrl+Z)

- Changed: `extension/jsx/hostscript.jsx` — factored `AELL_runTool` out of
  `AELL_call` (run a tool with NO undo group of its own) and added
  `$.global.AELL_callBatch(commandsJson)`, which runs `[{tool, args}, ...]`
  inside ONE undo group and returns one result row per command. It is not
  in `AELL_TOOLS`, so the model can never call it.
  `extension/js/tools.js` — `executeCommands` now fuses CONSECUTIVE host
  commands into a single `AELL_callBatch`; panel-side tools (comfy_*),
  unknown names, malformed commands and dry-run stubs each end the current
  run and are still handled one at a time. New `callHostBatch`, and the
  two U+2028/U+2029 escapers collapsed into one `jsxJsonLiteral`.
  `extension/js/selftest.js` — steps may now be `{batch: [...]}`;
  `extension/js/main.js` + `scripts/ae-selftest.jsx` pass `callHostBatch`
  (it is optional — a runner without it falls back to one call per command,
  so order and per-command outcomes are still checked).
  New `tests/test-undo-groups.js` (56 assertions). Bumped to 0.9.9.
- Harness: 130/130 real AE (was 124). Stubbed suite 17/17 files.
- Notes: the workplan bullet as written — "verify for the batch tools" —
  came back GREEN, and measuring it is what found the real bug next door.
  Probe: run the tool, snapshot the comp, `app.executeCommand(16)` once,
  compare. All thirteen that ran reverted in exactly ONE step:
  grid_layout(6), set_keyframes(6 layers), stagger_layers(6),
  distribute_property(6), for_each_layer apply_effect(6),
  duplicate_layer(3), reorder_layers, scale_comp(0.5),
  split_layer_into_chunks, set_track_matte, precompose(2), add_mask,
  center_anchor_point. So no single tool was ever the problem.
  Three AE facts measured on the way, in the order they killed my theories.
  (1) `AELL_MUTATING` is complete — 48 entries, 5 read tools, no ghosts —
  so the "a tool missing from the hand-maintained list costs many undos"
  theory had nothing to hang on. (2) Worse for it: with `grid_layout`
  DELETED from `AELL_MUTATING` at runtime, the call still cost exactly ONE
  Ctrl+Z. AE implicitly groups a whole script execution, so the explicit
  group only supplies the Edit-menu LABEL. Anyone tempted to "fix" undo by
  auditing that table should read this paragraph first.
  (3) The one that decided the design: an undo group does NOT survive the
  end of the script execution that opened it. Two `-r` runs, group opened
  and P1 moved in the first, P2 moved and `endUndoGroup()` called in the
  second: one undo brought back P2 only, P1 stayed put. So bracketing a
  chat round with separate begin/end evalScripts — the obvious fix, and the
  one I would have shipped blind — cannot work. Tools that must share a
  Ctrl+Z have to run in ONE call.
  Which is the actual bug: `executeCommands` ran up to 20 commands as 20
  separate `evalScript`s, so "make a 4x4 grid of squares and fade them in"
  cost the user one Ctrl+Z per tool call, each labelled with a tool name
  they never typed. Now it is one, labelled "AE Llama: add_solid +4 more".
  Deliberate trade, written down because it is a real loss: `shouldStop`
  (user cancel) is now checked between RUNS, not between every command. A
  fused run of host tools is uninterruptible. It is worth it — the slow
  part of a round is the model, not the tools (60 layers of apply_effect
  is 89 ms, from the for_each_layer pass), and cancelling between two 5 ms
  writes buys nothing while a half-applied round costs the user their undo.
  Proven to catch the regression, not just to pass: restore the per-command
  path (`batchable` returns false) and 8 assertions fail, starting with
  "five host commands cost ONE evalScript (got 5)"; drop the group from
  `AELL_callBatch` and 4 fail, including "FOUR tools cost ONE undo group
  (got 0)". Both re-verified after the file was made to fail softly rather
  than throw.
  Stub fidelity, and the one that earned its keep: the first harness run
  came back 128/130 because `set_transform` takes `{property, value}`, not
  `{position: [...]}` — but `tests/test-self-test.js` had accepted my
  malformed step, because its canned host read `args.position` and asked
  nothing. The stub was more permissive than AE, which is the exact failure
  mode these files exist to prevent. It now rejects any `property` outside
  AE's own list; put the bad step back and CI drops to 128/130 too.
  `tests/test-undo-groups.js` also cross-checks the two hand-maintained
  "this tool mutates" tables (hostscript's `AELL_MUTATING` and tools.js's
  `mutating:` flags) against each other and against `AELL_TOOLS`, so a tool
  added to one and not the other is caught — that drift costs an undo
  label on the host side and a wrong dry-run decision on the panel side.
  Found and fixed while writing the test: my own `AELL_callBatch` guard was
  `typeof cmds.length !== "number"`, which a JSON *string* passes — so
  `AELL_callBatch('"not an array"')` ran twelve one-character "commands"
  and returned ok. It asks `Object.prototype.toString` now.
- FOR THE REMOTE SESSION, one thing measured and NOT built: a chat round
  that MIXES host tools with a `comfy_generate` still costs one Ctrl+Z per
  run, because a panel-side tool has to break the fusion — it is async and
  imports its result into AE itself. Two runs of host tools around one
  generation is three undo steps. Fixing that means giving panel tools a
  way to join a host undo group across an await, which the measurement
  above says is impossible in the current shape; it needs a design, not a
  patch.
- Housekeeping: the probe scripts were deliberate `-r` runs against the
  live scratch project and cleaned up after themselves (comps named
  "AELL Undo Probe*" are removed by the probes; the harness's own
  "AELL Self-Test Undo" comp is deleted by its cleanup step). The
  ungrouped-`grid_layout` experiment restored `AELL_MUTATING.grid_layout`
  in the same run — it was a runtime `delete`, never a file edit.

## 2026-08-21 — item 4: performance at 200 layers (and what it found)

- Changed: `extension/jsx/hostscript.jsx` — `get_comp_details` and
  `get_project_info` now cap their model-facing lists (`AELL_LIST_LIMIT`
  = 40) instead of dumping the whole comp/project. New args on
  get_comp_details: `start` (1-based) and `limit` (0 = every layer);
  `limit` on get_project_info. Results carry `layersShown`/`itemsShown`
  and, when clipped, a grounded `note` naming the true total and how to
  page. SELECTED layers are always included even from outside the window,
  the ACTIVE comp is never dropped from the item list, and footage is
  dropped before comps/folders.
  `extension/js/tools.js` — `fetchProjectState` moved here from main.js
  (so the budgeting is testable without a panel) and rewritten: it drops
  WHOLE ROWS until the state fits 6000 bytes instead of byte-slicing, and
  writes `activeComp` FIRST so the project list can never starve it.
  `extension/js/main.js` — delegates to it. `extension/js/visualizer.js`
  — both of its get_comp_details calls pass `limit: 0` (it counts the
  user's selection and needs every layer). Tool docs updated.
  New `tests/test-context-budget.js` (44 assertions).
  `tests/test-self-test.js` — canned host now windows its layer list and
  answers get_project_info with a real 403-item project. Bumped 0.9.10.
- Harness: 136/136 real AE (was 130). Stubbed suite 18/18 files.
- Notes: the workplan bullet asked for wall time, and wall time is FINE —
  nothing is anywhere near the ~5s flag. Measured on 200 solids in AE
  2026: grid_layout 323-558 ms, set_keyframes (200 layers x 3 keys, 600
  keys) 180-908 ms, stagger_layers 46-76 ms, distribute_property 63-87 ms,
  for_each_layer apply_effect 441-889 ms, apply_keyframe_ease 247-296 ms,
  reorder_layers 361-366 ms, building the 200 solids itself 333-374 ms.
  Ranges are two runs; the spread is run-to-run noise, not load.
  What the same probe found is the real bug, and it is not about time —
  it is about what the MODEL is told. On a 200-layer comp in a 206-item
  project the state block the panel puts in every system prompt measured
  49198 bytes (get_project_info 27082, get_comp_details 22128) against a
  6000-byte guard implemented as `json.slice(0, 6000)`. Because `project`
  was serialized first, 206 project items ate the entire budget and the
  probe measured what reached the model:
      layer entries visible to model: 0 of 200
      selected layer visible: false
  Not truncated — ABSENT. The system prompt tells the model in so many
  words to read `selected: true` out of the comp details to resolve "the
  selected layers", and on any real-sized project there were no comp
  details at all. A byte slice also cuts mid-object, so the fragment that
  did arrive was unparseable JSON. This is invisible to every existing
  test because the scratch comps are small: the suite's biggest comp is
  60 layers, and 60 layers fit.
  Fixed at both ends deliberately, because either alone still loses: the
  host bounds its own lists where the omission can be DESCRIBED (a
  grounded note, the way every other refusal in this codebase works), and
  the panel drops whole rows in priority order rather than cutting bytes.
  Priorities are the ones a failure would punish: selected layers, then
  the active comp, then other comps/folders, then footage — every one of
  those is a name the model has to quote back as an argument, whereas
  footage is what a project accumulates. The live scratch project is 426
  items, 425 of them accumulated solids: exactly the shape that used to
  push the comp out.
  Proven to catch the regression, not just to pass: set AELL_LIST_LIMIT
  to 100000 and real AE scores 132/136, failing exactly the four new cap
  steps — including "a capped comp still serializes to 7967 bytes", which
  is the field measurement in miniature on a 60-layer comp. The same
  loosened host fails 9 assertions in tests/test-context-budget.js and
  fails tests/test-self-test.js outright.
  Coverage trap found on the way, and worth knowing: capping the list
  silently WEAKENED an existing step. "batch: every one of the 60 really
  carries the blur" iterates `d.layers`, so with a 40-row cap it would
  have gone on passing while checking 40 of 60. It passes `limit: 0` now
  and asserts it really received 60 rows. Any future step that enumerates
  a whole comp has to do the same.
  Stub fidelity: `tests/test-self-test.js` does not hard-code the cap —
  it reads `AELL_LIST_LIMIT` out of hostscript.jsx and windows its canned
  layer list the same way, and its get_project_info now answers with the
  comps this run actually created rather than a constant, so a step that
  looks for a comp by name is really being asked something.
  Perf footnote: the capped get_comp_details is FASTER on the 200-layer
  comp (8 ms vs 35 ms) despite the extra pass that scans every layer's
  `selected` flag — building 40 rows beats building 201.
- FOR THE REMOTE SESSION, one thing measured and NOT fixed here: the
  WRITE tools echo one row per layer (grid_layout `placed`,
  distribute_property `applied`, stagger_layers `placed`), which is
  6271-6952 bytes at 200 layers against `compactToolResults`' 1200-byte
  per-result cap — so the model reads a summary followed by ~30 rows cut
  mid-object. It is much less harmful than the state bug (those results
  lead with their summary fields, which survive) and capping them touches
  six tools plus their assertions, so it wants a deliberate pass rather
  than a ride-along. The honest shape is probably the same one used here:
  a bounded echo plus a count.
- Housekeeping: probes ran against the live scratch project and cleaned
  up after themselves (the "AELL Perf Probe" comp is removed at the end
  of each probe; the loosened-cap harness run created nothing new). The
  AELL_LIST_LIMIT = 100000 experiment was a temp edit, restored from a
  backup copy and re-verified green before committing.

## 2026-08-21 — item 4: run the panel like a user (the model's half)

- Changed: new `scripts/chat-probe.js` — the product path with no panel:
  the user's real `settings.json` -> `extension/js/settings.js` ->
  `llama.js` (real llama-server, real JSON schema) -> `tools.js` (real
  system prompt, real command fusion) -> REAL After Effects, driven by
  eight canned sentences a motion designer would type. Each step ends
  with a read-only ExtendScript verdict against the comp, and a markdown
  transcript lands in `logs/`. `--bridge-check` proves the AE round trip
  (0.3s) before a model is loaded; `--steps 2,7` re-runs a subset.
  Fix it found, in `extension/jsx/hostscript.jsx`: `AELL_writeValue` now
  READS THE PROPERTY BACK after a write AE accepted, and
  `distribute_property` reports a layer the expression swallowed under
  `overriddenByExpression`, never under `applied`. `set_property`,
  `set_transform` and `set_effect_param` gained `applied: false` beside
  their warning. Five new steps in `extension/js/selftest.js`; new
  assertions plus a stub-fidelity fix in `tests/test-curve-tools.js` and
  `tests/test-self-test.js`. Bumped 0.9.11.
- Harness: 141/141 real AE (was 136/136). Stubbed suite 18/18 files.
  Chat probe 7/8 before the fix, and the failing step is 3/3 after it.
- Notes: the failing transcript, verbatim (steps 2 and 7 of the
  checklist, Qwen2.5-32B, temp 0.7):
      >> add nine red 200x200 square solids and arrange them in a 3 by 3
         grid  ->  grid_layout {columns: 3}          (rigs Position)
      >> spread the nine squares out equally across the width
         -> distribute_property {property: "position_x", from: 200,
            to: 1720, step: 180}
         ok: {"applied":[{"layer":"Red Square","value":200}, …nine rows…]}
      == FAIL — gaps uneven: [940,940,940,960,960,960,960,980,980,980]
  Nothing moved. `grid_layout` had rigged Position to an expression, AE
  ACCEPTS every setValue that follows and shows none of them, and the
  tool answered with nine `applied` rows of x values that were not in
  the comp. The honest half existed — a `warnings` array — but it sat
  AFTER the applied rows and measured ~1600 chars against the panel's
  1200-char per-result cap, so on a real comp the truth is what gets
  cut. This is the same bug shape as every other one this week
  (something is ignored and reports success), one layer up: the tool was
  reporting its REQUEST as its RESULT.
  The fix is to ask AE instead of guessing. `expressionEnabled` is not
  the question — an expression can CONSUME the written value
  (`value + wiggle(2, 30)` really does move) or IGNORE it (a rig that
  computes from scratch). On a driven property `.value` is the EVALUATED
  result, so the write is followed by a read and the two are compared;
  only a real mismatch is reported, and the message quotes the value the
  comp actually shows.
  Proven in the field, not just in tests: re-running the same two
  sentences, the model read "9 of 9 layer(s) did NOT move … clear it
  first (set_expression with expression: \"\")", cleared all nine
  expressions itself, re-ran the distribution and got
  [200, 390, 580, 770, 960, 1150, 1340, 1530, 1720]. That is the
  grounded-errors doctrine doing exactly what it is for — the honest
  refusal was worth more than the write.
  Proven to catch the regression, not just to pass: drop the read-back
  and `tests/test-curve-tools.js` fails 2 assertions; report overridden
  layers as applied and it fails 3 more. The stub had to be fixed first
  — its `Prop.value` handed back the last written value even while
  driven, which is precisely why CI was green through a bug the field
  caught in one sentence. It now returns the expression's answer, with a
  "passthru" mode for the `value`-consuming case.
  One honest oddity, left as is: with the squares still rigged, the
  CENTRE square reports as applied, because the rig happens to compute
  the same x (960) the spread wanted. The comp really does show 960
  there, so the report is true.
  The full eight-step re-run after the fix scores 7/8, and the one red
  step is the MODEL's doing, not a tool's: its first attempt called
  duplicate_layer before add_solid had made anything to duplicate, and
  after the (correctly grounded) error it retried the whole round — so
  the comp ended with TEN red squares, nine spread evenly and one orphan
  parked at the centre. Every tool behaved; nothing rolls a half-failed
  round back. Filed under item 4 rather than fixed here.
- FOR THE REMOTE SESSION, two things the probe measured and did NOT fix
  (each wants its own pass; both are in `docs/WORKPLAN.md` item 4):
  `stagger_layers` `spread` is a TOTAL, so "stagger them 4 frames apart"
  became `spread: 0.133` across nine layers — 0.5 frames each, and the
  tool reported it happily; and `add_text_layer` inherits AE's
  last-used character style (a request for "white, 120px" came back with
  tracking 251 and PowerCentra-Book).
- Housekeeping: the probe sweeps its own comps and unused solids before
  AND after each run. The "after" sweep is why: the first run's cleanup
  passed `delete_item {name: …}` when the tool takes `{item: …}`, the
  comp survived, and the next run's create_comp was auto-numbered to
  "Probe Room 2" while the verdicts still read "Probe Room" — every
  check silently inspecting the previous run's comp. Transcripts live in
  `logs/`, which is gitignored, so the failing one is quoted above.

## 2026-08-21 — item 4 follow-up: stagger_layers spread is a TOTAL

- Changed: `extension/jsx/hostscript.jsx` — `stagger_layers` grew a GAP
  mode beside its curve mode: `step` (seconds between consecutive
  layers) and `stepFrames` (frames), which is the unit designers
  actually speak. `spread` still means the TOTAL span, and asking for
  both is now a refusal that spells out which is which (and does the
  arithmetic: "for these 9 layers, spread 1.067 == step 0.133"). Curve
  mode reports `perLayer`/`perLayerFrames`, and a spread that works out
  to UNDER ONE FRAME per layer says so and names the argument that fixes
  it. Gap mode reports `step`/`stepFrames`/total `spread`, says when a
  bezier went unused, and flags step 0 or a sub-frame step. New helpers
  `AELL_r3` and `AELL_numArg` (a quoted "0.5" is a number a small model
  really does send; the strict typeof check dropped it silently).
  `extension/js/tools.js` — tool doc rewritten gap-first, plus two
  system-prompt lines ("stagger them X frames apart" = {stepFrames: X};
  spread is the whole stagger, not the gap). `extension/index.html` —
  visualizer's Spread field is labelled TOTAL. Four new steps in
  `extension/js/selftest.js`, incl. a get_comp_details read-back proving
  REAL AE holds the 4-frame gaps. `tests/test-curve-tools.js` +9
  assertions and a frame grid on the stub comp; `tests/test-self-test.js`
  canned host models both units and the refusal, and remembers where it
  put the layers so the read-back step is really being asked something.
  `scripts/chat-probe.js` step 3 verdict tightened. Bumped 0.9.12.
- Harness: 145/145 real AE (was 141/141). Stubbed suite 18/18 files.
  Chat probe steps 1-3: 3/3.
- Notes: the field re-run is the proof this item wanted. Same sentence
  as the failing probe ("Fade all nine squares in ... and stagger them 4
  frames apart"), and the model's FIRST call was
  `stagger_layers {stepFrames: 4, spread: 1, startAt: 0}` — it reached
  for the new argument but belt-and-braced the old one. The refusal
  caught it, the model dropped `spread` in the next round, and the comp
  came out at 0, 0.133, 0.267 ... 1.067: exactly 4 frames apart, with
  set_keyframes {relativeTo: "inPoint"} keeping the fades on the
  staggered starts. Before this pass the same sentence produced
  `spread: 0.133` — 0.0166s per layer, half a frame, every square
  effectively on the same frame — reported as nine cheerful placements.
  Assumption made, worth a second opinion: sending both units is a
  REFUSAL rather than a "step wins" precedence. It costs one extra round
  when the model hedges (as it did here), but a silent precedence rule
  is how the original bug felt from the user's side — something was
  ignored and the answer said success. The grounded error also teaches;
  precedence cannot.
  The probe's old verdict for that step only asked whether the start
  times were DISTINCT, which the half-frame stagger satisfied — so the
  step was green on the run that filed the bug. It now measures the gaps
  against the comp's frame duration and accepts either staggered layer
  starts or staggered first keys (the model may legitimately do it
  either way), and prints the measured gaps in frames when it fails.
  Proven to catch the regression, not just to pass: make the host ignore
  step/stepFrames (the old tool) and `tests/test-curve-tools.js` fails 6
  assertions; keep gap mode but drop the sub-frame warning and it fails
  1. The sub-frame warning is invisible to `tests/test-self-test.js` by
  construction — that suite stubs the host rather than running it, so
  the warning's only stub-side catcher is test-curve-tools.js and its
  only field catcher is the new selftest step.
  Nothing blocked. Still open under item 4 for later passes:
  add_text_layer inheriting AE's last-used character style, no rollback
  for a round that fails part way, and the untouched ComfyUI/second-turn
  parts of the checklist.

## 2026-08-21 - item 4 follow-up: add_text_layer inherits AE's character panel

- Decision made (the item asked me to decide): YES, normalize -- but only
  when CREATING. `add_text_layer` now starts every new layer from a
  documented baseline (white, 72px, tracking 0, auto leading, left, no
  faux bold/italic, no stroke, baselineShift/tsume 0, h/v scale 1, and a
  VERIFIED-installed plain sans) and applies the caller's args on top, so
  anything asked for still wins. `inheritStyle: true` is the way back to
  AE's own behaviour for someone who set the Character panel up on
  purpose. `set_text_style` deliberately does NOT normalize: it edits a
  layer the user already owns, and resetting fields they never mentioned
  would destroy their work.
- Changed: `extension/jsx/hostscript.jsx` -- `AELL_TEXT_BASELINE`,
  `AELL_TEXT_STUCK`, `AELL_TEXT_FONTS`, `AELL_defaultFont` (cached,
  isSubstitute-verified via the existing `AELL_fontProblem`),
  `AELL_normalizeTextDoc`, `AELL_stuckStyleWarning`;
  `AELL_applyTextStyle` takes an optional `reset` so baseline and args
  land in ONE setValue; the style summary now reports `fillColor` too, so
  "white" is visible in the answer instead of assumed. Results carry
  `styleReset: true` (or `inheritedStyle: true`). `extension/js/tools.js`
  tool doc + one system-prompt line telling the model NOT to chase
  add_text_layer with a corrective set_text_style. Four new steps in
  `extension/js/selftest.js` (baseline, explicit-args-win, and two
  delete_layer cleanups). `tests/test-text-style.js` +25 assertions.
- Harness: 149/149 real AE (was 145/145). Stubbed suite 18/18 files.
  Bumped 0.9.13.
- What real AE actually said, since none of this was guessable:
  a plain `add_text_layer` on this machine returned PowerCentra-Book at
  66px, tracking 251, autoLeading OFF at 92, fill [0.06,0.18,0.28] --
  and superscript ON. It is the same shape as every other bug this week:
  something inherited, nothing said. After the fix the same call returns
  ArialMT 72 tracking 0 auto white, and asking for 120px white gives
  ArialMT 120 white.
- THE TRAP, measured not assumed: allCaps, smallCaps, superscript and
  subscript are READ-ONLY on a TextDocument in AE 2026 ("Unable to set
  <name>. It is a readOnly attribute."). So an inherited superscript
  CANNOT be cleared from script at all -- and it is not a lying getter:
  "HXhx" at fontSize 100 in Arial measured h=41.7 top=-75 via
  sourceRectAtTime, i.e. ~58% size and raised, which is real superscript
  rendering. The tool therefore REPORTS it and names the Character panel
  as the only place it can be fixed, rather than shipping tiny raised
  text that looks like the panel is broken.
  Two shortcuts that do not work, so nobody re-tries them:
  `textProp.setValue(new TextDocument("A"))` does NOT reset the style --
  every field came back identical, so there is no cheap "give me
  defaults" call; and `app.fonts.getDefaultFontForCTScript` exists but
  `getCTScriptForString` wants 2 parameters and the script id is an
  unsigned int, not a "kCTScriptRoman" string, so the default-font API
  was not usable here. Hence the candidate list (ArialMT, SegoeUI,
  Verdana, TimesNewRomanPSMT, CourierNewPSMT), each checked with
  isSubstitute===false before use; if none resolve the inherited font is
  kept rather than a bogus name written.
  Also: scripting setValue does NOT feed the Character panel back. A
  third addText after normalizing the second still inherited the dirty
  style -- which is good news (the tool cannot disturb what the user's
  next manual text layer looks like) but means a stub cannot dirty the
  panel from script, so the harness steps assert the CONTRACT (tracking
  0, auto leading, 72px, a font reported) rather than "inheritance
  happened". On this machine they are a genuine before/after anyway.
- Proven to catch the regression, not just to pass. Against
  `tests/test-text-style.js`: drop normalization entirely -> 13
  assertions fail; "fix" it by assigning the read-only fields (the
  obvious wrong fix, which THROWS in real AE) -> add_text_layer fails
  outright and 10 more fall over; normalize on `set_text_style` too ->
  3 assertions fail, including the one guarding a partial restyle. The
  stub had to grow real teeth first: its TextDocument now has throwing
  setters for the four read-only fields, and `comp.layers.addText()`
  hands back the measured Character-panel state instead of clean
  defaults.
- Assumptions worth a second opinion: 72px as the default size is a
  choice, not a measurement (AE has no readable default); and the font
  candidate list is Windows-centric. Both are one-line edits if the
  remote session disagrees.
- Nothing blocked. Still open under item 4 for later passes: no rollback
  for a chat round that fails part way, and the untouched ComfyUI /
  second-turn / mixed-undo parts of the probe checklist. Worth
  considering separately: `set_text_style` has no `reset: true`, so a
  layer the USER made by hand still cannot be cleaned up by asking --
  deliberately left out of this pass to keep editing non-destructive.
