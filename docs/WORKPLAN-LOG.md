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

## 2026-08-25 — item 2c: inventory the owner's real ComfyUI install

- Changed: `docs/COMFY_LOCAL_INVENTORY.md` (new, 608 lines). Filesystem
  read only — ComfyUI was never launched. 256 weight files / 1011.3 GB
  tabulated by kind-folder, all 70 custom node packs attributed to a
  repo from `.git/config` or `pyproject.toml`.
- Harness: not run (docs only, no code touched). No version bump.
- Notes, in rough order of how much they change the remote session's
  plan:
  - Code and data are in DIFFERENT roots. `Documents\ComfyUI` holds
    models/custom_nodes/user but has no `comfy/` package; the code that
    actually runs is
    `AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI`.
    An installer that derives one root from the other is wrong here.
  - Version is **0.32.0** (from the running instance's own startup log,
    2026-08-25). The manifest asks for `>=0.3.76`, and lexically
    `"0.32.0" < "0.3.76"` — the gate MUST compare component-wise. Two
    other version sources on this disk disagree and are both stale: the
    Programs bundle says 0.22.2, May logs say 0.20.1. There is no git
    checkout, so no tag to read.
  - All five Krea manifest models resolve by EXACT filename, so the
    register-existing matcher does not need fuzzy matching — and must
    not use it: `krea2Dmergev3_int8ConvrotV3.safetensors` is within
    1 MB of the real `krea2_turbo_int8_convrot.safetensors` and is a
    different model. Six more Krea-named neighbours are listed.
  - `depth_anything_v2_vitl.pth` lives in
    `custom_nodes/comfyui_controlnet_aux/ckpts/`, NOT under `models/`.
    A have-I-got-it check scoped to `models/` re-downloads 1.3 GB that
    is already on disk.
  - Every manifest UNKNOWN node is attributed: Krea2Control* ->
    `comfyui-krea2-controlnet` (facok), ArcaneBloomFX -> `crt-nodes`,
    `easy cleanGpuUsed` -> `comfyui-easy-use`,
    DepthAnythingV2Preprocessor -> `comfyui_controlnet_aux` AND
    `comfyui-art-venture`. That last one is defined TWICE, so the
    depth-control branch binds to whichever pack loads last — pin it
    before that branch ever ships un-bypassed.
  - MiniMax H3 is half provisioned: turbo LoRAs (3) and the video VAE
    are here, the base/transformer weight is nowhere on disk. That tier
    is BLOCKED — needs a decision from the owner (was H3 being run
    against ComfyUI's built-in API nodes?).
  - Wan 2.2 is complete in three precisions (fp16 / fp8 / Q8 GGUF) plus
    14 LoRAs, so a Wan tier needs no downloads at all.
  - There is no `extra_model_paths.yaml`; Desktop uses
    `AppData\Roaming\ComfyUI\extra_models_config.yaml`, which declares
    one model root and a SECOND custom-node root inside the Programs
    bundle. Nothing lives on another drive.
  - Hardware for the tier ceilings: RTX 5090, 32607 MB VRAM, 62852 MB
    RAM, torch 2.10.0+cu130.

## 2026-08-25 — item 4 (ROLLBACK): four field measurements before building

Design was approved on both open calls (one rollback per request;
read-only failures do not trigger it). This pass measured the four
things the design said must be true in real AE first. **All four came
back clean**, so the mechanism is viable as designed.

- Changed: nothing in the product. Probe lived in the scratchpad; the
  open project was left exactly as found (empty — the two leftover
  items the probe made, a Solids folder and its solid, were removed).
- Harness: not run (no product code changed this step).
- AE 26.3x87.

**M1 — does a net-zero sentinel create an undo entry?** YES, and the
control proves it is needed:

  - comment set + restore inside one group: registered. One Undo ate the
    sentinel group and the change BEFORE it survived intact.
  - addFolder + remove inside one group: also registered, no stray
    folder left behind.
  - **an EMPTY group registers NOTHING** — one Undo reached straight
    past it and reverted the previous change. This is the overshoot
    hazard, confirmed by measurement rather than assumed. The sentinel
    is therefore load-bearing, not belt-and-braces: without it, a batch
    whose mutating tools all no-op would eat the user's last edit.
  - Going with the comment sentinel (cheaper than an item add/remove,
    and it cannot disturb the project panel's selection).

**M2 — does ONE Undo cleanly reverse the project-level tools?** YES for
all three; none of them need excluding from a rollback-eligible batch:

  - `import_file`: numItems 0 -> 1 -> 0.
  - `add_to_render_queue`: renderQueue 0 -> 1 -> 0. (Worth recording —
    render-queue edits being undoable was the one I most expected to
    fail.)
  - `delete_item`: comp present -> gone -> back.

**M3 — fingerprint cost on a 200-layer comp:**

  - full fingerprint (position/scale/rotation/opacity keys/effects/
    masks/parent/timing per layer): **20 ms**, 11013 chars; second run
    17 ms and byte-identical, so it is deterministic — a fingerprint
    that drifted would false-positive on every rollback.
  - coarse variant (names + counts only): 1 ms, 3007 chars.
  - the real per-round tax is two full fingerprints = **37 ms**. That is
    5x under the 200 ms budget the design set, so the fingerprint does
    NOT need scoping to comps named in the batch — take it whole.
  - building the 200 solids took 1075 ms; one Undo of that whole build
    took **73 ms**. Undo is cheap; the rollback's cost is the
    fingerprint, and even that is negligible.

**M4 — undo a batch containing create_comp while that comp is
frontmost.** Clean, no dialog, no dead viewer:

  - `create_comp` calls `openInViewer()`, so the undone comp really was
    the one in the front viewer (`activeItem` = `AELL_M4_front`).
  - No modal: the script ran straight through the Undo and wrote its
    results. A dialog would have blocked ExtendScript and produced no
    file at all, which is what the runner watches for.
  - After the Undo: comp gone, item count back to its starting value,
    `app.project.activeItem` is **null** rather than a dangling
    reference (reading it does not throw).
  - The viewer is alive, not dead: `app.activeViewer` still resolves,
    `.maximized` reads, and `.setActive()` succeeds.
  - AE still works afterwards — a second create_comp + add_solid round
    ran normally and opened in the viewer.

- Notes: nothing blocked; building next per the approved design. The one
  design detail these measurements settled beyond a yes/no is that the
  fingerprint can be full-fidelity and whole-project-scoped, which is
  simpler than the scoped fallback the proposal hedged with.

## 2026-08-25 — item 4 (ROLLBACK): built, after all four measurements came back clean

- Changed:
  - `extension/jsx/hostscript.jsx` — `AELL_errPartial` (a failure that
    already mutated), `AELL_layerSig` + `AELL_fingerprint`,
    `AELL_sentinel`, `AELL_maybeRollback`, and `AELL_callBatch` now takes
    an optional second arg `'{"rollback":true}'`. `for_each_layer`'s
    five-failure abort returns `AELL_errPartial`, so a lone batch tool
    that gave up part way undoes its own half-applied work — its error
    text no longer has to apologise that the changes are NOT undone.
  - `extension/js/tools.js` — `callHostBatch(cmds, opts, cb)` (old
    two-arg form still works), `executeCommands` takes `allowRollback`
    and disarms after one rollback, one system-prompt rule telling the
    model what a ROLLED BACK result means.
  - `extension/js/main.js` — one rollback budget per user request; a
    rolled-back round prints ONE chat line instead of N identical red
    ones.
  - `extension/js/selftest.js` + `scripts/ae-selftest.jsx` — 9 new steps
    and `batchOpts` threading.
  - `tests/test-round-rollback.js` (new, 48 checks), plus updates to
    `test-undo-groups.js` (two-arg batch literal), `test-for-each-layer.js`
    (the `mutated` flag) and `test-self-test.js` (canned host now models
    the rollback AND the undo).
- Harness: **158/158 real AE** (was 149/149). Stubbed suite: 19 files,
  all green except the pre-existing `test-capability-doc.js` CRLF issue
  below. Bumped 0.9.14.
- How it works, in one paragraph: the batch takes a fingerprint, opens
  its undo group, writes a net-zero sentinel, runs every command, and
  closes the group. If at least one MUTATING command succeeded and at
  least one failed — in any order — it issues exactly ONE `executeCommand(16)`
  and re-fingerprints. Match means rolled back: every result is
  rewritten so nothing still claims "ok", the comp-name aliases are
  restored, and the first result carries the full explanation (the rest
  get a short note, or 300 characters x 20 commands would eat the
  panel's whole 6000-char tool-result budget). Mismatch means ONE
  `executeCommand(17)` and an honest "not rolled back".
- What happens to the user's OWN work if it overshoots — the question
  the workplan asked. It cannot, and here is why rather than a promise:
  the Undo is issued in the SAME script execution that made the changes,
  and AE blocks its UI for the whole of an ExtendScript run, so no user
  edit can land on the stack in between. The only way our group is not
  on top is if it were EMPTY — measured, that registers nothing and one
  Undo reaches the previous edit — which is exactly what the sentinel
  prevents. If the sentinel cannot fire (no comp, no folder), the
  rollback DISARMS and the debris stays; nothing is ever undone on a
  guess. And the fingerprint is the third net: land anywhere other than
  the pre-round state and it Redoes once and reports failure. One Undo,
  one Redo, never more.
- Ordering matters and I got it wrong at first: the trigger is NOT
  "a failure after a success". In the field bug duplicate_layer failed
  FIRST and add_solid succeeded after it. The debris is whatever
  survives a round the model considers failed, so the trigger is
  any-success AND any-failure, in either order.
- Proven to catch the regression, not just to pass. `test-round-rollback.js`
  runs the actual field scenario through a stub whose undo stack really
  reverses mutations: armed, the two rounds leave NINE squares; unarmed,
  the same two rounds still leave TEN, asserted in the same file. The
  stub also asserts its own fidelity first — that an empty group
  registers nothing and that one Undo after one eats the previous edit —
  so a future change that drops the sentinel fails here rather than in
  someone's project. Real AE carries the same pair: one step rolls a
  partial round back and reads the comp back empty, the next runs the
  IDENTICAL round unarmed and reads the orphan back.
- Assumptions worth a second opinion:
  - One rollback per REQUEST, then the debris stands. The alternative
    (always roll back) is easier to explain but livelocks a
    deterministic failure into undo/retry/undo until maxRounds.
  - A failing read-only tool does not trigger it, so a round where
    add_solid succeeds and get_comp_details fails can still leave an
    orphan if the model retries. Rarer, and less bad than discarding
    good work over a bad lookup — but it is a real hole.
  - The fingerprint caps at 4000 layers across the project and then
    truncates. Above that a rollback could verify against a truncated
    signature; nothing on this machine comes close.
- BLOCKED/for the remote session: `tests/test-capability-doc.js` fails
  on THIS machine before any of my changes (confirmed by stashing them):
  the checked-out `docs/CAPABILITIES.md` has CRLF endings and
  `capability-report.js --check` compares against its own LF output, so
  it reports STALE on a clean tree. Green in CI (Linux), red for every
  local pass. Worth normalizing the comparison rather than the file.

## 2026-08-25 — FAST-TRACK: comp-rename audit tools (probe, then build)

- Changed: `extension/jsx/hostscript.jsx` (`AELL_walkExpressions`,
  `AELL_expressionIndex`, `AELL_expressionNames`, `AELL_revPrefix`, and
  the two tools `audit_comp_usage` + `rename_comps`);
  `extension/js/tools.js` (both tool docs, plus a prompt block on
  renaming many comps); `extension/js/selftest.js` (12 steps on a
  3-comp rig); `scripts/ae-selftest.jsx` (per-call progress trace, see
  below); `tests/test-comp-rename.js` (new, 60 checks) and
  `tests/test-self-test.js` (canned host models the rig).
- Harness: **171/171 real AE** (was 158/158). Stubbed suite 21 files,
  all green. Bumped 0.9.15 — the patch-bump exception this item
  pre-authorised.

**Probe first. All four questions answered, and one of them mattered:**

- **AE does NOT rewrite `comp("Old Name")` when a comp is renamed.**
  Measured: the string is untouched, and `expressionError` becomes
  "Expression disabled … comp named 'PR_Target' is missing or does not
  exist." So rule 3 stands exactly as written and the skip is HARD.
- **THE TRAP, and the reason this tool exists:** after the break,
  `prop.value` still returns the same number (100 before, 100 after).
  Nothing about reading the property reveals the damage; only
  `expressionError` does. A rename tool that checked values would
  report a clean sweep over a project it had quietly broken.
- Renaming BACK re-resolves it (`errorAfterRestore` empty), so the
  damage is recoverable — but only if somebody notices, which is
  exactly what nobody does.
- A comp used as a LAYER is an object reference: it survives a rename
  untouched, and the layer's `source.name` follows. Only string forms
  are at risk, which is why nesting is a soft skip and expressions a
  hard one.
- `item.usedIn` returns DIRECT parents only — NOT transitive (leaf used
  in mid, mid used in top: leaf.usedIn is [mid]). A comp used twice in
  one parent collapses to one entry, and a DISABLED layer still counts.
- Render-queue items follow their comp through a rename, so membership
  is answered by identity, never by name.
- Cost: the expression walk is the expensive half — 133 ms for 100
  layers, 1276 ms for 1000, linear, and byte-stable across runs.
  `usedIn` over 1173 items: 3 ms. So the audit is affordable, but a
  very large real project will take seconds; the tool reports its own
  `scanMs` so nobody has to guess.

**Design calls made (worth a second opinion):**

- `rename_comps` DERIVES the new names itself (`rule: "rev-prefix"`,
  the default) rather than taking a map from the model. The rules are
  precise and owner-confirmed, and year detection across 100 names is
  exactly what a small local model gets wrong. `rule: "map"` is still
  there for full manual control.
- Expression matching only counts QUOTED occurrences of the name —
  `comp("BG")` and `"BG"` match, the word "background" does not.
  Matching bare substrings would have made a comp called "BG"
  unrenameable for spurious reasons.
- `dryRun` defaults to TRUE and the system prompt tells the model to
  report the preview and STOP. Renaming is the one thing here that can
  break a project, so it never happens without being asked twice.

**Two things that cost time, recorded so they do not cost it again:**

1. **My PROBE nested undo groups** — an outer `beginUndoGroup` around
   inner `beginUndoGroup`/`endUndoGroup` pairs. AE does not nest them,
   and it surfaced on a LATER script run as a modal: "After Effects
   warning: Undo group mismatch, will attempt to fix." That modal
   blocked the harness completely (exit 4, no results file). Nothing
   shipped has this bug — `AELL_call`, `AELL_callBatch` and
   `for_each_layer` never nest — but never nest them in a probe either.
2. **The harness could not say WHICH step blocked it.** 171 steps, one
   modal, no results file, no clue. `scripts/ae-selftest.jsx` now
   writes a breadcrumb per host call to `<results>.progress`, flushed
   immediately; the last line is the culprit. Confirmed working: 171
   lines, and the rename block reads
   `batch[add_solid,precompose,add_solid,set_expression]` ->
   `audit_comp_usage` -> `rename_comps` x3.

- Also: an aborted run left `REV19_ST RN Plain 2019` behind, which then
  collided with the name the next run wanted and failed four steps with
  "the plain comp was not planned for rename". The check now prints the
  plan's own reason, so that failure explains itself next time.
- FOR THE REMOTE SESSION — pre-existing, not from this item: the
  self-test leaves its SOLID FOOTAGE items in the project panel on
  every run. It deletes the comps but not the solid sources, so the
  scratch project accumulates duplicates (45 items, visibly doubling:
  "ST Bat A | ST Bat A | ST Batch | ST Batch | …"). Harmless to the
  suite, untidy for anyone whose project it runs in. Worth a cleanup
  step that removes unused solids the suite created.

## 2026-08-25 (remote) — the suite now cleans up its solid sources

- Changed: `extension/js/selftest.js` — three new final steps: list every
  footage item in the suite's own "ST " namespace, delete them by ID
  (names duplicate after runs, ids do not), then a verification READ
  asserting nothing ST-prefixed remains in the project at all. Only the
  suite's namespace is touched — a user's own solids are never candidates.
  `tests/test-self-test.js` — the canned host now models what the check
  depends on: delete_item really removes items from later listings (by
  name or id, grounded error when missing), precompose adds its comp,
  rename_comps renames the underlying item. It is seeded with the
  observed leftovers (ST Bat A twice, etc.) so the cleanup path runs
  against the field bug, not an already-clean project.
- Harness: NOT run from here (chat-probe holds the machine). Stubbed
  suite 21/21. NO version bump — this changes suite behavior in the
  user's open project, so it ships after the local session watches one
  real run delete the right things and nothing else.
- FOR THE LOCAL SESSION: next harness run, confirm the final three steps
  pass AND eyeball the project panel afterwards — the 45-item
  accumulation should be gone, and nothing that is not ST-prefixed may
  have been touched. Then patch-bump.
## 2026-08-25 — chat probe: reconciled, re-run, and it caught the rollback lying

- Changed: `scripts/chat-probe.js` (committed the previous session's
  uncommitted work, then armed rollback and added step 11),
  `tests/test-chat-probe.js` (new verdict pins + an anti-drift check),
  `extension/jsx/hostscript.jsx` and `extension/js/tools.js` (the
  rolled-back wording — the actual fix). Bumped 0.9.16.
- Harness: stubbed suite 22 files green. Chat probe steps 1,11: 2/2
  after the fix (1/2 before it).

**First: the probe was never testing the rollback at all.** It mirrors
main.js's round loop by hand, and main.js gained `allowRollback` while
the probe did not — so the host was never armed and the model never saw
a ROLLED BACK result. The probe reported passes the whole time. There is
now an anti-drift assertion in `tests/test-chat-probe.js` that reads
both files and fails if an executeCommands option exists in one and not
the other; that is the only way this class of drift is catchable,
because a probe that tests a different product still goes green.

**Then, armed, it caught the rollback doing something worse than the bug
it was built to fix.** New step 11 asks for one achievable thing and one
impossible one: "Add a 100 by 100 orange solid called Beta to Probe
Room, and put a drop shadow on the layer called Ghost." add_solid
succeeds, apply_effect fails, the round is correctly rolled back — and
the model then said:

    "The layer 'Ghost' was not found ... Created the 'Beta' solid layer
     successfully."

Beta did not exist. It had just been undone. So the user got NOTHING and
was told they got something — a silent lie, where the original
ten-squares bug at least left visible debris. The rollback was correct;
what the model did with it was not.

**Fix: the note's wording, measured rather than guessed.** The first
version said "nothing was applied — re-plan from the current state",
which the model read as "the request failed, report it". It now names
the two actions in order — resend the commands that CAN succeed without
the one that failed, then say plainly what you could not do — and
forbids the claim outright ("NEVER say anything from this round was
created, added or applied"). Same prompt rule in tools.js. Re-run on the
identical sentence: round 1 rolls back, round 2 resends add_solid alone,
the reply says the shadow was impossible and why, and the comp ends with
exactly one Beta. That is the designed behaviour, proven through the
model rather than argued.

Step 11's verdict separates the two failure modes on purpose: more than
one Beta is the ten-squares bug (built on top of an undone round); ZERO
Betas is this bug (gave up on the achievable half). Both fail, with
different messages. Pinned in the stub suite four ways, including a
model that invents a Ghost layer to make the error go away.

**Two OTHER findings from the full 10-step run, neither fixed, both
real:**

1. **The panel has no history trimming, and a long chat dies.** Steps 9
   and 10 both failed with a raw `llama-server HTTP 400: request (16755
   tokens) exceeds the available context size (16384)`. `main.js` builds
   `[system].concat(history)` with no bound; `compactToolResults` caps
   each round's results but everything accumulates forever. In the panel
   this surfaces as "Model error: llama-server HTTP 400: {...}" on every
   subsequent message — the chat is simply dead until cleared. Verbose
   grounded errors accelerate it: one round here repeated a 300-char
   "path not found" error nine times. Needs a decision (drop oldest
   turns / summarise / raise ctx and warn), which is why it is logged
   rather than guessed at.
2. **There is no way to change a solid's colour.** Step 9 ("Make them
   blue instead") failed because the model tried four approaches and
   none exist: `set_transform {property:"fillColor"}`,
   `set_property {layers:[...]}` (no batch form — it takes ONE `layer`),
   and `set_property "contents/Solid Color/Color"` twice (solids have no
   contents; that is a shape layer). A solid's colour lives in
   `layer.source.mainSource.color` and no tool exposes it. Either add
   one, or make the grounded error redirect to an effect-based answer.
   Related: `set_property`'s "No layer selected" error should say the
   tool takes a single layer and point at `for_each_layer`, since the
   model reached for `layers:[...]` twice in a row.

- Note: step 9's verdict already accepts a Fill/Tint effect as a valid
  answer, so it is not the verdict being strict — the model genuinely
  could not do it.

## 2026-08-25 (remote) — history trim built; H3 r2v workflow bundled

- Changed: Tools.fitHistory + main.js wiring (proactive trim, one-time
  notice, hard-trim retry on context 400) — tests/test-history-trim.js
  pins the rules including the field numbers. set_property {layers:[..]}
  now redirects to for_each_layer. H3 r2v workflow + manifest bundled;
  canonical repo is Comfy-Org/MiniMax-H3 per its embedded URLs; the
  nvfp4 encoder is Blackwell-only -> catalog needs per-arch variants.
- Harness: NOT run from here. Stubbed suite 22/22. NO bump — the trim
  changes every chat request, so it ships after the probe re-run
  (WORKPLAN 2d) proves steps 9–10 complete.

## 2026-08-25 (remote) — per-workflow prompt enhancement + t2v/i2v first

- Changed: planEnhancement (tools.js, pure + stub-tested) wired into
  comfy_generate BEFORE the VRAM pause; Comfy.readManifest; comfyEnhance
  per-workflow setting (absent = ON, only opt-outs stored); toggle list
  in the ComfyUI settings section; manifests now carry the enhancer
  instructions lifted from the workflows' own Ollama branches (3545 and
  7728 chars); bundled workflows sanitized of leftover typed prompts,
  enforced by tests/test-prompt-enhance.js.
- Harness: NOT run from here. Stubbed suite 23/23. NO bump — the
  generation path changed; local verifies the enhance round + toggle UI
  before it ships (fold into the 2d probe re-run pass).
- Notes: enhancement costs ONE completion on the already-loaded chat
  model, not a load/unload — the Ollama branch it replaces loaded a
  separate 27B per generation. r2v deferred per owner; t2v/i2v files
  pinned by 2d; owner asked to export a t2v/i2v H3 workflow.

## 2026-08-25 (remote) — H3 i2v bundled, procedurally parameterized

- The owner's i2v workflow lands as AE_LLAMA_H3_I2V_V1. Per their
  direction, the enhancer node's contents are BROKEN OUT: the manifest
  holds the template (system turn), the user idea is the per-run user
  turn (planEnhancement already separates these), and duration is an
  injection parameter (seconds -> node 136; the graph does the frame
  math). fl2va covers t2v AND i2v — r2v superseded. Sanitized like the
  others; enhance tests pass. Adaptation + one real generation queued
  as the local 2d pass.

## 2026-08-25 — item 2d: shared root, history trim, H3 pins, set_solid_color

Four of the five 2d bullets done. Bumped 0.9.17.

**1. The ComfyUI-Shared root — and a correction to my own inventory.**
`AppData\Local\Comfy-Desktop\ComfyUI-Shared\models` holds 64 files /
244.2 GB, listed in full in `docs/COMFY_LOCAL_INVENTORY.md`. It is
resolved BEFORE the Documents root (proved from the startup log's
per-kind root list, which is the only place the resolution order is
visible — `extra_models_config.yaml` does not mention this root at all).
So: **MiniMax H3 is FULLY provisioned, not blocked.** My first inventory
declared the tier dead because it scanned one root. Both transformers
(19999 MB each), the nvfp4 encoder (14960), the video VAE fp16 (4967)
and the audio VAE fp32 (577) are all here. The doc's findings list and
H3 section are corrected in place rather than appended to, because a
wrong headline that survives in a document is worse than no document.
The register matcher's root list is written out in resolution order.

**2. The history trim is VERIFIED — but the probe could not test it
until it was fixed.** Same drift as last time: main.js grew
`Tools.fitHistory`, chat-probe.js mirrors the round loop BY HAND and did
not. Running it as-is would have reproduced the old HTTP 400 and
"proved" the fix did not work. The probe now carries both halves (the
proactive budget and the reactive `forceTinyContext` retry), and
`tests/test-chat-probe.js` now asserts the GENERAL rule — every
`Tools.*` helper main.js's chat path uses must appear in the probe, with
a two-entry PANEL_ONLY allowlist that itself has to stay true. Twice is
a pattern; the third time is now a test failure.

Full probe re-run: **10/11, and steps 9 and 10 complete for the first
time.** "context trimmed — N earlier message(s) dropped" appears from
step 4 onward and no HTTP 400 anywhere. Step 10 measured one Ctrl+Z for
one sentence. Step 11 (rollback re-plan) passed again in a long-context
run, which is the version that matters.

**3. H3 files pinned** into `docs/COMFY_TIERS_PLAN.md` from the HF API
(30 files). Two transformer families x five precisions; `fl2va` is the
t2v/i2v one and covers t2v with no image. The nvfp4 question the plan
asked has a number now: dropping nvfp4 for the int8_convrot encoder
costs **+11 GB** (14960 -> 25884), so a non-Blackwell H3 tier is ~26 GB
encoder + ~20 GB transformer before VAEs. Also recorded: the owner's
local turbo LoRAs (592-744 MB) are NOT the repo's (1866 MB) — different
files from a different source, do not treat them as interchangeable.

**4. set_solid_color — probed, built, and it closes the probe's oldest
open failure.** Step 9 ("Make them blue instead") had failed since the
first probe run because no tool could recolour a solid. It passes now.

Measured before building, and the measurements shaped the tool:
  - `layer.source.mainSource.color` IS writable.
  - `duplicate_layer` gives three layers ONE source id; one write turns
    all three. `split_layer_into_chunks` likewise (3 chunks, 1 source).
    So the shared case is the normal case, and a tool that just wrote
    the colour would recolour layers nobody named and report success.
  - `app.project.items.addSolid` does NOT exist. The only way to mint a
    SolidSource is to add a throwaway solid LAYER, take its `.source`
    and remove the layer; the source survives.
  - `replaceSource(fresh, false)` keeps keyframes, effects, masks,
    transform and in/out points.
  - THE TRAP, found by the self-test rather than by reasoning: a layer
    that was never renamed BY HAND displays its SOURCE's name, so
    replaceSource silently renamed it and the suite ended up with two
    layers both called "ST SC Square 2". The tool now writes the old
    name back. The stub models auto-vs-hand-set names so this cannot
    regress without AE.

Shape: `set_solid_color {layer|layers, color, makeUnique?}`. If every
layer sharing the solid was asked for, it writes once. If only SOME
were, it REFUSES and names the collateral — unless the caller says which
way they want it. That refusal is the whole tool; the write is trivial.

**5. NOT DONE — the H3 i2v workflow (parts 1-3).** Only part 4 (node
attribution) is finished, written into
`AE_LLAMA_H3_I2V_V1.manifest.json`: `ResolutionSelector` and
`MiniMaxH3SigmaShift` are **comfy-core** nodes in 0.32.0
(`comfy_extras/nodes_resolution.py`, `comfy_extras/nodes_minimax_h3.py`)
and need no pack; `ComfyMathExpression` ships inside
ComfyUI-MiniMaxH3-FirstBlockCache, not a separate comfymath pack (the
manifest was wrong); `RTXVideoSuperResolution` is
`comfyui_nvidia_rtx_nodes` and is marked optional/bypassable. TWO
collisions recorded: `PlaySound` is defined by both
comfyui-custom-scripts and ComfyUI-KJNodes, and `ResolutionSelector` by
both comfy-core and ComfyUI-UtilsCollection.
Parts 1-3 (template adaptation, comfy.js injectParams wiring, one real
generation) are untouched: a real H3 generation is a ~20 GB model load
that would fight llama-server for the 32 GB card, and it wants its own
pass with nothing else running. Next session's item.

**Open, and NOT caused by anything here: probe step 7 is flaky.**
"Spread the nine squares out equally" fails when the model answers the
grid rig's grounded `overriddenByExpression` error by STOPPING and
telling the user to clear the expressions, and passes when it clears
them itself and retries. Both happened today with identical code. I
isolated it: it fails with FRESH context too (`--steps 1,2,7`, no
trimming active), so this is model variance at temp 0.7, not a
consequence of the trim. The real question underneath is a product
decision, not a bug: when the panel's OWN grid rig (created two turns
earlier) blocks a later positional request, should the model clear it
uninvited? Today's "refuse and explain" is arguably the safer answer and
today's verdict calls it a failure. Worth deciding deliberately rather
than letting temperature decide per run.

## 2026-08-25 (remote) — step-7 settled: clearExpressions, decided not rolled

The 2d pass's closing question — when the panel's OWN grid rig blocks a
later positional request, should the model clear it uninvited? — is now
answered by the owner's standing principle ("explicit user requests
always win over guardrails; hard limits close doors"), and the answer is
moved from temperature to arithmetic:

- `distribute_property` takes `clearExpressions: true`. Surgical by
  construction: the tool writes FIRST and clears only an expression that
  demonstrably swallowed the write — a pass-through (`value + wiggle`)
  is never touched, a keyframed property still refuses before any clear
  happens. Cleared layers land in `expressionsCleared` and the note
  tells the model to say which rigs are gone.
- Without the flag, behavior is unchanged (report, don't move) — except
  the note now names the deterministic way out: "If the user explicitly
  asked for these values, re-call with clearExpressions: true".
- Prompt rule added: overriddenByExpression + an explicit user ask =
  re-call ONCE with the flag, then tell the user what was removed. Never
  on a first call; never when the user asked to keep the rig.
- So BOTH of the probe's observed behaviors survive as halves of one
  deterministic round-trip: first call refuses and explains (the safe
  answer), the re-call honors the user (the obedient one). No verdict
  change needed in chat-probe: step 7's even-gaps check already measures
  the end state, which is now reachable on purpose instead of by mood.

Stub side, all green (24 files): test-curve-tools.js grew cases 11c-11e
(no-flag call must not touch the rigs; flagged re-call clears exactly
the three swallowers and the values are IN the stubbed comp; a
pass-through expression survives the flag), and its Prop stub now models
AE's real `.expression` semantics — assigning "" is what turns the rig
off. selftest.js grew 4 steps in the order scratch comp (rig ST Ord 5,
refuse + name the flag, clear + land x=500, read back from AE that the
expression is gone) — suite is 187 steps; the canned host in
test-self-test.js models the clear against its driven map. The old grid
step's note check now requires /clearExpressions/. Capability doc
regenerated.

NOT verified in real AE (remote session — no AE here). Queued in 2d for
the local session: run the 187-step suite, re-run chat-probe step 7,
patch bump when green. This is a product-behavior decision the owner has
not explicitly ruled on — the mechanics are cheap to flip (delete the
prompt rule bullet + the flag branch) if they want refuse-only back.

## 2026-08-25 (remote) — tier P1–P3: one detection, one tier, both engines

The VRAM-tier architecture's remote half is built (docs/COMFY_TIERS_
PLAN.md updated in place; WORKPLAN gained item 7 = P4 for the local
session). The shape, briefly:

- **tiers.js** is the single source: T0–T7 anchored on NVIDIA's shipped
  VRAM levels, resolved from MEASURED VRAM (never the card name), with
  vramOverrideGB beating the measurement so a 32 GB card can BE a 6 GB
  card for testing. Architecture gates ride catalog entries
  (requiresAda, requiresBlackwell — nvfp4 is Blackwell-only), and an
  unknown architecture fails a gate: recommending a model that cannot
  execute is worse than a smaller one. Setup.recommendModel now
  delegates here (semantics pinned unchanged by test-model-catalog).
- **The arbiter** replaced the pause-per-generation + 1.5 s hope-sleep
  in comfy_generate. planHandoff is pure arithmetic over what is REALLY
  loaded (chat .gguf stat size + overhead, manifest's non-optional
  weight sum) — concurrent when it provably fits, exclusive handoff
  when it does not or cannot be proven, a grounded refusal (with the
  numbers) under pause mode "never" BEFORE anything is churned. One
  pause covers a whole round: two generations in one commands array
  cost one stop, one /free, one warm-up — measured by the new
  test-vram-arbiter against a scripted nvidia-smi. Release is verified
  by polling until the reading drops, both directions.
- **comfyCatalog**: version.js grew COMFY_CATALOG (sd15, sdxl with its
  honest slowBelowGB 8, krea2, experimental ltx-small at 6 GB,
  wan22-5b, MiniMax H3 in nvfp4-Blackwell and int8 variants with the
  exact Comfy-Org URLs the workflow manifests already pinned). ALL
  PROVISIONAL: measured:false everywhere, URLs training-quoted where no
  manifest pinned them, feed-overridable without a panel release.
  recommendSetup produces the combined line ("RTX 4060, 8 GB (T3):
  Qwen 7B for chat + SDXL for images + Wan 2.2 5B for video.
  Generation pauses chat on this card.") — rendered in the ComfyUI
  settings section, re-rendered on GPU probe and settings save.
- **Settings**: comfyPauseLlm true→"auto"/false→"never" migration,
  vramOverrideGB, comfyModelRoots (one per line, kind=path per-kind,
  written as extra sections into extra_model_paths.yaml; the user's own
  folders are read, never restructured — and a drive letter is not a
  kind). New/extended suites: test-tiers, test-vram-arbiter,
  test-settings-migrate, test-model-catalog, test-comfy-backend — 27
  files, all green.

Decisions taken that P4 must respect: T2's default image is SD 1.5
with SDXL demoted by slowBelowGB (the resolved T2 floor decision now
lives in recommendGen, not in prose); "lazy restart" landed as
resume-once-per-round, NOT as skip-the-reply — the model needs to be up
to phrase its answer, and ending the round panel-side after a
generation is an owner decision nobody has made.

NOT verified on real hardware — deliberately. Every number in the
catalog says measured:false and the WORKPLAN item 7 bullets are the
measurement pass (handoff smoke, /free support probe, refusal in the
field, catalog deltas, the override ladder, OOM recovery). No version
bump here: this ships to a panel only after the local session verifies
the handoff on the 5090 and bumps.

## 2026-08-26 (local) — item 1: the harness answers the dialog it inherits

**The pass opened red.** `run-ae-selftest.ps1` exited 4 on a wordless
381x237 `#32770` before running a single step. PrintWindow read it:
"After Effects / Save changes to 'Untitled ...'". That is exactly the
blocker filed on 2026-08-21 as "a call for someone else", with both ways
out already written down and neither taken. It has been quietly costing
the unattended loop one whole pass every time AE is left dirty. So this
pass took the first of them.

**Changed** (dev-only files -- nothing under `extension/` moved, so
**no version bump**: the panel ships `extension/` alone, and bumping for
a harness fix would publish a feed identical to the installed build):

- `scripts/lib/ae-dialog-triage.ps1` -- new `Get-AellStaleDialogPlan`.
  The prompt is drawn by AE, so Win32 reads no text out of it and it can
  never be identified by what it SAYS; this decides from the situation.
  Four rails, and each one is a case in the test: only the `unreadable`
  verdict (a popup with WORDS is a human's question and is never
  touched), never while a script is executing (the progress window's
  teardown flicker is wordless too and leaves on its own), never during
  startup (with no application window up the wordless thing is AE's
  crash-recovery prompt, a different question), and only when a `#32770`
  was actually found -- the probe's own "no popup text could be read"
  note has no window behind it to answer.
- `scripts/run-ae-selftest.ps1` -- the probe's `Add-Type` and
  `Get-BlockingDialog` moved ABOVE the launch, then
  `Clear-AellStaleDialog` runs, then AE starts. Ordering is the safety
  rail and the test asserts it: before the launch, any dialog on screen
  is provably not ours. `AellWin.CloseWordlessDialogs` repeats the rail
  in Win32 rather than trusting its caller -- top-level `#32770` of AE's
  own process, empty title, no child text that is not an `OS_*`
  container -- and POSTS WM_CLOSE so a wedged dialog cannot wedge the
  harness. Two rounds, 2s apart, then it gives up and lets the wait loop
  report it as before. `-NoDismissStale` opts out. The exit-4 message no
  longer claims nothing can be scripted around it.
- `tests/test-selftest-runner.js` -- seven `Get-AellStaleDialogPlan`
  cases over the same captured-from-AE probe samples the file already
  carried, plus runner assertions that the answer happens before the
  launch, that the wait loop still judges this run's own popups after
  it, and that no `Stop-Process` ever creeps in (a hard kill is what
  raises the startup recovery dialog next launch).

**Harness: 187/187, exit 0** -- four times. Twice from a wedged AE with
the new path announcing "answered 1 dialog(s) / cleared." first. Stubbed
suite 28/28.

**One thing measured that does NOT match the assumption, recorded
because it will mislead the next pass otherwise.** To test recovery I
re-created the prompt by posting WM_CLOSE to AE's application window.
It produces the same signature (wordless 381x237 `#32770`, main window
disabled) and the new code answers it correctly -- but that synthetic
one does NOT block `-r`: with `-NoDismissStale` the suite still ran
187/187 with the dialog up, and the dialog was still up afterwards. The
one that opened this pass DID block, for the full 8-poll patience.
So the save prompt has two states, and only the one raised when AE is
being torn down with its launcher (session-end, not a plain close
request) actually swallows scripts. What is proven: the dismissal fires
on a real AE save prompt and clears it. The inescapable variant was
cleared by this exact WM_CLOSE too -- by hand, at the top of this pass,
before the code existed, which is what unblocked the first green run.
I could not re-create it on demand without a hard kill, which is
forbidden here for the reason bug 3 documented.

**Still open, unchanged:** the second way out (have the harness leave AE
running rather than being torn down with its launcher) would stop the
prompt being raised at all. Recovery is cheaper and is now in; the
prevention is still a design call for the remote session.

**Next pass** should take the 2d bullet that is now unblocked: the
clearExpressions suite steps are IN the 187 and green in real AE, so
what remains there is re-running chat-probe step 7 and patch-bumping
that work.

## 2026-08-26 (local) — item 2d: clearExpressions in the field, and the bridge bug underneath it

Bumped **0.9.18**. Harness 187/187 (three times), stubbed suite 28/28,
chat-probe 7/7 on steps 1-7 and 10/11 on the full run.

**The pass opened green** (187/187) so it took the bullet the last entry
queued: verify the remote-built `clearExpressions` in real AE and ship
it. Re-running `chat-probe --steps 1,2,7` did not get as far as an
opinion about clearExpressions — step 1 failed with "no comp called Probe
Room exists" one second after `create_comp` had answered `ok` with an id,
and step 2 crashed on `state.layers` being undefined.

**Root cause, measured, and it was never about clearExpressions.**
`$.evalFile` run from inside a function leaves the file's top-level
`var`s in THAT function's scope, not on `$.global`. hostscript assigns
`$.global.AELL_call` explicitly, so the tools survive into the next `-r`
script; `AELLJSON` was a top-level `var` and did not. chat-probe's bridge
skipped re-loading the host whenever `$.global.AELL_call` was already a
function — so every read after the first evaluated a bare `AELLJSON`
that did not exist there. Proven in AE with four temp scripts:

  - a later `-r` script sees `$.global.AELL_call` = function, bare
    `AELL_call` = function, and `typeof AELLJSON` = **undefined**;
  - assigning `$.global.X` in one script does make bare `X` resolve in
    the next, so `$.global` IS the contract;
  - and an undefined identifier in a `-r` script is not an exception you
    can catch — AE raises a **modal**, which then blocks every script
    after it. That is a wordless `#32770`, i.e. the same wedge the
    2026-08-26 harness entry taught the runner to answer.

So the failure mode was: tool calls kept working (AELL_call closes over
AELLJSON lexically), verdict reads silently returned wrapper errors, and
AE got wedged on the way. A probe that reports rounds as `ok` while it
cannot read the comp is worse than one that fails.

**Fixed at the root, not in the probe's expectations:**
- `extension/jsx/hostscript.jsx` — `$.global.AELLJSON = AELLJSON;`
  published next to the other exports, with the measurement written
  above it. Anything outside the file (probe, a temp `.jsx` per
  CLAUDE.md's documented pattern) now gets the serializer the same way
  it gets the tools.
- `scripts/chat-probe.js` — the wrapper is a pure `bridgeWrapper()` now
  (so a test can run it), it re-loads the host unless BOTH names are
  present, and if the load still leaves no serializer it writes a
  grounded refusal instead of evaluating — a refusal costs a failed
  step, a ReferenceError costs the whole session.
- `tests/test-chat-probe.js` — section 4: hostscript must publish
  `AELLJSON`; the general rule that every `AELL*` name any caller puts
  in an ExtendScript STRING (probe, main.js, tools.js) is published on
  `$.global`; and the wrapper RUN against a stub whose `$.global` is
  Node's own globalThis — which is exactly what makes AE's published
  names resolve bare. Three cases: stale host gets re-loaded, complete
  host is not re-loaded every call, host that does not publish gets the
  refusal and never reaches the eval.

**Then the actual item, and it passed — twice, and failed once, which
was the useful run.** `--steps 1,2,7`: 3/3, with the exact designed
round-trip — first call refuses with `overriddenByExpression`, model
re-calls with `clearExpressions: true`, nine squares land on even 190px
gaps, reply names the rigs it removed. Full 11-step run: 10/11, every
read healthy, and step 7 FAILED there with 217px gaps.

**That failure was a real defect in the tool's own wording, not model
variance.** The re-call the model sent listed only the EIGHT layers the
note had named as overridden — dropping "Red Square 5", the one layer
that had already landed. `from`/`to` is divided across the layers you
send, so the eight re-spaced themselves across the full width and the
ninth stayed stranded at 960. Every tool call in that round succeeded.
The note invited it: it named eight layers and said "re-call with
clearExpressions: true", and the obvious reading of that is "retry those
eight". Fixed where the sentence is built (hostscript) plus both places
that teach it (tools.js tool doc + prompt rule): the note now asks for
"the SAME 9 layer(s) as this call" and says what re-calling with only
the 8 would do. `tests/test-curve-tools.js` case 11f builds the field
shape exactly (nine fresh layers, eight rigged, one free) and pins both
halves of the sentence; the result still fits the 1200-char cap (655).
Re-ran steps 1-7 afterwards: **7/7**, and the re-call carried all nine
names.

**For the next pass / not done here:**
- The full probe's other ten steps passed, so nothing else is owed there.
  One run is not proof that the wording ends step-7 variance — the note
  now makes the right move explicit and the stub pins it, but the model
  half is still a 32B at temp 0.7.
- **AE's project accumulates null sources.** Reading the project mid-pass
  found 65 leftover `Null NN` FootageItems from earlier suite runs; the
  suite cleans up its solid sources (2026-08-25 remote entry) but not its
  nulls. Harmless to the tests, and it is debris in whatever project the
  suite is run against. Worth one small pass.

## 2026-08-26 (local) — item 2 (LAST bullet): add_light, and what lights lie about

Harness **206/206** (twice), up from 187 — 19 new steps. Stubbed suite
29/29 (new `tests/test-light.js`, 52 checks). **No version bump**, on
purpose: see the bottom of this entry.

**The pass opened green (187/187)**, so it took a workplan item. Item 2's
text listed five open bullets, but grepping this log showed four of them
were finished on 2026-08-21 and simply never struck. The only genuinely
open one was `add_light`, flagged twice (2026-08-20 and -21) as "a new
tool is the remote session's call" and never picked up. Item 2's own
wording says *Build the tool AND its coverage*, so this pass built it.
WORKPLAN.md now has all five struck, so no future pass re-reads the log
to work out what is left.

**Probe first, and it was worth it — nearly every training-quoted fact
about lights is wrong or useless.** Four probe scripts against AE 2026:

- `canSetValue` is **false on every light property**, including the ones
  that write perfectly well, and `elided` is false everywhere too. The
  obvious implementation — gate on `canSetValue`, skip what you cannot
  set — would have refused *every option on every light*. The only
  truth is attempting the write.
- The Light Options group carries **all 14 properties on every type**;
  it never shrinks. Enumerating it tells you nothing about the type.
- So hiddenness is per-TYPE and invisible. Measured matrix, which is now
  the table in the tool AND in both stubs:

  | option | parallel | spot | point | ambient | environment |
  |---|---|---|---|---|---|
  | intensity, color | yes | yes | yes | yes | yes |
  | coneAngle, coneFeather | — | yes | — | — | — |
  | falloff, radius, falloffDistance | yes | yes | yes | — | — |
  | castsShadows, shadowDarkness | yes | yes | yes | — | — |
  | shadowDiffusion | — | yes | yes | — | — |
  | Position | yes | yes | yes | — | — |
  | Point of Interest | yes | yes | — | — | — |

  An **ambient or environment light accepts NO transform property at
  all** — not even Position. Background Visible/Opacity/Blur are hidden
  on all five (environment-panel UI only).
- **Falloff gates its own two.** Radius exists only while Falloff is
  smooth(2) or inverseSquareClamped(3); Falloff Distance only while it
  is smooth(2). Falloff type 4 does not exist. So Falloff must be
  written FIRST — the tool's option list is in write order for this
  reason, and a suite step reads Radius back to prove the order held.
- **AE 2026 has FIVE light types.** `LightType.ENVIRONMENT` (4416)
  joined the four training knows. Guarded with a typeof so an older AE
  gets a grounded refusal naming the four it does have.
- `addLight` **requires both arguments**; a one-arg call throws.
- A new light defaults to **SPOT**, and its Falloff defaults to none.
- `NO_AUTO_ORIENT` hides the Point of Interest on a light exactly as on
  a camera, so `oneNode` has the same set-it-first ordering rule, and
  `oneNode` + `pointOfInterest` together is a grounded refusal.

**Built:** `add_light` in hostscript (+ AELL_MUTATING, + tools.js docs —
an undocumented tool is unreachable by the model). It **validates every
argument BEFORE creating the layer**, so a refusal never leaves a
half-configured light for the user to clean up. Verified in real AE: six
refusals in a row left the comp holding exactly the two lights that had
succeeded. Every refusal names both the types that DO take the option
and the full list this type accepts.

**Real AE corrected the stub once, which is the whole point of this
loop.** The first stub assumed `addLight(name, center)` puts `center`
into Position. It does not: `center` lands in the **Point of Interest**,
and Position gets AE's own default — a fresh light in an 800x600 comp
read POI [400,300,0] and Position [0,0,-555.556]. The stub now models
the measured split and the test pins both halves.

**Coverage:** `tests/test-light.js` (52 checks) whose stub reproduces
the lies — it reports `canSetValue` false while still accepting legal
writes, hands out all 14 options whatever the type, and throws AE's real
"property or a parent property is hidden" message otherwise. 19 suite
steps in their own scratch comp (lights are riggers like cameras). The
five refusal steps have teeth: `test-self-test.js`'s permissive-host run
fails all 15 refusal steps, 5 of them the new ones.

**Two findings NOT fixed here, both queued in WORKPLAN item 2:**

- `get_property` cannot reach `Radius` or `Falloff Distance` by bare
  name — AE's layer-level name shortcut covers `Cone Angle`, `Intensity`,
  `Shadow Darkness` and `Casts Shadows` but not those two, and the
  refusal only offers `list_properties`. The group path `light/Radius`
  works and the suite uses it. A deep-search fallback in the path
  resolver would remove the trap; that is a change to a shipped tool and
  belongs in its own pass.
- `scale_comp` still does not scale a light's pixel-valued options
  (falloff distance, shadow diffusion), matching AE's own native script.
  Disclosed in the 2026-08-21 entry as untestable; now that lights are
  creatable, it finally is.

Also unchanged from the last entry and still worth a small pass: **AE's
project accumulates leftover `Null NN` FootageItems** from suite runs.

**Why NO version bump.** CLAUDE.md tells the local session to patch-bump
a *fix verified in real AE*. This is not a fix to shipped behaviour, it
is a new tool, and WORKPLAN's build rules say new tools ride the next
MINOR that the remote session cuts after reviewing the batch — the
comp-rename FAST-TRACK had to call itself "the exception that ships as a
patch" precisely because that is not the default. Pushing at an equal
version is the correct outcome here. Flagging it plainly so the remote
session knows `add_light` is sitting in the branch waiting for 0.10.0.

## 2026-08-26 (local) — item 2d: the H3 i2v template, and why NO bundled workflow could ever have run

Harness **206/206** before and after (unchanged — this pass never touched
AE-side code). Stubbed suite **30/30**, one new file
(`tests/test-workflow-adapt.js`, 47 checks). **No version bump**; reasons
at the bottom.

The pass opened green, so it took the top unfinished workplan item: 2d,
the H3 i2v workflow, part 1 (template adaptation). The manifest's ask was
narrow — "drop nodes 169/170 + link 313 so the injected prompt widget on
node 138 takes effect". Doing only that would have shipped a file the
panel still cannot open, because of what the first ten minutes turned up.

**The finding that reframed the item: none of the three bundled workflows
is loadable, and never was.** `extension/workflows/` holds UI-format
("Export"/"Save") graphs — `nodes` + `links`. `comfy.js loadWorkflow()`
opens with an explicit check for exactly that shape and throws
"is a UI-format export … use 'Export (API)'". There is no converter
anywhere in the repo. On top of that, `extension/workflows/` is not the
seed directory: `setup.js ensureDataDirs()` copies
`extension/comfy-workflows/` into the user's data root, and that folder
held only a README and a toy txt2img example. So the H3 and Krea
templates were unreachable by the panel by two independent mechanisms.

**Why a converter and not a hand re-export.** The UI format stores widget
values POSITIONALLY (`widgets_values: ["a", 1, 2]`) and names only the
widgets that happen to be linked. Recovering the names needs each class's
ordered input list, which lives in ComfyUI's `INPUT_TYPES`. A re-export
by hand also cannot make the edit the manifest actually needs, and
nothing would stop the template and the manifest drifting apart later.

**Probe: ComfyUI imported in-process, no server, no port, no GPU.**
`scripts/harvest-comfy-node-defs.py` sets `sys.argv`, calls
`comfy.options.enable_args_parsing()`, constructs a `PromptServer` (custom
packs expect the instance) and awaits `nodes.init_extra_nodes()`. That
resolved all 31 classes the H3 i2v graph uses — including the pack-defined
ones — out of 3487 registered, on **ComfyUI 0.32.0**. Only `MarkdownNote`
is absent, correctly: it is frontend-only.

**Five measured facts, every one of which silently corrupts a template if
guessed wrong:**

- `control_after_generate` (RandomNoise's "randomize") is a frontend-only
  widget that OCCUPIES A POSITION. Skip it and every later widget on that
  node reads its neighbour's value.
- A V3 **dynamic combo** consumes its own position, then the SELECTED
  option's inputs expand INLINE as dotted keys. `SaveVideo` nests one
  inside another: `codec: "h264"` plus `codec.encoding: "auto"`.
  `RTXVideoSuperResolution` is `resize_type` + `resize_type.width` +
  `resize_type.height`, and `quality` sits AFTER that run.
- A V3 **autogrow group** is sockets only and consumes NO positions. The
  frame-grid maths node wires as `values.a` / `values.b` — the dotted
  names come from `finalize_prefix()` in `comfy_api/latest/_io.py`.
- **Bypass (mode 4) is not "delete"**: consumers rewire through it to the
  same-typed input. The bypassed turbo-LoRA loader means node 163's model
  comes from 153, not from 161.
- `json.dump(..., sort_keys=True)` in the harvester **destroyed the whole
  point** — declaration order IS the payload. Caught immediately because
  the converter then read `resize_type` as `1920`. The comment at the
  dump site now says never to do it.

**Built:**

- `scripts/harvest-comfy-node-defs.py` -> `scripts/comfy-node-defs.json`
  (31 classes, provenance recorded), so the converter, its test and CI
  need no ComfyUI install.
- `scripts/adapt-workflow.js` — UI->API conversion with all of the above,
  driven by a `panelAdaptation` block in the manifest sidecar
  (`dropNodes: [169, 170]` + the reason). Dropping a node that FED a
  widget input is the mechanism, not a side effect: the widget gets its
  own value back, which is precisely what makes injection work.
  Grounded refusals for an unknown class (lists what it knows), an
  unknown dynamic-combo key (lists the real options), too few stored
  widget values, a required socket orphaned by an adaptation, a
  `dropNodes` id the workflow lacks, and an already-API input.
- `extension/comfy-workflows/AE_LLAMA_H3_I2V_V1.json` + its manifest —
  seeded, so `setup.js` copies both to the user's data root.
- `comfy.js listWorkflows()` now skips `*.manifest.json`. Seeding a
  sidecar without this offers the model a phantom `<name>.manifest`
  template that `loadWorkflow` could only reject. Same trap for any user
  who adds a sidecar to their own workflow, which `readManifest`'s own
  comment invites them to do.

**Verification, and it is the strong kind.** The adapted graph was run
through ComfyUI 0.32.0's OWN `execution.validate_prompt()` in-process —
no generation, no models loaded. First run: `valid: false`, and the only
four errors were `value_not_in_list` on model FILENAMES. Zero structural,
naming or type errors: every input name, every dynamic-combo expansion,
every autogrow key and the bypass rewire were accepted by the real
validator. The four filenames turned out to be a probe artefact — see
below — and with the shared model root mounted the second run returned
**`valid: true`, `good_outputs: ["92", "159", "160"]`, no node errors.**

**Three findings for whoever takes parts 2 and 3:**

1. **The Desktop app's shared model root is NOT discoverable from
   `AppData\Roaming\ComfyUI\extra_models_config.yaml`** — that file lists
   only the Documents base path. Yet the running install mounts
   `AppData\Local\Comfy-Desktop\ComfyUI-Shared\models` (its own log
   proves it), and every H3 weight the manifest names lives THERE:
   `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (20.0 GB),
   `minimax_h3_ref2va_...` (20.0 GB), `minimax_h3_video_vae_fp16`
   (4.9 GB), `minimax_h3_audio_vae_fp32` (0.56 GB) and
   `qwen3vl_32b_minimax_h3_nvfp4_awq` (14.6 GB). The tier plan's
   register-existing matcher must carry that root explicitly; it cannot
   be derived from the yaml.
2. **`injectParams` cannot reach the H3 prompt.** It only writes text into
   `CLIPTextEncode*` nodes, and H3 carries its prompt on
   `MiniMaxH3ImageToVideo` (node 138). Seed injection works; prompt does
   not. That is part 2 — wire the manifest's `procedural` block (prompt
   138, durationSeconds 136 in SECONDS, resolution 167, firstFrame 114)
   into `injectParams`. The new test PINS the current miss as a KNOWN GAP
   so part 2 has a failing expectation to flip.
3. **`LoadImage` (114) still points at `2026-08-08_CRPTK-KREA2__00036_.png`**,
   a file only the owner's machine has. Any other user's first queue
   fails validation on it. Part 2 must inject or detach it — the manifest
   already says "omit for t2v", and the fl2va weight does t2v with no
   image.

**Not done, deliberately, and each is its own pass:** the KREA2 template
contains a SUBGRAPH ("Initial Loader"), stored as a definition plus a
node whose `type` is a UUID. The converter refuses it with the route that
does work named in the message — queue it once and pull the executed
prompt from `/history`, which comes back flattened (the owner already has
`get-api-workflow.ps1` doing exactly this). H3 r2v is unconverted. And
part 3 (one real generation through the panel, RTXVideoSuperResolution
made bypassable) is untouched — it needs part 2 first, or the model's
prompt never reaches the graph.

**One piece of debris, found and cleaned:** importing ComfyUI from the
repo root made an installed pack write `scripts/web/extensions/dzNodes/*`
into this repository. Deleted; the harvester now resolves its arguments to
absolute paths and `chdir`s into the ComfyUI tree before importing
anything, so a pack that writes relative assets lands in ComfyUI's own
directory.

**Why NO version bump.** This is feature-track work: a new bundled
artefact plus two build-time scripts. WORKPLAN item 5's rule is that new
capability rides the next MINOR the remote session cuts, and the
`listWorkflows` sidecar fix only matters because THIS commit is the first
to seed a sidecar — it is part of the feature, not a repair to something
users are running. Same call, same reasoning, as `add_light` yesterday.
Pushing at an equal version is the correct outcome. Flagging plainly:
`add_light` AND the H3 i2v template are both now sitting in the branch
waiting for 0.10.0.

## 2026-08-26 (local) — item 2d: the H3 prompt finally reaches the graph (part 2)

Harness **206/206** before and after (this pass touched no AE-side code).
Stubbed suite **31/31**, one new file (`tests/test-comfy-inject.js`, 33
checks). **No version bump**; reasons at the bottom.

Opened green, so the top unfinished item was 2d part 2: wire the manifest's
`procedural` injection points into `injectParams`, and deal with node 114's
`LoadImage` still naming a PNG only the owner's machine has.

**What was actually wrong.** `injectParams` finds a prompt by walking
conditioning links to `CLIPTextEncode*` nodes. H3 has none — the prompt is a
widget on `MiniMaxH3ImageToVideo` itself. The generic walk also cannot see
that this graph's length is authored in SECONDS (node 136, converted to the
model's 17k+5 frame grid by the expression at 135) or that its size is
MEGAPIXELS on a `ResolutionSelector` that owns the aspect ratio. So the
sidecar's `procedural` block is the only thing that knows, and until now
nothing read it: `grep procedural extension/js/*.js` came back empty.

**Built, all in `comfy.js`:**

- `injectParams(graph, params, manifest)` — third argument, and the
  procedural pass runs LAST so an explicit manifest target always beats a
  guess. With no manifest the function behaves exactly as before (pinned by
  a test).
- Entries resolve to an input by NAME (`input: "prompt"`, authoritative) or
  by `widget: N` counting literal — i.e. unlinked — inputs from the front,
  which is the fallback a hand-written manifest gets. Both refuse with
  grounded errors: a node id the workflow lacks, an input name the node does
  not have (listing the ones it does), a widget index past the end (listing
  the count and the names).
- `writeWidget` preserves the authored TYPE. Node 167's megapixels widget
  holds the STRING `".98"`, not a number; writing a float back would change
  the widget's type under a node that declared it text.
- **Seconds vs frames is a refusal, not a conversion.** A `frames` param
  against a template with a `procedural.durationSeconds` throws and names
  `durationSeconds` instead. 120 written into a seconds widget asks for a
  two-minute render and looks like it worked — the exact failure the panel's
  grounded-error rule exists for. `durationSeconds` against a template that
  has no seconds input is REPORTED in `applied`, not silently dropped.
- Width x height become megapixels (area only), capped at the manifest's new
  `maxMegapixels` (1.03 = H3's native 768x1344). The `applied` line says out
  loud that pixel dimensions come from the template's own aspect ratio, so
  nobody reads "1024x576" back as a promise.
- `uploadImage(base, filePath, cb)` — multipart POST to `/upload/image`.
  LoadImage names a file inside ComfyUI's own input dir and never a path, so
  this is the only way an AE-side render can reach a graph. `generate()`
  uploads BEFORE grafting and injects the returned name.
- **With no image the reference frame is DETACHED**: the LoadImage node is
  deleted along with every input linked to it. `first_frame` is an OPTIONAL
  input on `MiniMaxH3ImageToVideo` (measured, `scripts/comfy-node-defs.json`),
  so the fl2va weight then runs text-to-video. This is not politeness — the
  authored filename exists on one machine, so every other user's first queue
  would have failed validation. A manifest that does not mark its reference
  frame `detachable` keeps it, and says why.
- `comfy_generate` gained `durationSeconds` and `image` (tools.js docs +
  system prompt, or the model cannot reach them), and now passes the manifest
  it already reads down into `generate`.

**Verification — ComfyUI's own validator, not ours.** Both injected graphs
were run through `execution.validate_prompt()` in-process on ComfyUI 0.32.0
(no server, no models, `--cpu`): t2v (LoadImage deleted, `first_frame`
removed, 0.92 MP, 6 s) and i2v (uploaded filename injected, 5 s) both return
**`valid: True`, `good_outputs: ['159', '92', '160']`, no node errors**. The
Desktop app's shared model root has to be mounted by hand for this — nothing
in `extra_models_config.yaml` names it, as the last pass found.

**Stub faithfulness.** `tests/test-comfy-inject.js` reproduces the two shapes
that bite: the megapixels widget as a string, and `first_frame` as a link to
a one-machine file. The upload half runs against a real local `http.Server`
that parses the multipart body and echoes the bytes back — the test file's
contents deliberately contain a CRLF and a `--`, the two things a hand-rolled
multipart body gets wrong. The KNOWN GAP assertion in
`tests/test-workflow-adapt.js` is flipped: it now asserts the generic walk
still cannot place the prompt AND that the sidecar makes it land.

**Left for part 3** (one real generation end to end, needs a GPU run):
`RTXVideoSuperResolution` is still not bypassable, which part 3 must fix
before it can run on a machine without the NVIDIA app. Part 4 (attributing
the manifest's UNKNOWN nodes) is untouched.

**Why NO version bump.** Nothing users are running is repaired here: the
`procedural` block, the H3 template it drives, and the two new
`comfy_generate` arguments are all unshipped feature-track work, and
WORKPLAN item 5 puts new capability on the next MINOR the remote session
cuts. Third pass in a row at an equal version, deliberately. Waiting in the
branch for 0.10.0: `add_light`, the H3 i2v template, and now this.

## 2026-08-26 — WORKPLAN 2d part 3a: the NVIDIA upscaler is now optional

Finishing the pass that was interrupted mid-flight. The uncommitted work
was sound but had no tests and had never been verified; this pass read
it, verified the claim it rests on, backed it with coverage, and shipped
it. **No version bump**; reasons at the bottom.

**The problem.** The H3 i2v template ends in `RTXVideoSuperResolution`
(node 168), which ships in `comfyui_nvidia_rtx_nodes` and needs the
NVIDIA app's video SDK. It registers on some machines and not others, so
a template that hard-requires it fails validation everywhere the SDK is
absent — including, eventually, a customer's machine. Pass 5 flagged it
and stopped there.

**Changed** (`extension/js/comfy.js`, ~144 lines, plus 10 in the
sidecar):
- `classInstalled(base, class, cb)` — asks the LIVE server whether a node
  class is registered.
- `bypassNode(graph, id, passthrough)` — deletes a node and rewires its
  consumers to whatever fed the declared pass-through input. ComfyUI's
  own mode-4 semantics, except the socket is DECLARED by the manifest
  rather than inferred: an API-format graph carries no type information
  to infer from.
- `resolveOptionalNodes(...)` — honours a manifest `optionalNodes` block,
  running after grafting and before queueing, because it is the only
  step that can tell what exists on THIS machine.
- The manifest declares node 168 optional, passing through `images`.

**The fact it rests on, read out of the installed ComfyUI rather than
assumed** (`server.py`, `get_object_info_node`):

    out = {}
    if (node_class is not None) and (node_class in nodes.NODE_CLASS_MAPPINGS):
        out[node_class] = node_info(node_class)
    return web.json_response(out)

`GET /object_info/<class>` answers **200 with `{}`** for a class ComfyUI
has never heard of — it does NOT 404. A presence check that trusted the
status code would report every class installed and never bypass
anything. `classInstalled` tests for the key. The new test's fake server
reproduces that byte for byte, so "simplifying" it into a status check
fails the suite.

**Verified with ComfyUI's own validator, not our stubs.** Both graphs as
the PANEL actually queues them — `injectParams` has already detached the
one-machine reference frame — through `execution.validate_prompt()`
in-process on 0.32.0:

    kept      valid: True  good_outputs: ['159', '160', '92']  134.images: ['168', 0]
    bypassed  valid: True  good_outputs: ['159', '160', '92']  134.images: ['160', 0]

Same outputs either way; with 168 gone `CreateVideo` reads straight from
160. Getting that harness honest took three corrections worth recording:
custom_nodes live in the DATA root not next to the code (without that
every custom node reads as missing); several packs touch
`PromptServer.instance` at import, so one must be constructed first; and
the RAW template does NOT validate — node 114's `LoadImage` names a PNG
that exists on one machine, which is exactly what `injectParams` already
detaches. Validating the raw template would have "found" a bug that the
panel never ships.

**Coverage:** new `tests/test-comfy-optional-nodes.js`, 32 checks, run
against a fake ComfyUI that mimics the real `/object_info` contract, and
against the REAL shipped template and sidecar rather than a hand-made
stub. It pins: the 200-with-`{}` trap; rewiring 134 to 160 and no input
anywhere still pointing at 168; refusals when the manifest names no
pass-through, names one that does not exist, or names one holding a
literal (nothing to rewire to); `when: "always"`; a sidecar naming the
wrong class for an id being FATAL rather than deleting whatever node
inherited that id; an already-absent node being noted not fatal; and an
unreachable server being a grounded error rather than a silent "assume
missing" — bypassing on a network blip would quietly change what the
user renders.

**Harness:** real AE **206/206**. Stubbed suite 32/32 files.

**Why NO version bump.** Nothing users are running is repaired: the H3
template is not reachable from a shipped panel yet, and `optionalNodes`
only does anything for a manifest that declares it. Same call as the
last three passes — `add_light`, the H3 template, the prompt injection
and now this are all waiting on the remote session's 0.10.0.

**Still open for part 3:** the actual end-to-end generation. It is a
~20 GB model load that wants the card to itself, so it needs a pass with
llama-server down and nothing else running.

## 2026-08-26 (remote) — the field day: eachChildOf, the signature trap, and machine state changes

A full day of field failures on the owner's REAL work project, ending
with the panel verified working at 0.9.20. What the next session must
know:

**MACHINE STATE CHANGED (owner's AE machine):**
- PlayerDebugMode = "1" (string) is now set in HKCU CSXS.10/.11/.12.
  CEP loads unsigned extensions. This was the root cause of the day's
  delivery failures: the install was a SIGNED ZXP-extracted copy, every
  hand copy broke its signature, and CEP silently restored/served its
  cached signed 0.9.18 on each panel load — three "updates" in a row
  looked applied on disk and never reached the running panel.
- The install (%APPDATA%\Adobe\CEP\extensions\com.cptk.aellama) is now
  an UNSIGNED plain copy of the repo's extension/ at 3b0c99b + META-INF
  stripped. RECOMMENDED end state: run scripts/install.ps1 once to
  junction the install onto the repo so drift is impossible — the owner
  has not done this yet.
- GitHub Actions was DOWN for this repo most of the afternoon (runs
  stuck "queued" for hours, one in an uncancellable limbo). The feed
  still says 0.9.18. When CI recovers it will catch up on the next
  push; the panel at 0.9.20 will correctly ignore the equal/older feed.

**Product changes (remote-built, stub-green, NOT yet real-AE verified):**
- create_folder eachChildOf (0.9.19): one call creates a folder inside
  every REAL direct subfolder — built after the model, acting from the
  trimmed project summary, hit 2 of 10 targets and claimed success.
- except (0.9.20): exclusions ride the same call; unknown names refuse
  (the exclusion is a promise). Field-verified by the owner: 10
  subfolders, 7 created, 3 recognized existing, exclusion honored.
- Post-field polish (unshipped, this entry's commit): except accepts
  FULL PATHS as well as bare names (the model's first spelling);
  skippedAsExcepted now serializes before alreadyExisted so the
  exclusion receipt survives the panel's display cap; and mid-round
  tool refusals render MUTED ("adjusting — …", .msg.retry) instead of
  red ERROR — the owner's direction: a self-corrected round must not
  look like the plugin breaking. Real failures stay loud via the
  model's reply, the rollback notice, and the round cap.
- The selftest's except step now uses the path spelling, so the next
  real-AE run verifies the tolerance. Suite is 214 steps.

**For tonight's pass:** verify this batch in real AE (fan-out steps
included), bump patch, and note the panel updates by plain file copy
now (or the junction, if the owner ran install.ps1).

## 2026-08-27 (local) — item 2d part 3: the first real generation, end to end

The item was "ONE real generation end-to-end through the panel to verify".
It ran, and it found the bug that every previous pass was structurally
unable to see: three passes had validated the H3 template against
ComfyUI's own `validate_prompt`, which says a graph is well-formed and
nothing whatsoever about whether it RENDERS.

**New: `scripts/comfy-probe.js`** — the ComfyUI half of what chat-probe
does for AE. Canned prompt -> the user's real settings -> real tools.js
`comfy_generate` (enhancement, VRAM arbiter, import) -> real comfy.js
(graft -> optional nodes -> queue -> poll -> download) -> a REAL local
ComfyUI on the 5090 -> real After Effects via `AfterFX.exe -r`
(`import_file`) -> verdicts read back out of the project, then the
imported item is deleted again with the panel's own `delete_item`.
Defaults are the smallest thing the template can render (0.2s, which the
graph's own `max(5, …)` floor turns into 5 frames, and 0.15 MP): this is
a plumbing test, not a quality test.

**The bug it found, first run:**

    [WinError 267] The directory name is invalid:
    'C:\...\output\video\MiniMax_H3\%date:yyyy_MM_dd%'

Every frame sampled, then the render died at the LAST node. The template's
`SaveVideo.filename_prefix` is `video/MiniMax_H3/%date:yyyy_MM_dd%/…`, and
**nothing on the ComfyUI server expands those tokens.** The FRONTEND
rewrites the text (`applyTextReplacements`, frontend 1.48.7) before it
posts; the server saves whatever string it is handed. SaveVideo's own
tooltip advertises the feature, which is exactly why it reads as
server-side and is not. On Windows the unexpanded token is not merely
ugly — it holds a COLON, which no path may contain, so the failure is
total rather than cosmetic.

Field proof it is client-side work, not a guess: the owner's own UI runs
of this same template wrote `output/video/MiniMax_H3/2026_08_03/`,
`…/2026_08_04/`, and so on. Same prefix, expanded, because a browser was
in the loop. The panel posts API-format graphs, so the panel IS the
frontend.

**Fixed at the root** (`extension/js/comfy.js`, ~115 lines):
`expandFilenameTokens(graph, when)` runs over every literal string input
immediately before the POST — the same point in the sequence the browser
does it — and is a deliberately literal port of the frontend's own
function: token regex `/%([^%]+)%/g`, date grammar
`dd?|MM?|hh?|mm?|ss?|yyy?y?` zero-padded to each token's own length,
`%Node.widget%` references scrubbed of `[/?<>\:*|"]`, and — the part that
makes it safe — ANY token it cannot resolve is returned verbatim. That
last rule is what keeps a prompt reading "brightness 50% to 100%"
untouched. Each expansion is reported in `applied`, so the user and the
model both see what the filename became.

Two things the API format cannot carry, and how the port handles them:
the browser matches a `%Name.widget%` reference against the node's
"Node name for S&R" property first and its title second. An API graph has
neither, so `class_type` (what S&R defaults to) is tried first and the
adapter-preserved `_meta.title` second. A LINKED input has no literal to
substitute, so the token stays visible rather than being invented.

**The verified run** (seed 777, nothing cached — the seed-12345 re-run
came back in 3s off ComfyUI's execution cache, which is why it is not the
number quoted here):

- generation 12 s wall clock, 5 frames, prompt->file->AE with no hand steps
- **VRAM peak 28 379 MB, idle 3 195 MB** on the RTX 5090 — ~25 GB for H3
  at 5 frames / 0.15 MP. First honest number for item 7's catalog work.
- output 1920x1080 mp4, 103 342 bytes, `ftyp` box present
- AE read it back as 1920x1080, 0.20833 s @ 24 fps (= 5/24 exactly), with
  both video and audio streams
- 1080p regardless of the 0.15 MP asked for, exactly as the manifest's
  `keptNote` says: `RTXVideoSuperResolution` is installed on this machine,
  so it was KEPT and rescales to a fixed 1920x1080

**Coverage:** new `tests/test-comfy-filename-tokens.js`, 28 checks against
the REAL shipped template. It pins the whole date grammar (including
`yyy`, which is NOT a token and must stay verbatim, and the padded/unpadded
pairs), idempotency, the percent-riddled prompt, links never being
rewritten, both reference spellings, the illegal-character scrub, and the
unresolvable cases. Crucially it also queues the real template at a fake
ComfyUI and asserts on the POSTED body — the function existing proves
nothing if `generate()` ever stops calling it — including the flat
assertion that no colon reaches the server.

**Harness:** real AE **214/214**. Stubbed suite **33/33 files**.

**Bumped 0.9.21** (patch). This is a fix to SHIPPED behavior, not new
capability: `comfy_generate` and `comfy.js` are in the installed panel,
the template is already seeded into the owner's data folder, and any
template whose prefix carries a date token — which is ComfyUI's own
default idiom — could not save a file at all. Verified in real AE, so it
ships tonight rather than waiting for 0.10.0.

**Two things for a human / the remote session, neither touched here:**

1. **Seeding is copy-if-absent** (`setup.js ensureDataDirs`: "never
   overwrite edits"). The owner's `%APPDATA%\AE-Llama\comfy-workflows`
   still holds the 2026-08-26 10:33 copies, which PREDATE the
   `optionalNodes` block. So the RTX-bypass fix cannot reach any install
   that already seeded, and neither will the next template correction.
   Blind overwrite is wrong (it would eat user edits); this wants a
   version- or checksum-aware seed, which is a design call, not a
   one-line patch. Today's fix is unaffected — it lives in panel code.
2. **The owner's `comfyUrl` says `http://127.0.0.1:8000`; ComfyUI is
   actually on 8188** (the running instance was started with our own
   `--extra-model-paths-config`, port 8188). The probe was pointed at
   8188 with `--url`. Left alone deliberately: with 8000 unanswered the
   panel would try to BOOT a second backend, and starting a second
   ComfyUI unattended next to a live one is not a thing to do while the
   owner is asleep. One setting to change, ten seconds, human's call.

Still open in 2d: part 4 (attribute the manifest's UNKNOWN nodes), the
KREA2 subgraph conversion, and the HF file pins.

## 2026-08-27 (local, second pass) — item 2d part 4: ask the loader, not grep

The item read "attribute the manifest's UNKNOWN nodes", which sounds like
filling in two placeholder strings. It was not. The placeholders were the
*honest* entries — they said UNKNOWN. The damage was in the manifest that
claimed to be finished.

**What was actually wrong.** `AE_LLAMA_H3_I2V_V1.manifest.json` carried
`"nodeAttributionScannedOn": "2026-08-25"` and named four packs. The
template the panel SHIPS (`extension/comfy-workflows/…`) loads classes from
seven, and two of them appeared nowhere in the repo:

- `ComfyUI-sol-attn` — `MiniMaxH3ScheduledSolAttentionPatch`
- `ComfyLiterals` — `Float`

On a machine without those two the graph does not load at all, and nothing
told anyone which packs to install. Three more entries were positively
wrong: `ComfyMathExpression` was credited to ComfyUI-MiniMaxH3-FirstBlockCache
when the loader reports `comfy_extras.nodes_math` (core), the pack was
recorded as owning a class it does not, and `PlaySound` was listed under a
class name no installed pack registers — the real class is
`PlaySound|pysssss`. `Power Lora Loader` was listed for the shipped template,
which does not contain it, and under the wrong name besides (`Power Lora
Loader (rgthree)`).

**Why the 2026-08-25 scan produced that.** It grepped pack sources for class
names. Grep cannot tell a definition from a mention, and it cannot see which
of two candidates actually won registration. Every one of the three
"COLLISION" warnings it filed is false:

- `DepthAnythingV2Preprocessor` is not defined twice. `comfyui-art-venture`
  is installed and loads 78 classes, but line 34 of its
  `modules/controlnet/preprocessor.py` only *references* the name as a
  lookup into someone else's mapping.
- `ResolutionSelector` does not collide with `ComfyUI-UtilsCollection`;
  that pack registers `ResolutionSelectorExtended`.
- `PlaySound` does not collide with KJNodes; the two classes are
  `PlaySound|pysssss` and `PlaySoundKJ`.

**The method that replaces it.** A running ComfyUI answers `/object_info`
with a `python_module` per registered class — the loader's own record of
where each class came from, `nodes`/`comfy_extras.*` for core and
`custom_nodes.<folder>` for a pack. The folder then resolves to a repo URL
from that pack's `.git/config` or `pyproject.toml`. That is not a heuristic;
it is the answer.

**New: `scripts/attribute-workflow-nodes.js`.** Enumerates the classes a
workflow needs (both the authored UI format and the adapted API format),
attributes each from `/object_info` (or a saved dump via `--object-info`),
resolves repos off disk, and with `--write` splices the result into the
manifest next to it. Three things it does deliberately:

- **It recurses into subgraphs.** KREA2's `UNETLoader`, `VAELoader` and
  `CLIPLoader` exist ONLY inside the "Initial Loader" subgraph; a top-level
  walk sees a bare UUID node type and misses three dependencies.
- **It merges rather than overwrites.** An existing entry for the same pack
  keeps its `note`, its `optional` flag and its repo; only the `nodes` list
  is replaced by what was measured. Curated prose survives a rescan.
- **It splices raw text, not a JSON round-trip.** A round-trip would reflow
  every manifest and un-escape the `—` sequences in the enhancer
  instructions, turning a three-line change into an unreviewable diff. It
  also matches the file's own line endings, which a first attempt did not.

Anything absent from `/object_info` and not in a known-virtual list exits 2
as UNRESOLVED — because "the server never heard of this class" is correct
for an annotation node and a broken install for anything else.

**All three manifests are now attributed, zero UNKNOWN**, with a scan date
and the method recorded in each. Frontend-only nodes get their own block:
`Note`/`MarkdownNote`, and rgthree's `Label (rgthree)` and `Fast Groups
Bypasser (rgthree)`, which are canvas-only and provably absent from the
server — worth writing down, because their absence otherwise reads as a
missing rgthree install.

**Coverage: `tests/test-workflow-manifests.js`, 51 checks, no ComfyUI
needed.** It requires the same enumerator the tool uses, so the check cannot
drift from what wrote the file, and it asserts per workflow: no UNKNOWN
placeholder; every class the graph uses is declared exactly once; nothing
declared that the graph does not use (the stale `Power Lora Loader` case);
every non-core pack carries a repo URL; `optionalNodes` points only at
classes that are in the graph AND attributed; and a scan date exists. Plus
named checks pinning each of the five corrections. Reverted against the old
manifest it fails 6 checks and names both missing packs — verified, not
assumed.

This bug class is invisible to a validator: `validate_prompt` passed three
times on this exact template, because it ran on the one machine where every
pack happens to be installed.

**Harness: real AE 214/214** (before and after — nothing AE-side changed).
Stubbed suite **34/34 files**.

**NO version bump.** No panel code reads `customNodes` (`grep` over
`extension/js/` confirms: only `procedural`, `optionalNodes` and
`panelAdaptation` are consumed), the seeded manifest is copy-if-absent so
the owner's data folder keeps its 08-26 copy regardless, and nothing users
run behaves differently. Metadata pass — same call as `add_light` and the
template work, all waiting on the remote session's 0.10.0.

**What this hands the next pass, all logged in WORKPLAN.md, none done here:**

1. **The shipped H3 i2v template needs six custom packs and declares one of
   them bypassable.** ComfyUI-sol-attn, ComfyLiterals, comfyui-kjnodes,
   ComfyUI-MiniMaxH3-FirstBlockCache, comfyui-easy-use and
   comfyui-custom-scripts are all hard requirements today; only
   RTXVideoSuperResolution has an `optionalNodes` rule. So the template runs
   on the owner's machine and probably nowhere else. `PlaySound|pysssss` and
   `easy cleanGpuUsed` look incidental and are the obvious first candidates
   for `optionalNodes`, but deciding that per pack is a BUILD pass with a
   real generation behind it, not a scan — deliberately not smuggled in here.
2. **`adapt-workflow.js` FRONTEND_ONLY is short two entries** for KREA2:
   `Label (rgthree)` and `Fast Groups Bypasser (rgthree)`. Left alone
   because the KREA2 conversion is its own queued item and its chosen route
   is pulling the executed prompt from `/history`, which sidesteps the
   adapter entirely. Recorded so that pass does not rediscover it.
3. The owner's `comfyUrl` still says port 8000 while ComfyUI runs on 8188
   (unchanged from the previous pass — still a human's ten-second call, and
   still not something to change unattended next to a live backend).

## 2026-08-28 (local) — item 2d: the six packs, and the node that could not be bypassed

The item, filed by the 2026-08-27 attribution pass: the shipped H3 i2v
template hard-requires SIX custom packs and declares one node bypassable, so
it loads on the owner's machine and probably nowhere else. Decide per pack
what is load-bearing, then measure the bypassed graph.

**The decision, per node, from /object_info signatures rather than from the
node names.** All seven undeclared classes turned out to be removable, but
not all in the same way, and the split is the interesting part.

Four are MODEL patches in one chain — `148 UNETLoader -> 153
ModelPreviewOverrideKJ -> 163 MiniMaxH3SigmaShift (core) -> 164
ApplyMiniMaxH3FirstBlockCache -> 165
MiniMaxH3MemoryEfficientSageAttentionPatch -> 162
MiniMaxH3ScheduledSolAttentionPatch -> 139 BasicGuider`. Each takes MODEL on
input `model` and returns MODEL at socket 0, so each is a
`passthrough: "model"` bypass, and because `bypassNode` rescans every
consumer each time, four separate bypasses collapse the chain to
`148 -> 163 -> 139` in any order. What each one COSTS to lose is written into
its entry, because it is not the same cost: the preview override is a browser
convenience the panel never looks at; FirstBlockCache and sol-attn are
speed-for-fidelity trades by their own documentation; the kjnodes
SageAttention patch is the one that genuinely matters on a small card, since
bypassing it raises attention VRAM. That last one is marked as the pack to
install first, rather than pretending all four are equivalent.

Two are incidental: `159 PlaySound|pysssss` is terminal (nothing consumes its
output, so dropping it removes a chime) and `160 easy cleanGpuUsed` is a
`*`-typed pass-through sitting between VAEDecode and the upscaler.

**The seventh needed new machinery.** `167 Float` (ComfyLiterals) is the
megapixel source. It CANNOT be bypassed and never could be: its only input is
the literal `".98"`, so `ResolutionSelector.megapixels` would have nothing to
be rewired to — `bypassNode` already refuses exactly this and says why. The
answer is not a bypass but a swap: core `PrimitiveFloat` has the identical
`FLOAT` output and is already used TWICE in this same graph (nodes 136, 150).

So `optionalNodes` entries now take EITHER `passthrough` OR a new
`substitute: {class, inputs: {...}}` — never both; setting both is a grounded
refusal, because they are two different answers to the same question and
picking one silently would render something nobody chose. Three things the
substitution had to get right:

- **Coercion.** ComfyLiterals declares `Number` as a **STRING** widget;
  `PrimitiveFloat` wants a FLOAT. Both signatures measured from the running
  loader. Hence `{from: "Number", as: "number"}` — and a value that will not
  coerce is refused here rather than POSTed as `NaN`. A LINK is never coerced
  at all: its type is whatever its source emits, which this side cannot see.
- **Order.** Injection runs BEFORE optional nodes resolve, so a megapixel
  figure the panel wrote into `Number` has to survive the swap. It does — the
  same `from` rule carries it. Covered by a test that injects 0.15 and reads
  0.15 back out of `value`.
- **The substitute must itself exist.** If the replacement class is also
  missing, that is a grounded error naming BOTH classes, raised before the
  queue POST — otherwise the user pays for the round trip to learn it.

Unmapped inputs are DROPPED, not inherited: a substitute class has its own
signature and a stray key fails validation at the server.

**Measured, on a GPU freed with POST /free before each run so the two are
comparable:**

| graph | wall | VRAM peak | output |
|---|---|---|---|
| as authored, all 7 packs | 20s | 31285 MB (idle 1653) | 102002 B, 1920x1080 |
| BARE, every pack forced off | 18s | 31349 MB (idle 1525) | 19699 B, 544x288 |

Then the bare graph end to end through the panel path into real AE: **PASS**,
imported as 544x288, 0.208s @ 24fps, video AND audio, then cleaned up. That
is the claim the item wanted and it now has a run behind it: with ZERO custom
node packs the shipped template renders and lands in AE.

Two honest caveats on those numbers. (1) At the probe's smallest size — 5
frames, 0.15 MP — the four optimizer patches have nothing to bite on; the
peak is set by ~20 GB of weights, not by attention, which is why bare is not
measurably hungrier or slower. Their value shows at real clip lengths, which
this probe deliberately does not render. Do NOT read this table as "the
patches do nothing". (2) Earlier runs in this pass measured 52s, 182s and
190s for the same work; all three were taken with the GPU already sitting at
~31 GB and are VRAM-pressure artifacts, not graph differences. Free before
timing, or the numbers are noise.

**The output size difference is the whole visible consequence** and was
already written in the manifest's keptNote: RTXVideoSuperResolution rescales
to a FIXED 1920x1080 regardless of the injected megapixels, so a machine
without the NVIDIA SDK gets the graph's own resolution. Now measured rather
than asserted.

**New: `comfy-probe.js --bare`** — force every `optionalNodes` rule on and
render the fallback graph. It works on the MANIFEST (`generate` already
honours an `opts.manifest`), so the panel code under test stays exactly the
code that ships. The classes remain installed, which is the point: this
measures the FALLBACK GRAPH, not a broken install.

**Coverage.** `tests/test-comfy-optional-nodes.js` grew from the one RTX node
to the whole block (its index-based assertions now look entries up by class,
so adding an entry cannot silently retarget them). The bare-machine scenario
asserts what a POST would otherwise be the first to discover: every
custom-pack class gone, the four-deep model chain collapsed to
`148 -> 163 -> 139`, the image path collapsed past cleanGpuUsed AND the
upscaler straight to VAEDecode, node 167 now core `PrimitiveFloat` carrying
`0.98`, and **no dangling link anywhere**. Plus nine `substituteNode` unit
checks and the two new grounded refusals.

`tests/test-workflow-manifests.js` gained the invariant that is the actual
bug class: for every SHIPPED template, every non-core class must carry a rule
for removing it, each rule must say HOW, and a substitute must point at a
CORE class. Authored-but-unadapted templates are exempt — the conversion is
where their rules get written. **Reverted to the 2026-08-27 manifest it fails
and names all seven**: ApplyMiniMaxH3FirstBlockCache, easy cleanGpuUsed,
Float, MiniMaxH3MemoryEfficientSageAttentionPatch,
MiniMaxH3ScheduledSolAttentionPatch, ModelPreviewOverrideKJ,
PlaySound|pysssss. Verified, not assumed.

**Harness: real AE 214/214. Stubbed suite 34/34 files.**

**Bumped 0.9.22** (patch). This is a fix to SHIPPED behavior, not new
capability: the template and `comfy.js` are both in the panel, and on any
machine but the owner's the template could not LOAD — the failure was total,
not degraded. Verified in real AE and real ComfyUI, so it ships tonight.

**Three things for a human / the remote session:**

1. **A leftover AE dialog cost this pass twenty minutes and would cost a user
   a render.** Two comfy-probe runs reported `FAIL AE imported it —
   ExtendScript error (see AE)`, on the AUTHORED graph as well as the bare
   one, so it was not the change under test. `import_file` called directly
   then answered nothing at all. The harness diagnosed it: "a dialog was
   already blocking After Effects before this run started… the save-changes
   prompt a previous run left behind", answered it with Cancel, and passed
   214/214. The repeated `AfterFX.exe -r` launches in this pass are what
   raised it. Worth noting that comfy-probe reports a blocked AE as a tool
   error, which reads like a code defect; the harness's dialog check is the
   thing that tells the truth, and comfy-probe does not have it.
2. **`PlaySound|pysssss` is bypassed only when the pack is MISSING**, so the
   owner's ComfyUI still beeps when a panel-driven render finishes. Making
   that unconditional is a product decision (the panel has its own UI and a
   chime from a hidden backend is confusing), not a portability one, so it
   was left as the template author wrote it. One line if the answer is yes.
3. Unchanged from the last two passes: seeding is copy-if-absent, so the
   owner's `%APPDATA%\AE-Llama\comfy-workflows` still holds the 2026-08-26
   manifest and will NOT pick up any of this. A version- or checksum-aware
   seed is the fix and it is a design call. **This pass raises the stakes on
   it**: the portability work only reaches a machine that has never seeded.
   Also still open: the owner's `comfyUrl` says port 8000 while ComfyUI runs
   on 8188 (the probe was pointed at 8188 with `--url`).

Still open in 2d: the KREA2 subgraph conversion and the HF t2v/i2v file pins.

## 2026-08-28 (local, second pass) — item 2d: the subgraph, and the wire that was never drawn

The item: KREA2 is the last bundled template the converter cannot touch,
because it contains a subgraph. The workplan's sanctioned route was "queue it
once in ComfyUI and pull the executed prompt from `/history`". That route was
checked first and is NOT available unattended: `/history` holds 13 entries,
all of them this month's H3 runs, and queueing KREA2 for real needs a human at
the browser (or a full Krea generation this pass has no budget for). So the
converter learned to do it instead — and on the way found something the
/history route would have hidden.

**Three things stood between KREA2 and an API graph. The third was invisible.**

1. **The subgraph.** `adapt-workflow.js` now expands instances inline, giving
   inner nodes the id `<instance>:<inner>` — the same scheme ComfyUI's own
   expansion produces, so an adapted template can be diffed against a
   `/history` prompt id for id. One measured fact drove the design: the
   instance carries the promoted COMBO widgets (`inputs: []`, three
   `widgets_values` in definition-input order) while the inner loaders keep
   their OWN stale copies of those values. The instance's copy is the one the
   user edits, so it wins; trusting the inner value would have loaded whatever
   the author had selected before promoting the widget. Promoted inputs that
   are CONNECTED in the parent cross the boundary as links instead, and
   nesting recurses (`60:80:50`).

2. **Two rgthree nodes the backend has never heard of.** `Label (rgthree)` and
   `Fast Groups Bypasser (rgthree)` join Note/MarkdownNote in `FRONTEND_ONLY`,
   and this is measured rather than assumed: the harvester loads every
   installed pack and reports exactly those four as absent from
   `NODE_CLASS_MAPPINGS`. The Bypasser looks load-bearing and is not — what it
   toggles is each node's `mode`, and the export already carries the modes it
   left behind.

3. **`Anything Everywhere` — the one nobody had listed.** cg-use-everywhere
   draws NO wire: it broadcasts each of its inputs to every unconnected socket
   of the same type, and the FRONTEND applies that as it builds the API
   prompt. In KREA2 it carries MODEL, CLIP, VAE and LATENT to **nine** sockets.
   Convert without it and the graph is missing nine links the author is looking
   straight at — and it fails at the server, not here. The converter now
   applies the broadcast itself, only to sockets the node actually DRAWS (an
   optional input the frontend never rendered has no virtual link either), and
   refuses everything it cannot reproduce faithfully: the regex/group/colour
   variants (`Anything Everywhere?` and friends), any `ue_properties`
   restriction on the plain node, two inputs broadcasting the same type, and an
   untyped `*` broadcast. Every refusal names the /history route as the way out.

**Verified, in this order:**

- The H3 i2v template still converts **byte for byte** into the shipped API
  file (the graph has no subgraph and no broadcaster, so it takes none of the
  new paths). That is a test assertion, not an eyeball.
- Defs re-harvested from the real install: 31 -> 52 classes, and a diff proves
  the original 31 are **unchanged, in the same order** — order IS the payload
  here. `--classes-from` now also walks subgraph definitions, or the classes
  inside one would never be harvested.
- The converted KREA2 through ComfyUI 0.32.0's own
  `execution.validate_prompt()`: **`valid: True`**, good outputs
  474/475/478/479/482/497, no node errors — first try, every model filename
  resolved, every UE-filled link accepted.
- 34/34 stubbed test files. `tests/test-workflow-adapt.js` grew from 50 to 82
  checks: the subgraph block (promoted-widget override, connected promotion,
  nesting, three refusals), the use-everywhere block (fills, does NOT fill a
  widget slot or a connected socket, four refusals), and a section that
  converts the REAL checked-in KREA2 and asserts what only a real graph can
  show — `439:436` carrying `krea2_turbo_int8_convrot.safetensors`, both
  VAEDecodes reaching the loader ONLY through the broadcast, MODEL/CLIP coming
  from the LoRA loader in the middle rather than the subgraph behind it.
- **Harness: real AE 214/214.** Untouched by this pass, run before and after.

**New: `scripts/validate-api-workflow.py`.** Every workflow pass since
2026-08-26 has hand-written this and thrown it away. It reuses the harvester's
`boot()`, so both agree on how ComfyUI is started, and it answers the one
question a converter cannot answer about itself.

**NOT bumped, and not shipped.** Nothing under `extension/` changed: this is
scripts and tests. The converted KREA2 graph is deliberately NOT seeded,
because `tests/test-workflow-manifests.js` rightly demands a removal rule per
non-core class before a template ships, and KREA2 keeps five live ones (`Any
Switch (rgthree)`, `Power Lora Loader (rgthree)`, `Image Comparer (rgthree)`,
`SesquiLatentUpscale`, `easy cleanGpuUsed`). Writing those rules honestly cost
the 0.9.22 pass a whole night for seven nodes; doing them badly here to claim
the item would ship a template that dies on anybody else's machine — exactly
the bug 0.9.22 fixed. That work, plus a `procedural` block and one real
generation, is now the single remaining 2d item in WORKPLAN.md, with the
regeneration command written next to it.

**Three notes for the next pass / a human:**

1. **The HF file pins (2d's other open bullet) were already done on
   2026-08-25** — 30 files in `docs/COMFY_TIERS_PLAN.md`; the tree was
   re-listed today and is unchanged. Only the workplan text was never struck.
   That is twice now that an unstruck line has cost a pass a re-read of the
   log; both are struck now.
2. **A silent-loss class the converter still has**: rgthree's `Power Lora
   Loader` stores its loras in `widgets_values` as objects the harvested
   `INPUT_TYPES` does not declare, so they are dropped with a "trailing widget
   value(s) ignored" note. In KREA2 they are empty (`{}`), so nothing is lost
   today — but a template that actually used them would convert quietly wrong.
   Worth a rule before any template with configured loras ships.
3. KREA2's author left the whole Ollama enhancer chain, the Krea2Control
   chain and the depth/bloom extras BYPASSED, so the live graph is the plain
   t2i path and the `Any Switch` falls through to the manual prompt input.
   That is convenient for the panel (it enhances with its own chat model) and
   the conversion preserves it; the shipping pass should keep it that way
   rather than un-bypassing anything.

## 2026-08-28 (local, third pass) — item 2d, the LAST one: KREA2 ships (0.9.23)

The item as WORKPLAN.md left it this morning: the converted KREA2 graph is not
seeded, because a shipped template owes a removal rule per non-core class and
KREA2 keeps five live ones, plus a `procedural` block and one real generation.
All three are done, and a fourth thing turned up that would have killed the
render on every machine but this one.

**Harness: real AE 214/214, before and after. 34/34 stubbed test files.**

### The rule that did not exist yet

Four of the five were shapes the H3 template had already taught: a selector
with one live input, a VRAM-cleanup pass-through, a terminal viewer node. The
fifth was not.

**`Power Lora Loader (rgthree)` emits TWO types.** Measured from /object_info:
`output: ["MODEL", "CLIP"]`, fed by two different inputs (`model` from the
UNETLoader, `clip` from the CLIPLoader), and KREA2 wires four MODEL consumers
and two CLIP consumers to it. `bypassNode` rewired EVERY consumer to a single
source regardless of the output slot it read — so the one honest-looking rule
(`"passthrough": "model"`) would have handed both CLIPTextEncodes a MODEL, and
the server would have reported the type error at a node the manifest author
never touched.

So `passthrough` now takes either an input NAME (single-output, the common
case) or a MAP of output slot to input name:

    "passthrough": { "0": "model", "1": "clip" }

and the string form is no longer permissive — it answers slot 0 ONLY and
refuses the moment a consumer reads any other slot, naming that consumer and
showing the map to write instead. Checked against both shipped graphs first:
every optional-node consumer in H3 reads slot 0, so nothing existing changes
behaviour. Two smaller corrections rode along: nothing is mutated until every
source resolves (a half-applied bypass used to leave consumers pointing at a
deleted node), and a slot NOTHING reads no longer needs a link, which is what
makes a terminal node with a literal input removable.

### The one that had to be a substitution

`SesquiLatentUpscale` sits between the two sampler passes at 1.6x. Bypassing it
validates fine and is silently wrong: the second pass would run at the FIRST
pass's size and save an image 1.6x smaller than the graph promises. Core
`LatentUpscaleBy` has the identical LATENT -> LATENT shape, so it is a swap.
Signatures measured, not assumed — Sesqui declares `latent/model_format/scale/
half_precision`, LatentUpscaleBy declares `samples/upscale_method/scale_by`, so
the rule carries `samples <- latent` and `scale_by <- scale`, supplies
`upscale_method` as a const, and drops the two widgets the core class has no
notion of. `bislerp` is the const, being the one core method built for latent
vectors rather than pixels.

That exposed a rule conflict worth writing down: `LatentUpscaleBy` has to be
declared as a core dependency (check 7 demands a substitute resolve to a core
class) while appearing nowhere in the graph (check 4 calls anything declared
but absent a stale declaration). Both checks are right; the enumerator was
wrong. `attribute-workflow-nodes.js` grew `classesFor()` = the graph's classes
UNION every optionalNodes substitute target, and the test uses the same
function, so the tool and the check still cannot drift.

### The absolute path — the fourth thing, and the one that actually shipped broken

KREA2's SaveImage prefix is `C:\Users\mr\Documents\ComfyUI\output\_KREA2\...`.
ComfyUI joins a prefix onto ITS OWN output dir and then refuses anything
landing outside it (`folder_paths.get_save_image_path` -> "Saving image outside
the output folder is not allowed"). On this machine the two paths agree by
coincidence; on anyone else's the render dies at the LAST node with every GPU
second already spent. Same class as the `%date:%` colon that cost 0.9.21 a
render, and equally invisible to `validate_prompt`.

Fixed in the sidecar, not by hand: `panelAdaptation` gained `setInputs`, so
the correction is declared where its reason lives and survives the next
regeneration. It refuses a node that is not in the adapted graph, an input the
class does not have, and — the one that matters — overwriting a LINK, because
rewiring is the graph author's job and not the sidecar's.

### Measured, in this order

- Converted KREA2 through ComfyUI 0.32.0's own `validate_prompt`: **valid:
  True**, good outputs 478/474/479/497/482/475.
- The BARE graph (all five rules forced) through the same: **valid: True**.
- **One real generation through the panel**, 768x768, ComfyUI 0.32.0 on the
  5090: prompt -> graph -> PNG -> AE. 17s, VRAM peak 24872 MB, imported into
  real AE at **1232x1232** (768 x 1.6, rounded to the latent grid — the proof
  the upscale is live), then deleted again. Every applied line correct,
  including `prompt -> node 600.value (manifest)` and the filename token
  expanding to `_KREA2/2026-08-28/...`.
- **The same generation with `--bare`**, i.e. as if none of the three packs
  were installed: 10s, VRAM peak 20712 MB from a 2408 MB idle, **1232x1232
  again** — which is the whole point of substituting the upscaler rather than
  dropping it.

### Two probe fixes the image template forced

`comfy-probe.js` was written for video and asserted `duration > 0` on the
imported footage. AE reports **duration 0 and frameRate 0 for a still**, so
that verdict would have failed on correct behaviour. It now keys off the output
file's extension and checks dimensions only for a still, saying so in the
verdict line. It also gained `--prompt`, because the canned H3 prompt (shots,
`overall_soundscape`, `non_diegetic_music`) is nonsense to an image model.

### What the manifest says about the things it does NOT do

The `procedural` block names exactly one node — the prompt, on node 600, the
manual-prompt primitive. It has to: both CLIPTextEncodes' `text` inputs are
LINKS to the rgthree Any Switch, and `setEncoderText` only follows a link to a
node with exactly ONE string input. The switch has none, so the generic walk
gives up **silently** and the render would have used the template's
placeholder. Resolution and seed are deliberately NOT declared — size lands on
`EmptyLatentImage` in real pixels and both `noise_seed` widgets take the one
seed, all through the generic walk, and a procedural entry would write the same
numbers twice. The manifest says so in `resolutionNote`/`seedNote`/
`negativeNote` rather than leaving the next reader to wonder.

### Bumped to 0.9.23 — the assumption, stated

Item 5's rule is "no version bump on feature passes; new TOOLS ride the next
minor". No tool was added here: `comfy_generate` already exists and a workflow
template is data. Everything else in 2d bumped patch (0.9.21, 0.9.22), this
pass changes `extension/`, and seeding is copy-if-absent PER FILE — so a new
template does reach an existing install, but only if the panel updates at all,
which needs the bump. Without it the work reaches no panel. Bumped patch; if
the remote session disagrees it folds into 0.10.0 at no cost.

### Left for a human or a later pass

1. **Still open from the last two passes, and now load-bearing for this one**:
   seeding is copy-if-absent, so `%APPDATA%\AE-Llama\comfy-workflows` picks up
   the NEW KREA2 files (they are absent there) but keeps its stale 2026-08-26
   H3 manifest. A version- or checksum-aware seed is the fix and it is a design
   call.
2. Also still open: the owner's `comfyUrl` setting says port 8000 while ComfyUI
   runs on 8188. Every probe this month has been pointed with `--url`.
3. The `Power Lora Loader` silent-loss class is unchanged — rgthree stores
   loras in `widgets_values` as objects the harvested INPUT_TYPES does not
   declare, so a template that actually configured some would convert with them
   dropped. Empty in KREA2, so nothing is lost today; the keptNote records it.
4. H3 r2v remains unconverted, deferred until 5.8 lands (it needs image+audio
   inputs the panel cannot feed).

**Item 2d is now CLOSED.** The next pass starts at item 3, 4 or 5.

## 2026-08-28 (local, fourth pass) — item 3: the suite grows 46 steps, and AE renames a property

Item 2d closed on the previous pass, so this one started at **item 3,
extend selftest.js coverage**. The harness was green first (214/214), so
the pass was the item and not a repair.

`docs/CAPABILITIES.md` computes the queue for item 3, and it named 15
host tools the suite had never once called. The suite now runs **260
steps, all passing in real AE 2026**, and that list is down to four.

### Probe first, and it paid twice

Nothing here was written from training. A temp `.jsx` drove 40 calls
through `AELL_call` in real AE and dumped the raw JSON, and the steps
were written against that. Two of the measurements were surprises:

**A 2D layer already advertises the entire 3D transform set.** Its
Transform group hands out Anchor Point, Position, X/Y/**Z** Position,
Scale, **Orientation**, **X Rotation**, **Y Rotation**, Rotation,
Opacity and Appears in Reflections — twelve properties, the same twelve
a 3D layer has. So nothing about 3D-ness is discoverable from the
property tree, which is the field evidence behind CLAUDE.md's rule that
3D-ness comes from `layer.threeDLayer` and never from a value's length.

**A layer root ships two groups both called "Geometry Options"**
(`ADBE Plane Options Group` and `ADBE Extrsn Options Group`). Display
names are not unique, which is exactly why every `list_properties` entry
carries a matchName. There is a step for that now.

### The thing the suite caught that the probe had missed

The first version of the 3D step asserted the two trees were *identical*.
Real AE failed it: **AE renames `ADBE Rotate Z` from "Rotation" to "Z
Rotation" when the layer becomes 3D.** The data had been in the probe
output all along, in the tenth of twelve entries, and the assertion was
written off the visible prefix — the harness is what caught it. That is
the loop working; a step that had passed by luck would have been worse.

A second probe then measured the direction the rename runs in, because
guessing had already cost one round:

- 2D layer: `transform/Rotation` resolves, `transform/Z Rotation` refuses.
- 3D layer: **both** resolve, both to `ADBE Rotate Z`.

So AE keeps the old name working after the switch, but a 2D layer has
never heard of the new one. A path written while the layer was 2D
survives becoming 3D; one written while it was 3D does **not** survive
the switch back. The friendly alias (`rotation` -> matchName) never
moves, so the panel's own convenience form is safe either way. Three
steps pin all of it, including the grounded refusal listing the real
children on the way back to 2D. No tool change: the refusal is already
correct and self-correcting.

### What is now covered

- **Light keyframes**, the gap `add_light` shipped with (CAPABILITIES
  named it). Intensity animates through its bare name, Cone Angle only
  through `light/Cone Angle` — the same split the static light steps
  found. Then `remove_keyframes` takes one key off by time and clears the
  rest.
- **A coverage rig** (`AELL Self-Test Cover`, its own comp because it
  resizes and re-times itself): `add_control` (slider + point, both read
  back through `effects/<name>`, which descends to the VALUE property so
  the matchName that comes back is `ADBE Slider Control-0001`), its two
  refusals, `apply_expression_preset` wiring wiggle to that control in
  the inline chained pickwhip form plus both its refusals,
  `add_keyframe` x3 with its no-time refusal, `remove_keyframes` by time
  / by group refusal / cleared, `set_layer_3d` both ways,
  `list_properties` on a group, a leaf and the colliding layer root,
  `list_effects` filtering by name OR category and paging exactly by
  offset, `set_comp_setting` read back through `get_project_info`, and
  `duplicate_comp` -> `rename_item` -> `move_to_folder` with a grounded
  refusal at each end.

### Stubs, so the same bugs are caught without AE

Both halves of the loop got the measurements, not a paraphrase:

- `tests/test-self-test.js`'s canned host learned eleven tools. It reads
  `AELL_CONTROL_TYPES` and the preset list **out of hostscript.jsx**
  rather than carrying a copy, so the day the host's list changes the
  refusal steps cannot pass for free. It models the keyframe store, the
  50 ms nearest-key tolerance, the 2D/3D rename, and comps that remember
  their settings so `set_comp_setting`/`duplicate_comp`/`move_to_folder`
  are read back instead of taken at their word. 260/260 canned.
- `tests/test-property-access.js` gained the tools themselves against the
  real hostscript: `addProperty` now returns a control GROUP whose single
  child is the value, `threeDLayer` is a setter that renames Rotate Z and
  keeps the old name as an alias (the measured asymmetry), and `Comp`
  duplicates. Its new assertions cover add_control, the two presets'
  refusals, the keyframe tolerance both ways, and the rename in both
  directions.

### One real bug, in the measuring tool

`scripts/capability-report.js` matched tool names with `[a-z_]+`, so
**`set_layer_3d` could never be credited with coverage** — the digit
ended the match. It had been sitting in the "never exercised" list while
nothing could ever remove it. Fixed to `[a-z0-9_]+` in both the stub and
the suite counters; it is the only tool with a digit in its name today.

### Left for a human or a later pass

1. **`set_layer_3d` loses the Z in silence.** Turning a 3D layer back to
   2D zeroes the Z of Position and Anchor Point and the tool reports a
   bare `{threeD: false}`. That is AE's behaviour, and a suite step now
   pins it — but this project's rule is that nothing disappears quietly.
   Filed under item 4 with the shape of the fix (report what was
   discarded; do not refuse, do not restore). Deliberately NOT built
   here: this pass's item was coverage, and the loop allows one item.
2. **`organize_project` can never have a suite step.** It files every
   loose item at the project ROOT, and the suite runs inside the user's
   own open project. It needs a `dryRun` argument before it is testable
   at all — a design call, noted in WORKPLAN item 3 and CAPABILITIES.
3. The three other uncovered tools are owned by feature items that will
   cover them as they land (5.4 markers/precompose, 5.5 render queue,
   5.8 import).

### Bumped to 0.9.24 — the assumption, stated

Item 5's "no bump on feature passes" covers new TOOLS; no tool was added
here. But `extension/js/selftest.js` ships, and the panel's Settings ->
"Run self-test" button is the user-visible half of it: without a bump the
46 new steps reach the repo and never reach a panel. Same reasoning as
0.9.23. If the remote session disagrees it folds into 0.10.0 at no cost.

**Harness: 260/260 PASSED.** Stubbed suite: all green, capability doc
regenerated. Nothing blocked.

## 2026-08-28 (local, fifth pass) — item 4: the 3D switch stops taking things quietly (0.9.25)

Harness was green on arrival (260/260), so the pass took the one item 4
bullet that was still open and specified: **`set_layer_3d` loses the Z in
silence.**

### The probe, because the workplan's sketch was only half the loss

A temp `.jsx` set every 3D-only value on a real layer, flipped it to 2D
and read everything back. The workplan said "Z of Position and Anchor
Point, and the 3D-only rotations go with it". Two of the five answers
were not what that implies:

- **Scale Z resets to 100, not to 0.** So "did this die?" is a different
  question per property, and a report that tested everything against zero
  would silently ignore a Scale Z of 70 and wrongly announce a loss for a
  Scale Z of 0.
- **Keyframes survive the switch, but their doomed components are
  flattened in place.** A layer sitting at Z 0 right now can still
  animate to 500 on its next key, and it loses exactly as much. Reading
  only the static value calls that lossless.

Also measured, and all of it confirms the existing steps rather than
changing them: Z Rotation survives (renamed back to "Rotation"),
Orientation / X Rotation / Y Rotation clear to 0, Material Options exists
on a 2D layer too (17 children either way, so nothing to report there),
and turning 3D back ON restores **nothing** — the values are gone, not
stashed.

### The fix

`AELL_3D_ONLY` is the measured table — `[matchName, label, zOnly,
valueAEKeeps]` — and `set_layer_3d` walks it BEFORE the write, because
afterwards there is nothing left to read. What it finds comes back as
`discarded`, the same shape as `scale_comp`'s `layersSkipped`, plus a
note saying the switch back does not undo it. It does **not** refuse and
does **not** restore: the user asked for 2D. A 2D layer switched to 2D
again reports nothing, and so does every 2D -> 3D call.

### The ordering trap, caught by the harness and not by the probe

The first version read `expressionEnabled` before `numKeys`. Real AE
failed the new step: `ST Cov Box` still carries the coverage rig's wiggle
on Position, so the report named the wiggle's own noise —
`Position Z (expression-driven, currently -27.26)` — and never mentioned
the 500 sitting on the next keyframe. Keyframes are now read first: the
expression decides what renders, the keyframe values are the stored data
AE flattens, and those are the concrete thing to name. The
expression wording survives for the no-keyframes case, where it is the
only honest number available.

### Covered without AE, at both levels

- **`tests/test-property-access.js`** (real hostscript, stubbed AE): the
  stub's Transform values are now PADDED to three components like the
  real scripting API, its `threeDLayer` setter performs the measured
  flatten (values and keyframes, Scale against 100), and `Prop` grew a
  real `expressionEnabled`. New assertions cover the four-way report,
  keyframes-beat-expression, Scale Z counted against 100, the
  expression-only wording, "turning 3D back on restores nothing", and two
  no-op switches that must claim no loss.
- **`tests/test-self-test.js`**: the canned host models the discard
  report and a `set_property` for X Rotation. It also needed
  `resetCoverRig()` — the suite gets a FRESH scratch comp on every real
  run, but the canned stores persisted between the three in-process runs,
  and the Position keyframes left by the new steps made the NEXT run's
  expression read answer with a key list. That was stub state leaking,
  not a product bug, but it would have hidden real ones.

### Bumped to 0.9.25

A fix to shipped behaviour of an existing tool, verified in real AE —
exactly the patch case. `tools.js` documents the destruction and the
`discarded` field so the model can warn before it flips the switch, and
the CAPABILITIES gap entry is now a description of the behaviour instead
of a queued warning.

**Harness: 262/262 PASSED** (260 -> 262: three steps added, one silent
-loss step rewritten into a receipt check). Stubbed suite: all green,
capability doc regenerated. Nothing blocked.

## 2026-08-28 (local, sixth pass) — item 2 follow-up: a resized comp owes its lights pixels (0.9.26)

Harness was green on arrival (262/262), so the pass took the older of the
two follow-ups item 2 left behind and never struck: **`scale_comp` does
not scale a LIGHT's pixel-valued options.**

### The probe, which cost four rounds and found more than the item asked

Probes 5-9 (`logs/probe-light5..9.jsx`). What came back:

- **The gate is type + falloff, and only a WRITE reveals it.** Every
  Light Options property is PRESENT on every light type — an ambient
  light happily reports `radius=500` — and a hidden one still says
  `elided=false, enabled=true`. Measured writability:
  Radius on parallel/spot/point while Falloff is smooth(2) or
  inverseSquareClamped(3); Falloff Distance on the same three but
  smooth ONLY; Shadow Diffusion on spot/point, any falloff, shadows on or
  off. Everything else there is a percent, an angle or a colour.
- **Falloff Type is itself keyframeable**, and the gate follows the value
  UNDER THE PLAYHEAD: with keys none@0 -> smooth@2s and the playhead at
  0, writing Radius throws even though the light really does use a radius
  later. So a keyed falloff can leave a genuinely-live pixel value at the
  old comp's scale, and that has to be REPORTED, not swallowed.
- **Light Options are not inherited from a parent.** Same asymmetry as
  camera Zoom: the parented light's transform comes from its parent and
  its 300px falloff radius does not.
- **What the tool did before:** nothing. A halved 1000x1000 comp left
  Spot at radius 300 / distance 400 / diffusion 60, keys included.

Two AE lies the probe caught that the item never mentioned:

- **An ambient light was reported as a FAILURE.** AE hides its Position,
  so the unconditional write threw and the light landed in
  `layersSkipped` — "1 layer(s) could NOT be scaled" over a light where
  there was never anything to do.
- **A point light reports `autoOrient` 4214** (CAMERA_OR_POINT_OF_
  INTEREST), exactly like a two-node spot, and then refuses the Point of
  Interest write. The existing code trusted that flag. An unparented
  point light would therefore throw AFTER its Position had been written
  and be reported as unscalable — latent, because both earlier probes
  happened to parent their point light and take the other branch.

### The fix

`AELL_LIGHT_PIXEL_OPTS` is the measured table, and `AELL_relight` runs on
BOTH loop branches (parented and not), exactly where `AELL_rezoom`
already does. It touches only what the light's type and falloff put in
play, skips a static zero (0 scales to 0 — no write, no claim), and
reports:

- `lightOptionsRescaled` — per light, which options moved;
- `lightOptionsNotScaled` — a refusal with its reason, including the
  playhead advice when Falloff is keyed, and expression-driven options
  named as such rather than folded into the transform warning;
- `layersWithNothingToScale` — ambient/environment lights, so the counts
  do not look short and a no-op stops reading as a failure.

The Point of Interest write is now gated on the light TYPE as well as
autoOrient, since the flag lies.

Verified in real AE (probe 8): a 1000x1000 comp halved took Spot to
150/200/30 and its keys 300/600 to 150/300, Point's Radius to 100 while
its HIDDEN Falloff Distance stayed 500, the falloff-none spot moved only
its shadow blur, the parented light was rescaled anyway, cone angle /
feather / intensity did not move, and scaling back by 2 restored every
original number.

### Covered without AE

- **`tests/test-scale-comp.js`**: a `Light` stub whose hidden-ness is a
  live getter over the measured matrix (including the falloff under the
  playhead), nine lights covering every branch, and stub-fidelity checks
  that the ambient Position, the point light's POI and a falloff-none
  Radius really do refuse writes.
- **`tests/test-self-test.js`**: the canned host now MUTATES its lights
  in `scale_comp` (so a read can only confirm a write that happened),
  carries AE's real defaults for options the caller omitted, tracks
  parenting, and filters `get_comp_details` lights by comp — without that
  last one the camera comp's lights leaked into a refusal step that
  counts them.

### Bumped to 0.9.26

A fix to shipped behaviour of an existing tool, verified in real AE.
`tools.js` documents the rescale and both new result fields; the
CAPABILITIES gap entry is now a description instead of a queue item.

**Harness: 277/277 PASSED** (262 -> 277: four lights added to the camera
comp plus ten assertions, one existing step taught the new counts).
Nothing blocked.

**One trap for the next pass, cheap to relearn the hard way:** in a probe
`.jsx`, `"text " + prop.value` on a 3-vector throws *"invalid numeric
result (divide by zero?)"* — the implicit Array coercion, not AE state.
Wrap it in `String()` or index it. Two probe rounds died on that, and the
first left AE sitting on a modal that swallowed the next `-r` launch
silently.
## 2026-08-28 (local, seventh pass) - item 2 follow-up: a bare property name finds its own way down (0.9.27)

Harness green on arrival (277/277), so the pass took the LAST unstruck
follow-up item 2 left behind: **`get_property` could not reach a light's
`Radius` or `Falloff Distance` by bare name.**

### The probe, which found the gap is much wider than lights

Probes 1-3 (`logs/probe-path{1,2,3}.jsx`). What came back:

- **AE's layer-level name shortcut is a fixed list with an arbitrary
  edge.** Measured name by name on a spot light: Intensity, Color, Cone
  Angle, Cone Feather, Casts Shadows, Shadow Darkness and Shadow
  Diffusion all resolve from the layer; `Falloff`, `Radius` and `Falloff
  Distance` return NULL - and all fourteen live in the SAME group. The
  three it misses are exactly the options AE added with falloff. A
  camera answers every one of its options (Zoom, Focus Distance,
  Aperture, Blur Level, Depth of Field, Iris Shape). A solid answers
  Accepts Lights and Casts Shadows but NOT its own effect's
  `Blurriness`. A shape layer answers `Contents` but not `Group 1`,
  `Rectangle Path 1` or `Size`. So this was never a light bug: any
  nested parameter is unreachable by name, which is most of them.
- **Layer Styles are the trap under any naive search.** EVERY layer
  carries all eleven whether or not one was ever applied, and each
  reports `enabled=false, active=false, canSetEnabled=false,
  elided=false` either way - there is no flag separating an applied
  style from a latent one. On a plain solid that is ten extra
  "Opacity"s, seven "Color"s and seven "Size"s at depth 3, while a
  shape's real `Size` sits at depth 5. Shallowest-wins would have
  answered from a style nobody added.
- **The walk is free.** Depth-5 over the heaviest layer: 219 nodes in
  6-11 ms; 50 deep-searched `get_property` calls measured 179 ms total
  (3.6 ms each). No caching or opt-in flag was warranted.

### The fix

`AELL_deepFindProp` walks the layer's tree to depth 5 and ranks matches
by ROOT first (Transform 1, Light/Camera Options 2, Material/Geometry 3,
Text 4, Effects 5, Contents 6, Masks 7, Audio/Time Remap 8, anything
unknown 50, **Layer Styles 99**) and only then by depth. It matches
display name OR matchName, case-insensitively. It runs only after the
friendly name and the '/'-path both fail, so nothing that resolved
before resolves differently now.

- **A tie is refused, never guessed**: two matches of equal rank AND
  equal depth come back as a grounded refusal naming both real paths.
  Verified in the field with two Gaussian Blurs on one layer (AE names
  the second "Gaussian Blur 2"), read AND write.
- **The result names what it hunted for**: `resolvedPath` on
  `get_property`/`set_property`, plus `alsoMatched` (up to 3) for the
  lower-ranked namesakes, so the model learns the addressable path
  instead of leaning on the search forever. A name that resolved the
  ordinary way reports neither - the field only appears when a hunt
  really happened.
- **The path form got the same treatment**: a '/'-path whose FIRST
  segment the layer cannot see ("Gaussian Blur/Blurriness",
  "ST Cov Pt/Point") deep-finds the head and walks the rest from there.
- **A miss stays grounded**: the old "children here" error survives and
  grows a line saying the whole tree was searched too, plus the real
  names that CONTAIN what was asked for ("Diffusion" -> "Light
  Options/Shadow Diffusion").
- One subtlety the suite caught: a bare control name lands on the
  control GROUP and `descendToLeaf` then hands back the value inside it,
  so `AELL_descendReported` appends the leaf - otherwise `resolvedPath`
  would have handed the model a path that reads back as a GROUP refusal.

### Covered without AE

- **`tests/test-property-access.js`**: the stub Layer now models AE's
  measured shortcut table name for name (it is the difference between
  testing the search and testing nothing), plus a light with all 14
  Light Options, a shape whose `Size` is five levels down, and the
  eleven latent Layer Styles. Fourteen new assertions incl. stub-fidelity
  checks that Radius/Blurriness/Size really do refuse the layer-level
  lookup and that an unapplied style is indistinguishable from an
  applied one.
- **`tests/test-self-test.js`**: the canned host learned the same line
  (`LIGHT_DEEP_ONLY`), stacks effects so a second Gaussian Blur really
  is ambiguous, MUTATES the light when a write comes through the search,
  and carries AE 2026's real Gaussian Blur default.

### Bumped to 0.9.27

A fix to shipped behaviour of two existing tools, verified in real AE.
`tools.js` tells the model bare names work and that ties are refused;
the CAPABILITIES gap entry became a description, and the curated half
gained a section on finding a property when the name is all you have.

**Harness: 289/289 PASSED** (277 -> 289: six light steps, seven coverage
steps). The real AE run also earned its keep - it failed the first
attempt on `...and an ambiguous WRITE changes nothing`, because a freshly
applied Gaussian Blur in AE 2026 comes up at **Blurriness 25, not 0**.
The step now reads both params before and after instead of assuming a
default, which is what it should have done anyway. Nothing blocked.

**One trap for the next pass:** `add_text_layer` names the layer after
its TEXT, not the `name` argument (probe 1 asked for "Txt" and got "Hi",
then died on `null is not an object` two steps later). Resolve a text
layer with `instanceof TextLayer`, or pass the text as the name.

## 2026-08-28 (local, eighth pass) - item 4: the checklist finally asks for a picture (0.9.28)

Harness green on arrival (289/289), so the pass took item 4's last
unstruck bullet: **the chat probe never touched ComfyUI.** The other two
halves of that bullet (undo across a mixed round, a second turn that
refers back) have been steps 9-11 since 2026-08-25; only the generator
was missing.

### What was built

Two steps, and the plumbing a PANEL-side verdict needs:

- **Step 12 "the image generator answers when asked"** - one round, no
  GPU. It fails if the model answers about ComfyUI without asking it
  anything, if every comfy_* call errors, if the backend is offline, if
  the workflow list is empty, or if the reply tells the user to launch
  ComfyUI by hand (the tool doc promises it boots itself).
- **Step 13 "generate a picture and bring it in"** - the only thing in
  the project that runs a real generation THROUGH THE MODEL.
  comfy-probe.js drives the same backend directly; what it cannot say is
  whether a sentence a user would type ever reaches it.
- Verdicts can now read `ctx.tools` and `ctx.replies`, because a
  panel-side tool leaves NOTHING in the comp to read back. `READ_COMP`
  grew every file-backed footage item in the project (id, path, dims)
  and each layer's `sourceFile`, so "the render reached the project" is
  measured in AE and not taken from the tool's own word for it.
- The generation cleanup removes what the probe imported BY ITEM ID,
  never by folder: the output dir is the panel's, and the user's own
  generations live there too. The rendered file is left on disk and
  named in the transcript.

### Three defects, all found on the first run, all fixed at the root

1. **The probe never loaded comfy.js or setup.js.** tools.js dispatches
   every comfy_* tool through `global.Comfy` and every VRAM handoff
   through `global.Setup`, so a generation would have thrown a
   ReferenceError inside the dispatcher rather than answering. Fixed,
   and generalised into an anti-drift test: for every `global.X` tools.js
   reaches for, the probe must load X's panel file. The probe also now
   calls `Setup.ensureDataDirs()` the way main.js does on every panel
   load - see defect 3's twin below.
2. **A dead comfyUrl told the user to install a backend they already had
   running.** The setting said 127.0.0.1:8000; a ComfyUI was answering on
   8188 the whole time; the panel said "install the hidden backend in
   Settings", and the model relayed that dead end. `Comfy.status` and
   `Comfy.ensureRunning` now probe the two well-known local ports AFTER
   the configured URL fails and name what they find: "Nothing is
   listening at 127.0.0.1:8000, but a ComfyUI IS answering at
   127.0.0.1:8188. Set the ComfyUI URL in Settings to
   http://127.0.0.1:8188". It REPORTS and never reroutes - rendering on a
   ComfyUI the user did not configure would swap the model set under
   them. Localhost only, and only after the configured URL has failed
   (pinned: a URL that answers is never followed by a port scan).
3. **The panel offered `example-txt2img` as a real workflow.** It is the
   FORMAT example this project ships; its checkpoint is the literal
   `CHANGE-ME.safetensors`. Asked for a picture, the model picked the one
   whose name says txt2img and ComfyUI threw it out on validation.
   `Comfy.listWorkflows` now flags any template still holding the
   placeholder; comfy_list_workflows does not offer it, comfy_generate
   never defaults to it, and naming it outright is refused with what it
   IS plus the templates that would work - a grounded refusal instead of
   a validator dump paid for with a round trip.

### The field run, after the fixes

Step 12 pass. Step 13 pass, and worth reading in full: the model invented
a workflow called `simple_image`, took the grounded "Available:
AE_LLAMA_H3_I2V_V1, AE_LLAMA_KREA2_V1" error, re-planned onto KREA2, and
rendered `2026-08-28_CRPTK-KREA2__00003_.png` at 3072x1728 in ~35 s,
imported into the project. The arbiter paused the 32B chat model for the
generation and warmed it back up afterwards, unprompted.

### Covered without AE

- `tests/test-comfy-workflow-choice.js` (NEW): the placeholder rule, from
  the flag through both tools, including the empty-except-the-example dir
  and the proof that nothing is queued at ComfyUI for a refusal.
- `tests/test-comfy-backend.js`: six async cases over a stubbed http for
  the discovery fix - found, not found, live URL never scanned, 8188
  before 8189, the generation path, and a dead REMOTE url.
- `tests/test-chat-probe.js`: every stage of both new verdicts with the
  near-miss that skips it (ok:true and no files, a zero-byte render, a
  file on disk that never reached the project, AE's fsName casing vs
  Node's path), plus the module anti-drift check above.
- One test-quality fix on the way: the "anything named in an ExtendScript
  string must be on $.global" check parsed string literals with a regex,
  so ONE apostrophe in a prose comment ("ComfyUI's validator") re-paired
  every quote after it and it started reading code as string contents. It
  strips comments with a real scanner now. The failure it produced was a
  comment, not a promise - exactly what its own header says it must
  ignore.

### NEEDS A HUMAN EYE

- **MACHINE STATE CHANGED (owner's AE machine):** `comfyUrl` in
  `%APPDATA%\AE-Llama\settings.json` was `http://127.0.0.1:8000`, where
  nothing listens; the owner's ComfyUI answers on 8188. I changed it to
  `http://127.0.0.1:8188` so the generation path could be verified end to
  end, and kept the previous file as `settings.json.bak-20260828`. If
  8000 was deliberate, change it back in Settings - the panel will now
  TELL you where the running one is instead of sending you to install a
  backend.
- **The seeded workflow dir was three versions stale.** KREA2 shipped in
  0.9.23 and was still absent from this machine at 0.9.27, because
  `ensureDataDirs` only copies files the data dir does not already have.
  The probe seeds now (it calls ensureDataDirs like the panel), but an
  installed panel that has already seeded will never receive an UPDATED
  template. Filed under item 4; the fix needs a version-stamped or
  hash-compared seed and is a design call.
- **The model said "imported it into 'Probe Room'" when the file only
  reached the project.** No tool places a footage item into a comp -
  import_file takes a path and nothing else - which is workplan 5.8. The
  step reports that gap as an info line rather than failing on it, and
  the transcript shows the model overstating what it did.
- **A round that mixes a failed PANEL tool with a successful host tool is
  not rolled back.** comfy_generate failed, add_solid succeeded in the
  same round, and a stray "White Plate" solid survived: the host's
  rollback only spans the batched HOST run, and the panel-side failure
  never enters it. Not touched tonight - the rollback design belongs to
  the remote session.

**Harness: 289/289 PASSED** (unchanged - this pass added no suite steps;
its subject is the probe, which is not part of the AE suite). Stubbed
suite: 35 files green, capability doc regenerated (its stale "260-step"
line now reads 289). Chat probe steps 1, 12, 13: 3/3.

**One trap for the next pass:** the chat probe's steps are a
CONVERSATION, and steps 12-13 assume "Probe Room" exists - run them as
`--steps 1,12,13`, never alone, or every verdict reads a comp that is not
there.

## 2026-08-28 (local, eighth pass) - item 4: the tool results the model reads were cut mid-object (0.9.29)

Harness green on arrival (289/289), so the pass took item 4's last
unstruck bullet: **performance at 200 layers, the batch-keyframe half.**
The wall times were fine, as they were on 2026-08-21. The follow-up that
bullet had been carrying since then was not.

### The measurement the bullet asked for

200 solids, AE 2026, one run each: set_keyframes (600 keys) 167 ms,
apply_keyframe_ease 291 ms, remove_keyframes 517 ms, grid_layout 872 ms,
stagger_layers 53 ms, distribute_property 69 ms, reorder_layers 59 ms,
scale_comp 352 ms, for_each_layer apply_effect 313 ms, set_layer_parent
35 ms, duplicate_layer x100 128 ms, building the 200 solids 704 ms.
Nothing within an order of magnitude of the ~5s flag. That half is
closed and the bullet is struck.

### What the same probe found, which is the real subject of this entry

The 2026-08-21 pass filed one thing FOR THE REMOTE SESSION and it was
never picked up: the write tools echo a row per layer against
`compactToolResults`' 1200-byte per-result cap. Re-measured, it is not
three tools and it is not mainly about echoes. **Eleven** of the tools
the model leans on hardest serialize past that cap, and `slice(0, 1200)`
handed EVERY one of them to the model as JSON cut mid-object - no closing
brace, and no count of what went missing:

    get_comp_details     7305   (already row-capped at 40 by the HOST)
    stagger_layers       7262
    grid_layout          7258
    distribute_property  6529
    list_properties      5648
    scale_comp           3577
    list_effects         3514
    get_project_info     3207   (already row-capped at 40 by the HOST)
    distribute_property  2286   (the overriddenByExpression path)
    set_layer_parent     1589
    audit_comp_usage     1442
    rename_comps         1339

The two entries marked HOST are the ones worth sitting with. The
2026-08-21 pass bounded exactly those two tools host-side so the model
would stop drowning - and the host's 40-row cap and the panel's
1200-byte cap were never reconciled with each other, so forty rows the
host went to the trouble of selecting (SELECTED layers first, the active
comp never dropped) arrived as six and a fragment. The system prompt
tells the model to read `selected: true` out of get_comp_details to
resolve "these layers"; on any comp past ~10 layers, calling that tool
returned something it could not parse.

### The fix, at the panel, and why not at the host

`compactToolResults` moved from a closure inside main.js's chat path into
tools.js (the same move `fetchProjectState` made on 2026-08-21, for the
same reason - it is now testable without a panel) and follows the rule
`budgetState` already followed: NOTHING IS BYTE-SLICED.

- Oversized results are shrunk STRUCTURALLY - whole rows off the END of
  whichever array currently costs the most, because these lists are
  ordered and the head is the informative part. What is sent is always
  parseable JSON.
- Every shortened list reports itself: `truncated: "placed: 159 of 200
  shown (dropped to fit the model's context, NOT by the tool - narrow
  the request or page for the rest)"`. The wording is deliberate; a bare
  count reads like a tool that half-worked.
- The per-result cap is a FAIR SHARE of the round's 6000, not a fixed
  1200. Results that come in under their share donate what they did not
  use, repeatedly, so one big read is not punished for the company it
  keeps: a get_comp_details sharing a round with two 90-byte
  acknowledgements now gets ~5900 bytes instead of 1200.
- No arrays to drop from (one enormous error string) shortens the
  longest STRING instead, which still leaves valid JSON. The byte-slice
  survives only as an unreachable last resort.
- The caller's objects are never mutated - the shrink runs on a copy, so
  the transcript the USER sees keeps every row.

Deliberately NOT fixed by capping the tools themselves: bounding each
tool to fit 1200 bytes would have cut get_comp_details to about six
layers, and the host cap is where the model's real needs are known (it
keeps selected layers). The defect was the byte slice, so the byte slice
is what changed. One generic fix also covers the eleventh tool and the
twelfth, which per-tool caps never would.

### Two things found on the way

- **The note is what put the result back over the cap.** The first cut
  wrote `truncated` after the drop loop finished, so the annotated result
  was over budget again and the final slice cut it mid-object - the exact
  bug, reintroduced by the fix for it. The note is written and measured
  INSIDE the loop now, and the test asserts parseability, not row counts.
- **chat-probe.js held its own copy of the byte-slicer.** The probe is
  the only thing that tests the model's half, and it would have gone on
  measuring the old behavior. tests/test-chat-probe.js's anti-drift check
  ("the probe uses every Tools helper main.js's chat path does") caught
  it within a minute of the export existing. The probe delegates now.

### Verified in real AE, twice

- `logs/probe-echo3.jsx` captured the ten results above VERBATIM from a
  real 200-layer comp and fed them through the real tools.js in Node:
  all ten unparseable under the old cap, all ten valid now, and all ten
  together in one round come to 5760 bytes of valid JSON.
- `node scripts/chat-probe.js --steps 1,2,3` - real settings, real
  llama-server, real tools.js, real AE - 3/3 steps met their verdict, so
  the live product path still works with the new budgeter in it.
- Harness: **289/289 PASSED** (unchanged; this is panel-side, and the AE
  suite does not run the panel's chat path). Stubbed suite: 36 files
  green, capability doc regenerated.

### Covered without AE

`tests/test-tool-result-budget.js` (NEW, 49 assertions), sibling of
test-context-budget.js and carrying the field byte counts in its header.
It asserts the bug ITSELF - that the old 1200-byte slice of a real
grid_layout result does not parse - so the assertion fails if anyone
"fixes" it back. Plus: valid JSON for every shape, the head of the list
surviving, the count being reported, the caller's object untouched, fair
sharing (and that a solo result never does worse than a shared one), the
total holding at 1/2/3/8/20 oversized results in one round, two long
lists in one result, a result with no arrays at all, and the real
hostscript's 40-row get_comp_details run through the budgeter end to end.
The anti-drift half asserts main.js no longer contains either slice.

### Bumped to 0.9.29 - the assumption, stated

This fixes shipped behavior verified against real AE bytes, so it is a
patch bump by the standing local rule. The judgment call worth naming:
the 2026-08-21 log handed this to the remote session ("wants a deliberate
pass rather than a ride-along"). It sat for a week while every affected
tool kept handing the model fragments, and the workplan bullet it lived
under is a local one. I took it as that deliberate pass rather than
leaving it for another week. Nothing about the ROLLBACK design was
touched - that is still remote's.

### Left for a human or a later pass

- **The 6000-byte round budget is unchanged and unmeasured.** It is
  inherited from the old code, and it is now the only limit doing any
  work. Whether 6000 is right for a 32B model with a large context is a
  question nobody has asked in the field; if it is raised, the fair-share
  split is already the mechanism.
- **`for_each_layer` stops after 5 failures and says so, but the failure
  text is unbounded** (530 bytes for 5 short ones). It fits today because
  the count is capped, not because the text is.
- The next pass starts at item 5 (feature track, probe first) - item 4
  now has nothing local left. Its two remaining bullets are both design
  calls already filed for the remote session: the version-stamped
  workflow seed, and rollback across a mixed panel/host round.

## 2026-08-28 (local, ninth pass) - item 5.4: precompose and add_marker stop taking things quietly (0.9.30)

Harness green on arrival (289/289), so the pass took the highest item
that could still move. Item 4's two remaining bullets could not: the
seeded-workflow-staleness one is explicitly a design call for the remote
session, and "a generation that fails does not get retried" is answered
by the entry that filed it - 0.9.28's own field run has the model invent
`simple_image`, take the grounded error, re-plan onto KREA2 and render.
Struck it with that citation rather than spending a pass re-running it.
So: **5.4, precompose + markers - the tools ALREADY EXIST; verify and
cover.**

### Three probes, and what AE actually does

Nothing below was assumed. Probe 1 measured the two tools cold, probe 2
chased the questions probe 1 opened, probe 3 verified every fix.

**precompose**

- `precompose(indices, name, false)` THROWS for more than one layer:
  "Can not set moveAllAttributes to false when calling precompose with
  more than one layer." The tool leaked that verbatim.
- AE tolerates a REPEATED index. `[2, 2]` moves ONE layer; the tool
  reported `layersMoved: 2`, which was simply untrue.
- It DESTROYS the layers it moves. A reference held across the call
  throws "Object is invalid" on the next read - AE builds fresh layers
  inside the precomp rather than moving the objects. This is measured,
  not inferred: the first cut of the selection restore held the old
  objects and died on exactly that, in the field, on five cases.
- Parenting loses something in ONE direction only. A moved layer whose
  parent stayed behind has its parent set to null, silently. The reverse
  (a layer left behind whose parent moved IN) is re-pointed by AE at the
  new precomp layer, and a parent/child pair moved together keeps its
  link. So only the first case needed reporting; the other two would
  have been noise.
- **The one that surprised me:** with moveAllAttributes TRUE, an
  expression on a layer left behind that names a moved layer is NOT
  rewritten and NOT flagged. `thisComp.layer("INSIDE").transform.opacity`
  still says "INSIDE" after INSIDE has gone into the precomp, and
  `expressionError` reads EMPTY. With moveAllAttributes FALSE, AE DOES
  rewrite it, to the new precomp layer. Exactly backwards from what you
  would guess, and the true case is the default.
- AE lets a SECOND project item take the requested name. Two comps named
  "PRE8" both existed after one call, and `AELL_resolveComp` returns the
  first match - so the comp the tool had just made was unreachable by the
  name it reported. The system prompt already tells the model to "take
  the name from the tool RESULT" after precompose; the tool was the one
  not holding up its end.
- It selects the new precomp layer and deselects everything else.
- moveAttributes:false sizes the new comp to that ONE LAYER's source
  (200x100), not to the comp (640x480), and leaves the transform outside.
- The new precomp layer lands at the topmost moved layer's slot, and
  in/out points and startTime survive inside the precomp. Both correct;
  nothing to do.

**add_marker**

- A marker written at a time that already has one REPLACES it - comment,
  duration and all - and `setValueAtTime` says nothing. `numKeys` stays
  put. Same for comp and layer markers.
- Marker times are COMPOSITION time on a layer too. Measured directly:
  keyTime read 3, then 5 after the layer's startTime moved to 2. So
  there was nothing to convert - the tool was already right, and the doc
  simply never said which time space it meant.
- Times are NOT snapped to frames. 1.2345 stored as 1.23449707, and a
  marker 0.0001s from another is a SECOND marker on the same frame.
- AE accepts a marker at -1s, or at 99s in a 10s comp, with no complaint.
- `{"duration": -3}` was silently ignored (the `args.duration > 0`
  guard), and `{"time": "4"}` was refused outright - against this
  codebase's own rule, written into `AELL_numArg`, that a small model's
  quoted number is accepted rather than dropped.
- `MarkerValue` in AE 2026 carries comment, chapter, url, frameTarget,
  cuePointName, duration, label, protectedRegion. Markers read back
  through `get_property`/`list_properties` as "[object]" with a key
  count - enough to prove a marker landed, not enough to read it. Left
  alone: a marker reader is a NEW tool and 5.4 says do not build one.

### What changed

Every one of those silences now comes back in the result, in the shape
`scale_comp` and `set_layer_3d` already use - `duplicatesIgnored`,
`parentsBroken`, `expressionsAtRisk`, `selectionKept`, `replaced` - and
the two refusals are grounded:

- precompose refuses `moveAttributes:false` for several layers in the
  panel's own words, naming the layers and the way out.
- It de-duplicates the layer list and counts LAYERS, not references.
- It restores the user's selection minus whatever went in, matching on
  `Layer.id` captured BEFORE the call. When nothing survived it leaves
  AE's new layer selected and says so rather than pretending.
- It auto-numbers a taken name through `AELL_uniqueItemName` and
  registers the same request-scoped `AELL_compAliases` redirect
  create_comp does, so the rest of the batch still reaches the comp.
- The expression scan runs only for moveAttributes TRUE (FALSE is the
  case AE fixes itself), walks only the layers left behind, and caps at
  eight. Cost is the known expression-walk rate, ~133 ms per 100 layers.
- add_marker takes a quoted `time` and `duration`, refuses a duration
  that is not a number >= 0 quoting what arrived, names the marker it
  overwrote, and flags a marker placed outside the comp - or outside the
  layer's own span, where it rides the layer into invisibility.

### Covered without AE, and in AE

- `tests/test-precompose-markers.js` (NEW): 56 checks over a stub whose
  precompose reproduces all eight measured quirks, including the
  "Object is invalid" throw - which is what makes the held-reference bug
  fail in Node instead of only in After Effects.
- 18 suite steps in `extension/js/selftest.js` on their own rig comp
  (precompose CREATES project items, so it cannot share one), including
  both halves of the selection report: the first precompose has nothing
  to keep, and its new layer is then the selection the second one has to
  put back. `tests/test-self-test.js`'s canned host grew a faithful
  precompose and add_marker for the same reason - a host that just said
  "ok" would let a silent precompose pass its own steps.
- docs/CAPABILITIES.md regenerated; both tools leave the uncovered list.

**Harness: 307/307 PASSED** (289 -> 307). Stubbed suite: 37 files green.

### The trap this pass cost an hour to, written down so the next one does not

**A probe must NOT wrap `AELL_call` in its own `app.beginUndoGroup`.**
AELL_call opens and closes its own undo groups; nesting the probe's group
around it leaves AE's group counter unbalanced for the rest of the
SESSION. Nothing goes wrong until something issues an Undo - and the
suite's rollback step does exactly that, so the next three harness runs
died at breadcrumb 171 behind an "After Effects warning: Undo group..."
modal whose text Win32 cannot read (AE draws it in an
OS_EditTextContainer that reports no string, so the harness could only
call it "unreadable"). The harness's own pre-launch dismissal did not
help: this dialog is raised DURING the run, not left over from the last
one. Dismissed with a posted WM_CLOSE, and the very next run was green.
All three probe scripts in this pass did it; future ones should let the
tools manage their own undo groups and bracket only RAW AE calls.

### NEEDS A HUMAN EYE

- **The AE project on this machine has 260 items and no comps** - 234
  "Null N" footage items, a dozen "AELL Probe *" folders from earlier
  passes, five generated mp4s and a handful of stray solids. The suite
  cleans up its own "ST " namespace and nothing else, correctly. Nobody
  has ever cleaned up the rest; it is only cosmetic, but it makes the
  Project panel useless to look at while working.
- **`duplicate_comp` has the same name bug precompose just lost**: it
  does `dup.name = args.name` with no uniquing and no alias, so two comps
  can end up sharing a name and the second is unreachable by name. Same
  one-line shape as the fix above. Not touched - it is outside 5.4, and
  filing it beats smuggling it.
- **There is still no way to READ a marker's comment or duration.** Both
  come back as "[object]". Fine for now; if markers ever become something
  the model reasons about rather than places, that is a new tool and the
  remote session's call.

## 2026-08-28 (local, tenth pass) - item 5.1: text animators, and the hundred properties that were always there

Harness green on arrival (307/307), so the pass took the highest item
that could still move. Items 1-4 are closed (item 4's two survivors are a
remote design call and an already-struck bullet), so: **5.1, text
animators - the highest-value item on the feature track.** Probed, built
and covered in one pass, because the probe answered every open question
in seven runs and nothing it found forced a redesign.

### What AE actually does (eight measurements, none of them assumed)

**The animator tree is not empty and never was.**
`animator.property("ADBE Text Animator Properties").numProperties` is
**103 on a brand-new animator** - the whole 3D-text Front/Bevel/Side/Back
material set (four blocks of sixteen), eight nameless
`ADBE Text VF Axis N` variable-font slots, and the twenty-nine ordinary
animator properties. `addProperty` does not CREATE one; it un-hides it.
Calling it twice is not an error and the count never moves. So counting
proves nothing, and enumerating the group hands back a hundred things
nobody asked for.

**Only one flag knows which were added.** `enabled` (true), `elided`
(false) and `active` (true) read IDENTICALLY for a dormant slot and an
added one - the same lie Layer Styles told the 0.9.27 pass.
`canSetExpression` is the one that differs: false while hidden, true once
added. Everything downstream in this entry rests on that single boolean.

**A hidden slot answers reads and refuses writes.** `prop.value` works
and returns a number the render never uses; `setValue` /
`setValueAtTime` / `expression =` all throw AE's "Can not "set value"
with this property, because the property or a parent property is
hidden." `remove()` puts a property back to hidden and KEEPS its value -
set 33, remove, re-add, and 33 is still there.

**Adding a sibling animator invalidates every reference into the earlier
ones.** Held `a1`, its Properties group and its selector all threw
"Object is invalid" after a second `anims.addProperty`. The Animators
group itself, the Text group and the layer stay valid, and re-fetching
`anims.property(1)` gives a working object again - so it is the
REFERENCE that dies, not the property. Adding a selector or a property
does not invalidate anything.

**AE lets two animators share a name**, and `anims.property("Twin")`
answers with the FIRST - the later one is unreachable by name. Setting a
name to "" is silently ignored. Same trap precompose lost in 0.9.30, and
`duplicate_comp` still has (filed 2026-08-28, still open).

**A range selector carries BOTH triples at once**: Percent Start/End/
Offset and Index Start/End/Offset, with the same three display names.
`sel.property("Start")` returns the PERCENT one even when Units is set to
index (2). Percent values run **-100..100** - 101 throws with the range
in the message; index values take -5 and 3 alike. Advanced measured:
Units 1-2, Based On 1-4, Mode 1-6, Shape 1-6, Smoothness 0-100, Ease
High/Low -100..100, Amount -100..100.

**Per-character 3D is a LAYER switch with a tail.** `threeDPerChar = true`
also turns `threeDLayer` true, and setting it back to false leaves the
layer 3D. On a non-text layer it throws a properly grounded AE error.
X/Y Rotation exist and are addable WITHOUT it - they simply never
render - which is exactly the silent no-op this project does not ship.

**"ADBE Text Rotation" IS the Z rotation.** `ADBE Text Rotation Z` is
refused by `canAddProperty` in both modes. Two more name/matchName
disagreements worth writing down: "Tracking Type" is
`ADBE Text Track Type` (not `...Tracking Type`), and the property AE
calls "Character Value" is `ADBE Text Character Replace`.

### What got built

`add_text_animator {layer, name?, properties: {...}, selector?}` - one
call, because an animator without properties and a selector is not
anything a user asked for. It validates the WHOLE request before touching
the layer (an unknown property, a bad enum, a percent outside -100..100
and start/end on a wiggly selector are all refused with nothing built),
then adds the animator, re-reaches it BY INDEX (the reference trap),
auto-numbers a name AE would have stranded and says so, activates each
property before writing it, and configures the selector - Units FIRST,
since it decides which triple start/end/offset mean.

It does NOT keyframe. The probe found the existing tools already reach
into animators and selectors by slash path, so `set_keyframes` on
`.../Selectors/Range Selector 1/Offset` was already the right answer; the
result therefore carries the exact paths and an `animateHint` naming that
call. A typewriter is opacity 0 + units index + keyframed Start, and it
is a PROMPT recipe as the workplan wanted, not a second tool.

`perCharacter3D` comes back whenever xRotation/yRotation (or a Z in
position/anchorPoint, or a Scale Z off 100) forced the switch on, naming
the layer that just became 3D and saying AE does not undo that.

### The shipped bug the probe fell over

`set_property {property: "Skew"}` on any text layer with an animator was
answering with AE's raw "the property or a parent property is hidden" -
because 0.9.27's deep search reaches the hundred dormant slots and
happily lands on one. `get_property "Blur"` was worse: it returned a
value and a resolvedPath, with nothing to say the render ignores it. Now:
the deep search ranks dormant matches LAST and refuses when they are all
there is, naming the path and the tool that activates it; set_property
and set_keyframes refuse an explicit path into a hidden slot the same
way; get_property still READS one (inspection is legitimate) but carries
an `inactive` sentence; and list_properties marks those rows
`inactive: true`.

### Covered without AE, and in AE

- `tests/test-text-animator.js` (NEW): 63 checks over a stub that
  reproduces all eight measurements - including the reference
  invalidation, modelled as a generation stamp so that a held reference
  dies while a re-fetch by index still works, which is what AE does.
- 24 suite steps in `extension/js/selftest.js` on their own comp
  (per-character 3D turns the whole layer 3D and never gives it back, so
  the rig cannot share one). `tests/test-self-test.js`'s canned host grew
  a faithful `add_text_animator` plus the dormant-slot behaviour of
  get/set/list, for the usual reason: a host that just said "ok" would
  let a silent tool pass its own steps.
- docs/CAPABILITIES.md regenerated; the curated half says what shipped.

**Harness: 331/331 PASSED** (307 -> 331), every new step green on its
first real-AE run. Stubbed suite: 38 files green.

**No version bump** - feature track, per the workplan's own rule. The
dormant-slot fix to set_property/get_property rides along with it into
the next minor; it is worth noting that a fix travelled on a
no-bump pass, so if the remote session wants it on panels sooner, that
is a patch bump it can cut.

### For the next pass

- **AE blocks on an unreadable modal when a `-r` script throws
  UNCAUGHT.** The first probe here died on the reference trap with no
  try/catch around it, and every later launch was swallowed - AE's own
  error dialog is a wordless `#32770` whose text Win32 cannot read, and
  `AfterFX.exe -r` after that does nothing at all, silently. A posted
  WM_CLOSE cleared it. Every probe script since flushes its JSON after
  EVERY step and wraps the body in one try/catch that records the throw,
  which turns "no output at all" into a named line. Do that from the
  start; it cost this pass two blind runs to work out.
- `duplicate_comp` still takes a name without uniquing (filed by the
  0.9.30 pass, still open) - the same one-line shape precompose and now
  add_text_animator both use.
- There is still no way to read whether a text layer has per-character 3D
  on; the suite proves it by asking a second animator for a 3D-only
  property and checking it does NOT report turning the switch on again.

## 2026-08-28 (local, eleventh pass) - item 5.2: repeaters were never missing, the path to them was (0.9.31)

Harness green on arrival (331/331), so the pass took the highest
unfinished item: **5.2, shape repeaters**. As with 5.4, the workplan's
sketch (`add_repeater`) would have been a duplicate - `add_shape_content
{kind: "repeater"}` has shipped all along - so the pass probed what
exists. The probe DISPROVED the ordering worry it started from and found
a worse bug underneath it, which is what shipped.

### What AE actually does (twelve measurements, one probe run)

**Shape content is a stack, and the stack runs the other way from the
guess.** `addProperty` APPENDS: a repeater added after the rectangle
lands at index 3 - and it repeats. Measured on `sourceRectAtTime`: a
100x100 rect with Copies 3 at Position [200,0] renders 500px wide. The
SAME repeater moved to index 1 renders 100px, i.e. one copy. So a filter
acts on the content ABOVE it, new content is always appended BELOW, and
the shipped append order was right all along. `moveTo(1)` works and
INVALIDATES the held reference ("Object is invalid") - the same trap text
animators had.

**A repeater on a group with no shapes is a silent no-op**, and so is one
on an empty shape layer (`canAddProperty` true, bounds 0x0). Adding the
shape afterwards does NOT rescue it: that shape lands below the repeater.

**A repeater carries four rows plus a Transform block of six:** Copies
(min 0, NO max, 1.5 accepted, -1 throws "is less-than-0"), Offset,
Composite - whose matchName is `ADBE Vector Repeater Order`, not
anything with "Composite" in it - with range 1..2, and Transform with
Anchor Point / Position / Scale / Rotation / Start Opacity / End Opacity
(`ADBE Vector Repeater Opacity 1` and `2`).

**A repeater at the LAYER ROOT works too** and repeats the groups above
it (2 copies at [0,200] -> 300px tall).

**And the one that mattered: a shape GROUP does not hold its items.**
They live in a nested group AE calls "Contents"
(`ADBE Vectors Group`), and AE's timeline never draws that row -
expanding "G1" shows the rectangle, the fill and the repeater directly.
So `contents/G1/Repeater 1/Copies` resolved to NOTHING; the real path
carries a second "Contents" nobody can guess from the UI. Verified in the
probe: both `set_keyframes` calls came back "Path segment 'Repeater 1'
not found under 'contents/G1'. Children here: Blend Mode, Contents,
Transform, Material Options."

### The shipped lie that found

The short path is not a form somebody might invent - it is the form this
panel HANDS OUT:

- `add_shape_content`'s own returned note said "Animatable via
  set_keyframes on 'contents/G2/Repeater 1/<param>' paths".
- the system prompt's wipe-on recipe says "add trim_paths and keyframe
  its End" over `'contents/<Group>/<Item>/<Param>'`.
- the tool's doc string said the same.

All three named a path that could not resolve, so every "animate the
repeater / wipe the stroke on" request failed on the panel's own
instructions. Only a BARE name got through, by the 0.9.27 deep search,
and only when the name was unique on the layer.

### The fix, at the resolver

`AELL_childProp` does one child lookup with the hop AE's UI implies: a
direct child first, then - only on an `ADBE Vector Group` and only after
a miss - inside its Contents. Used by both `AELL_resolvePropPath` and
`AELL_deepPath`, so every property tool gets it at once. A real child
called "Transform" still wins over the repeater's one hop away (checked
both ways in AE: the group's rotation went to 30, the repeater's stayed
15). The long form still works. A missing segment under a group now
lists the items the TIMELINE shows ("Blend Mode, Contents, Transform -
and inside Contents: Rectangle Path 1, ..."), because the four scripting
rows help nobody who is looking at a rectangle.

`add_shape_content` also warns when a repeater/trim/merge/offset/
rounded-corners/pucker/twist/zigzag lands with no geometry above it,
saying the rule AND that adding the shape now will not fix it. A fill
does not count as geometry. Its note now points a repeater's offsets at
`.../Transform/Position`, and tools.js carries the ordering rule and a
ring recipe (Copies + Rotation 360/Copies) as a PROMPT recipe, not a
second tool.

### Covered without AE, and in AE

- `tests/test-shape-mask-tools.js`: the stub's group grew its real four
  rows and the repeater its real defaults, ranges and Transform block;
  new checks cover the short path, the deeper one, the shadowing rule,
  the warning (and its absence on the good order), AE's two ranges, the
  grounded error, and - the one that would have caught this in the first
  place - that the path quoted in the tool's OWN note resolves.
- 14 suite steps in `extension/js/selftest.js`, in the main scratch comp.
  The render proof is `center_anchor_point`: it measures
  `sourceRectAtTime`, so a 100px square repeated 3x at +200 has to hand
  back a centre at x=200. One copy answers 0. `tests/test-self-test.js`'s
  canned host grew a real shape-content model (stack order, the Contents
  hop, ranges, and bounds) for the usual reason: a host that said "ok"
  would let both bugs pass their own steps.
- docs/CAPABILITIES.md regenerated and its curated half updated.

**Harness: 345/345 PASSED** (331 -> 345). Stubbed suite: 38 files green.

**Bumped to 0.9.31** - unlike 5.1 this pass added no tool: it is a fix to
shipped behaviour (three property tools and a documented recipe), so the
feature track's no-bump rule does not cover it and a panel should get it.

### The modal, and what is known about it

Between the probe and the first verification run AE came up blocked on
the wordless `#32770` (an `OS_EditTextContainer` child, no readable
text - the same one the last two passes met). Its cause is NOT
established: both compiled files were checked in AE afterwards and load
clean, and the breadcrumb file showed the suite had run all 345 steps.
Dismissed with the documented posted WM_CLOSE; the blocked script then
completed 345/345 by itself, and the next two runs were green from a cold
start. Worth noting for the next pass: `run-ae-selftest.ps1`'s pre-launch
dismissal did NOT fire for it, twice, because the "Executing Script"
window was up and the stale-dialog plan refuses while AE is running
something. A dialog raised mid-run therefore still costs a manual step.

### For the next pass

- `duplicate_comp` still takes a name without uniquing (filed by the
  0.9.30 pass, still open).
- There is still no tool that reports a layer's rendered bounds;
  `center_anchor_point` is the only route to `sourceRectAtTime`, and it
  MUTATES the anchor to tell you. A read-only `get_bounds` would make
  render assertions cheap for every future shape/text step.
- Item 5.3 (animation preset library) is next on the feature track.

## 2026-08-28 (local, twelfth pass) - item 5.3: a preset does not go where you call it

Harness green on arrival (345/345), so the pass took the next unfinished
feature item: **5.3, the animation preset library**. CAPABILITIES.md
confirmed there were no duplicates to nearly build this time - nothing in
the panel had ever touched a .ffx. Four probe runs against real AE 2026
measured the API, and the first one disproved the item's own premise.

### What AE actually does (four probe runs)

**`layer.applyPreset(file)` does not apply to `layer`. It applies to the
comp's SELECTION.** With two layers selected, one call put the preset on
BOTH - the receiver had no special status at all. And with NOTHING
selected it does not fall back to the receiver either: AE invents a
comp-sized solid ("Solid 6", width = comp width), applies the preset
THERE, selects it, and leaves the layer alone. So the naive call is not a
no-op that a user would notice; it is litter in their comp with the
preset on it.

**Everything else the item worried about turned out not to matter.**
Whether the comp is open in a viewer: no difference (measured both ways,
byte-identical results). Whether a PROPERTY is selected: no difference.
`comp.time` is untouched. A locked layer still takes the preset - AE does
not refuse it. One preset can add ten effects (Backgrounds/Anime Radial)
or none at all.

**"A preset for the wrong layer type does nothing" is only half true**,
and this is what cost the pass a suite iteration. `Text/Animate In/Fade
Up Characters` on a solid changes NOTHING - no effect, no key, no
expression, no throw. But `Text/Animate In/Alternating Characters In` on
the same solid installs its SIX expression-control sliders and two
keyframes and stops there (census 2), where the same preset on a text
layer builds the whole animator (census 15). So a Text preset on a
non-text layer lands partially when it carries controls and not at all
when it does not, and which one AE lists first differs by install.
Cameras and lights are the only guaranteed no-op: they have no Effect
Parade and took nothing from either kind of preset.

Smaller measured facts, all of which the code depends on:

- A bad path THROWS ("Path is not valid") - but only once there is a
  selection to apply to; with an empty selection AE never validates it.
- `File.name` is URI-ENCODED ("Bungee%20In.ffx"). `displayName` is not.
  A listing built from `.name` would ship "%20" to the model.
- The user's presets are under `Documents/Adobe/After Effects*/User
  Presets`, and Documents may be REDIRECTED - it is OneDrive on this
  machine, so a built `%USERPROFILE%\Documents` path finds nothing. Only
  `Folder.myDocuments` gets there. This machine has both an "After
  Effects" and an "After Effects 2026" folder, so the root list is every
  `After Effects*` sibling that has a `User Presets` child.
- 679 .ffx files walked recursively in 117 ms. Cheap, but cached anyway.
- Applying the same preset twice is idempotent for the ones measured
  (the effect keeps its name, AE does not stack a second copy).

### Built

`list_presets` indexes both roots (679 app + the user's), filterable by
`filter` / `category` / `source`, paged like `list_effects`, with
`refresh` to re-walk. A filter that matches nothing is answered with the
installed count and the category list, never an empty array.

`apply_preset {preset, layer|layers}` resolves the name in four tiers
(exact Category/Name, exact name, substring of either) - ambiguity is
REFUSED with the full paths to choose from rather than guessed, and a
miss lists the closest installed names. Then, per layer, it takes a
census of every effect, expression and keyframe on the layer, selects
ONLY that layer inside `AELL_keepSelection`, applies, and takes the
census again. That census is the whole point: AE reports nothing either
way, so it is the only way to tell a preset that worked from one that
silently did nothing. A layer that gained nothing is reported as skipped;
if NO layer gained anything the call is a grounded refusal naming the
layer, its type and the rule. A Text preset that lands on a non-text
layer now comes back with `partialOnNonText` and a note saying the
animation half needs a text layer - the case that would otherwise read
as a clean success and confuse a user who saw six sliders and no
animation.

### Covered without AE, and in AE

- `tests/test-presets.js` (new, 63 checks) stubs the FILE SYSTEM as well
  as the AE model, including the OneDrive-redirected Documents root and
  the URI-encoded `.name`. Its `applyPreset` reproduces all three
  measured behaviours - selection contamination, the invented solid, the
  silent and partial no-ops - and three checks drive it RAW first to
  prove the stub can still catch each bug.
- 13 suite steps in `extension/js/selftest.js`. The rig needed a
  multi-layer selection, which no tool exposes directly:
  `split_layer_into_chunks` is the one tool that deliberately leaves its
  pieces selected, so the rig splits a solid in two and applies to one
  piece. The bystander must come back with zero effect rows, the comp
  must have the same layer count as before, and the selection must be
  the same two layers afterwards. No preset NAME is hard-coded anywhere:
  every step takes its name from `list_presets`, because AE's library
  differs by install and locale.
- `tests/test-self-test.js`'s canned host grew a preset library, the
  split's leftover selection, and per-layer effect state, for the usual
  reason: a host that answered "ok" would let both bugs pass their own
  steps.
- The suite step for the Text-preset-on-a-solid case checks the
  INVARIANT rather than the outcome, since either is legitimate: if the
  tool says it applied, the layer really has those effects; if it
  refuses, the layer really has none. The guaranteed refusal path is
  exercised on a camera instead.
- docs/CAPABILITIES.md regenerated, curated half updated.

**Harness: 358/358 PASSED** (345 -> 358). Stubbed suite: 39 files green.

**Not bumped.** Two NEW tools, which the feature track says ride the next
MINOR for the remote session to cut. Nothing shipped changed behaviour.

### For the next pass

- Item 5.5 (render queue) is next on the feature track, and 5.8, 6.1 and
  6.2 are all waiting behind it.
- Still open from earlier passes: `duplicate_comp` takes a name without
  uniquing, and there is still no read-only `get_bounds` -
  `center_anchor_point` remains the only route to `sourceRectAtTime` and
  it MUTATES the anchor to tell you.
- No modal this time: four probe runs and three harness runs, all from a
  warm AE, none blocked.

## 2026-08-28 (local, thirteenth pass) - item 5.5: the panel can render, and the dialog that eats a night

Harness green on arrival (358/358), so the pass took the next unfinished
feature item: **5.5, the render queue**. It was the right one to take -
5.8, 6.1 and 6.2 all queue behind it. CAPABILITIES.md confirmed the
shape of the work: `add_to_render_queue` already existed with zero stub
tests and zero suite steps, exactly the 5.4 trap, so the job was probe,
extend, cover - not build a duplicate.

Seven probe runs against real AE 2026 (26.3x87). One of them wedged AE,
which turned out to be the single most valuable result of the pass.

### The question the item asked: renderQueue.render() or aerender.exe?

**Settled: `renderQueue.render()` works headless from a `-r` session.**
One frame of a 160x120 comp to a Lossless AVI came back in 181 ms with
status DONE (3019) and 64840 real bytes on disk. No progress dialog
survived the call, no interaction.

So aerender.exe is not used, and the probe also shows it would be the
WRONG tool here rather than merely a redundant one: aerender launches a
second After Effects against a SAVED .aep file, and this panel drives
the user's live, usually-unsaved project. Anything aerender rendered
would be the last save, not what the user is looking at. Logged as a
decision, not a preference.

### The one that cost AE (and would have cost a whole night)

**Rendering to an output path that ALREADY EXISTS raises a MODAL.**
Probe 2 hit it on its last step. AE put up a 489x255 dialog that never
painted (its own thread was wedged behind it), reported no window text
at all - only `OS_ViewContainer`/`OS_EditTextContainer` children, which
is what the harness's triage calls "unreadable" - and from that moment
every `-r` script I sent was swallowed while the process still looked
healthy in Task Manager. That is precisely the failure mode
WORKPLAN-LOG has been describing since 2026-08-21, met head on.

Cleared it with the repo's own `CloseWordlessDialogs` (WM_CLOSE on a
titleless #32770 with no readable child text). It took TWO passes of that
to clear - AE had a second one queued behind the first - and the probe
script then ran to completion on its own, which is how the trigger got
confirmed rather than guessed: the cancelled item came back QUEUED
(3015) with the file untouched.

**`app.beginSuppressDialogs()` suppresses it, and genuinely overwrites.**
That needed proving, because a suppressed dialog answering "no" would be
a silent no-op - the exact bug class this project cares about, and
invisible if you re-render the same frame and compare bytes. So probe 5
rendered 1 frame, then 12 frames to the same path: 64840 -> 698880. It
overwrites.

The tool therefore never uses suppression to find out what AE would have
asked. `overwrite` is decided ABOVE it, in code, against a real
`File.exists` check; suppression only stops the modal from wedging AE
once the answer is already known.

### The rest of what AE actually does

- **`render()` renders the WHOLE QUEUE.** Two fresh items, one call,
  both DONE. So "render this comp" would have rendered everything the
  user had queued. `render = false` quarantines an item (it stays QUEUED
  and writes nothing) and the flag does NOT reset itself, so it has to be
  put back by hand. Both measured, both now done.
- **The output module forces its OWN extension, on the `file` SETTER.**
  Measured both directions: `.mp4` set under "Lossless" reads straight
  back as `.avi`, `.avi` set under H.264 reads back as `.mp4`, and a path
  with no extension is given one. So the path asked for is not the path
  written, and the only honest thing to report is what `om.file` says
  afterwards. This one cost a test iteration: I had asserted the
  behaviour before measuring it, the stub disagreed, and the stub was
  right to - probe 6 exists solely because I caught myself asserting an
  unmeasured fact.
- **A fresh output module inherits the LAST RENDER'S settings AND
  FOLDER.** An untouched item on this machine pointed at
  `Documents\ComfyUI\output\video\MiniMax_H3\2026_08_13\<comp>.mp4` -
  nothing to do with the project. An outputPath-less queue add was never
  neutral; it was bytes into a stranger's folder, silently.
- A missing output DIRECTORY throws ("Directory does not exist: ...")
  rather than prompting - so it can be pre-checked, and is.
- `status` is readOnly; a DONE item cannot be re-queued.
- A bogus template name throws a message that does NOT list the valid
  ones. This machine has 6 render-settings and 19 output-module
  templates, several of them `_HIDDEN` internals.
- **Deleting a comp that sits in the render queue silently drops its
  queue item, with no dialog** - probed specifically before writing the
  suite cleanup, because getting that wrong wedges the harness.
- `om.getSettings()` throws in AE 2026 ("Object of type Object found
  where a Number, Array, or Property is needed") with or without a
  `GetSettingsFormat` argument. `rqItem.getSettings()` works fine. Not
  needed by anything here, but recorded so the next pass does not chase
  it.

### For item 5.8, which this one was supposed to unlock

**`comp.saveFrameToPng(time, File)` EXISTS and works.** 407 bytes for a
160x120 frame, no viewer needed, `comp.time` untouched, overwrites
without a dialog, and `resolutionFactor` IS honoured (half res: 227
bytes). Three silent failures measured and waiting to be handled when
5.8 builds on it:

- a folder that does not exist is a SILENT no-op - no throw, no file;
- an out-of-range time (99s in a 1s comp, or negative) CLAMPS and writes
  a BLANK frame rather than refusing (154 bytes vs 407);
- a String path throws; it demands a real File object.

And one that shaped code in THIS pass: **it writes LAZILY.**
`File.exists` reads false for ~300 ms after the call while the bytes are
already landing - reproduced on two consecutive saves, and the reason
five files this pass first reported as missing and were on disk all
along. Anything that verifies its own output must poll, not glance.
`AELL_rqSettle` does. (Render output does NOT have this latency - it
read back immediately - so the stub models the two differently rather
than pretending they match.)

### Built

`render_comp {comp, output, template, renderSettings, startTime,
durationSeconds|frames, overwrite}` renders and waits. It validates the
output to destruction before anything is queued (absolute path; folder
must exist, and the refusal names the DEEPEST folder that does, because
"create the missing one" is only actionable if you know which one it is;
existing file refused unless `overwrite`, and the refusal says WHY -
that the alternative wedges AE). Templates are matched
case-insensitively and a miss lists what is installed, which AE's own
throw does not. Then it quarantines the user's queue, renders under
suppression, restores every flag it touched and removes its own item -
in a `try/catch` that puts the queue back whatever happened, because a
half-restored queue is worse than not touching it. It reports the path
AE settled on, the bytes, the frames, and how many items it held back.

`list_render_templates` names both template lists (AE only exposes them
through a LIVE queue item, so it costs a net-zero add+remove, cached per
session) plus `tempFolder`, because render_comp demands an absolute path
and "where do I put it" was otherwise the model's guess.

`add_to_render_queue` was fixed, not replaced: it now reports where AE
would actually write, warns when the same comp is queued twice (AE allows
it silently and both copies render), refuses a folder that does not
exist, reports an extension AE overrode, and gives status by name.

### The bug this pass shipped, and then caught in real AE

Worth writing down in full, because it is the most expensive failure
mode this project has and I walked straight into it.

**AE CANNOT RENDER INSIDE AN UNDO GROUP.** I had registered `render_comp`
in `AELL_MUTATING` for what looked like two good reasons - one net-zero
undo step for its queue add/remove, and dry-run protection. The suite
then went 371/371 green, twice. And AE put up **"After Effects warning:
Undo group mismatch"** - a modal, wedging AE for every later -r script
while the process still reported as healthy. AE's renderer closes the
script's undo group out from under it, so the count goes wrong and the
warning surfaces LATER, at some innocent `endUndoGroup` further down the
run. That delay is why the suite could pass and still poison the session.

The fix took two attempts, and the first one was wrong:

1. Take `render_comp` out of `AELL_MUTATING`. Dry-run protection is NOT
   lost by this - that comes from `mutating: true` on the tools.js
   TOOL_DEFS entry, which is a SEPARATE map. The two mean different
   things and this is the first time that mattered.
2. That still leaves a batch: `AELL_callBatch` opens ONE group if ANY
   command mutates, so "add a solid and render it" puts the render right
   back inside one. First attempt closed the group around just the render
   and reopened it - **AE rejected that too**, same modal, measured. So a
   round containing a no-undo-group tool now opens no group at all. The
   cost is that the other mutations in such a round are not folded into
   one Ctrl+Z; the alternative is a modal, so it is not a close call.

Verified by three CONSECUTIVE harness runs (372/372 each) with AE clear
afterwards - back-to-back was the condition that exposed it, since the
second run is the first one whose output file already exists.

`tests/test-undo-groups.js` had an anti-drift invariant that every tool
documented as mutating must appear in `AELL_MUTATING`. Rather than loosen
it, the rule now says what is actually true: a mutating tool gets a group
UNLESS it is listed in the new `AELL_NO_UNDO_GROUP`, that list may only
contain real tools that ARE otherwise mutating, and nothing may be in
both. The exemption cannot be added silently.

### An hour lost to my own probe scripts (read this before writing one)

Four dialogs I chased as AE bugs were compile errors in MY probe files.
Writing a probe via a bash heredoc **mangles backslashes**: 
`.replace(/\\/g, "/")` reached disk as `.replace(/\/g, "/")`, an
unterminated regex, so the script never compiled, never ran, and AE
answered with a modal reading "Unable to execute script at line 7". From
the outside that is indistinguishable from AE being wedged by the tool
under test.

Two things that would have saved the time, for the next pass:
- **Write probe .jsx files with the Write tool, not a shell heredoc.**
- A dialog that will not paint is one whose thread is wedged; a dialog
  that DOES paint can be read. Move it on-screen
  (`MoveWindow` to 100,100), wait ~3 s, screenshot, crop. Every dialog
  this pass was readable that way, and reading the first one would have
  ended the hunt immediately. The window-class probe alone cannot tell
  "Undo group mismatch" from "Unable to execute script" from an
  overwrite prompt - they are all a wordless `#32770` with two
  `OS_ViewContainer` and one `OS_EditTextContainer`.

### Covered without AE, and in AE

- `tests/test-render-queue.js` (new, 82 checks) stubs the file system and
  the render queue, modelling the whole-queue render, the overwrite
  modal (as a distinctive throw - a test cannot model "hangs forever"),
  the extension forcing, the inherited stale folder and the write
  latency. Eight checks drive the RAW API first, so a stub that quietly
  stopped modelling a hazard cannot let the fix pass on a technicality.
  Two of my own assertions failed against it and were WRONG rather than
  the code - that is the stub earning its keep on the day it was written.
- 14 suite steps in `extension/js/selftest.js`, in their own comp
  (160x120, one frame, ~180 ms a render, deleted afterwards). No template
  name is hard-coded - they come from `list_render_templates`, because
  installed templates differ per machine. The load-bearing step is the
  one asserting that rendering onto an existing file is REFUSED: if that
  ever regresses, the modal takes the harness and every pass behind it.
  Overwrite is proved by rendering 6 frames over 1 and requiring the file
  to GROW, since equal bytes cannot tell an overwrite from a skip.
- `tests/test-self-test.js`'s canned host grew a render queue and a
  virtual disk with the same three hazards, for the usual reason: a host
  that answered "ok" would let all 13 steps pass while the real tool
  wedged AE.
- docs/CAPABILITIES.md regenerated, curated half updated.

**Harness: 372/372 PASSED** (358 -> 372), and green on three CONSECUTIVE
runs with AE clear afterwards. Stubbed suite: 40 files green.

**Not bumped.** Two NEW tools, which the feature track says ride the next
MINOR for the remote session to cut. The `add_to_render_queue`
improvements are bundled with them and change no behaviour anyone was
relying on - same precedent as pass 5.1, which also fixed shipped
behaviour on a feature pass without bumping.

### For the next pass

- Item 5.6 (project hygiene) is next on the feature track. 5.8 is now
  unblocked and cheap - `saveFrameToPng` is proven and its three silent
  failures are measured above, so that pass is mostly `import_as_layer`.
- Still open from earlier passes: `duplicate_comp` takes a name without
  uniquing, and there is still no read-only `get_bounds` -
  `center_anchor_point` remains the only route to `sourceRectAtTime` and
  it MUTATES the anchor to tell you.
- **Several modals this pass, all self-inflicted and all cleared** (see
  the two sections above). One thing genuinely worth a human eye: the
  harness triage cannot DISTINGUISH these. "Undo group mismatch",
  "Unable to execute script at line N" and an overwrite prompt are all a
  wordless #32770 with two OS_ViewContainer and one
  OS_EditTextContainer, so all three read as "unreadable" and all three
  get answered by `CloseWordlessDialogs` - which is right for the stale
  save prompt it was built for and hides a real error otherwise. Teaching
  the triage to SCREENSHOT and OCR a popup that paints, or simply to save
  the bitmap next to the log, would have turned an hour of this pass into
  a minute. Filed, not built: it changes the harness every unattended run
  depends on, so it wants a deliberate design rather than a tired patch.
- Also: `CloseWordlessDialogs` sometimes needs running TWICE (AE queues a
  second dialog behind the first). If it reports "closed 1" and AE still
  does not answer a ping, run it again before declaring AE blocked.

## 2026-08-28 (local, fourteenth pass) - item 5.6: three cleanup calls that take more than they say

Harness green on arrival (372/372), so the pass took the next unfinished
feature item: **5.6, project hygiene**. Five probes, then build and cover
in the same pass. No version bump: a new tool rides the next MINOR.

### Isolation first, because these calls delete the project

Every API in this item is project-WIDE and destructive, and the suite (and
any probe) runs inside whatever project the user has open. So probe 2
opened with `app.project.save(<temp .aep>)`, then
`app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)` + `app.newProject()`,
and every measurement after that happened in a throwaway project. That
close/new pair is the useful discovery for later passes: it discards a
dirty project with NO save prompt, which is the modal that would otherwise
wedge an unattended AE.

What was open turned out to be an unsaved scratch project holding 442
leftover items from earlier passes (`AELL Probe *`, `Null 1..39`, dead
`.mp4` placeholders). It is saved and kept in two places rather than
discarded: `%TEMP%\aell-restore.aep` and, durably,
`X:\_CLAUDE\26_08_19_AE_Llama\aell-project-snapshot-2026-08-28.aep`. AE is
now sitting on an empty project, which is the better starting state for
the next pass; nothing was thrown away.

### What AE actually does (AE 2026, 26.3x87)

Each of these is a loss the API does not mention, and each one shaped the
tool:

- **`removeUnusedFootage()` also deletes EMPTY FOLDERS, recursively, and
  counts them in the number it returns.** A project with three empty
  folders and no footage at all answers "3". Emptying a child empties its
  parent and both go; a folder holding only unused footage goes with its
  contents; a folder holding a comp stays. So "removed 3 footage items"
  would have been a lie in the most ordinary case there is.
- It KEEPS footage used only by a comp that is itself unused (measured
  twice, deliberately - it is the obvious wrong guess).
- **`reduceProject(comps)` deletes a comp that only an EXPRESSION names,
  and `expressionError` stays EMPTY afterwards.** Exactly the silent break
  the comp-rename item was built around, now in a second tool.
- **It silently drops the render-queue items of every comp it removes** -
  no dialog, and the RenderQueueItem object goes invalid.
- **It ACCEPTS a footage item in the keep array and then deletes every
  comp in the project.** Measured: 10 items in, one footage item named,
  one item left. That is one plausible model mistake away from erasing a
  user's work, so the tool refuses a non-comp keep entry by name.
- `reduceProject([])` throws "Array is empty"; with no argument at all,
  "the call requires 1 parameter". Neither raises a dialog.
- `consolidateFootage()` merges footage items sharing a file and repoints
  the layers that used the copies - three imports became one and both
  comps still rendered their layer.
- **Undo: unlike a render, all three are ordinary grouped edits.**
  `reduceProject` inside `beginUndoGroup`/`endUndoGroup` closed cleanly,
  ONE `executeCommand(16)` restored all 10 items *and* the render-queue
  item, and a canary group opened and closed afterwards with no "Undo
  group mismatch". So `clean_project` goes in `AELL_MUTATING` normally.
- Timing is a non-issue: a full `usedIn` walk over 321 items took 2 ms and
  removing 300 unused items took 66 ms.

### Built

`clean_project {action, keepComps?, dryRun?}` - one action per call,
`dryRun` DEFAULTS TO TRUE (same reasoning as `rename_comps`: the two
actions that delete take things nobody asked about, so nothing happens
until it has been shown once).

The preview NAMES what would go, with folder paths, rather than counting
it: the unused footage, the folders AE throws in unasked (with a note
saying why they are in the list), the render-queue items that would
vanish, and the expressions that would break silently. On execute it does
not trust its own preview either - it snapshots the project by item id,
calls AE, diffs, and reports `removedUnexpectedly` / `predictedButKept` if
reality and the promise ever disagree. On every rig, in real AE and in the
stub, they agreed exactly and neither field appeared.

Refusals, all grounded: no action or an invented one lists the three real
ones with their consequences; `reduce_project` without `keepComps` refuses
and lists the comps that exist; a keep entry that is a footage item is
refused with what it actually is and why AE cannot be trusted with it; an
unknown comp name comes back through the existing grounded comp lookup.
`"remove unused footage"`, `"consolidate"` and `"reduce"` are accepted as
action spellings, and a single comp name may be a plain string.

### Covered without AE, and in AE

- `tests/test-project-hygiene.js` (new, 48 checks) stubs the project model
  with all four hazards - the empty-folder sweep, the footage-inside-an-
  unused-comp keep, the expression-only comp, and the keep-array footage
  that wipes every comp. Three checks drive the RAW stub API first, so a
  stub that quietly stopped modelling a hazard cannot let the tool pass on
  a technicality. Four of my own expectations failed against it and were
  wrong (label paths and a count), not the code.
- 13 suite steps, **previews and refusals ONLY**. This is a deliberate
  limit, not an omission: every action is project-wide, and the suite runs
  inside the user's open project, so an execute step would delete the
  user's own footage, folders or comps. The two load-bearing steps re-read
  the project after each preview and fail if anything vanished - a
  "preview" that quietly deleted something is the failure this group
  exists to catch. The execute paths were verified in real AE by probe 5,
  which drove the shipped tool through `AELL_call` in throwaway projects:
  preview, execute, diff, and one Ctrl+Z putting all 8 items and the
  render-queue entry back.
- `tests/test-self-test.js`'s canned host learned `clean_project` with its
  refusals intact (a host answering "ok" would let all six refusal steps
  pass), and `add_solid` now registers a real solid source so the
  "did the preview delete it" steps have something to look for.
- docs/CAPABILITIES.md regenerated, curated half updated.

**Harness: 385/385 PASSED** (372 -> 385), green on two consecutive runs
with AE clear afterwards. Stubbed suite: 41 files green.

### For the next pass

- Item 5.7 (audio to keyframes) is next on the feature track; 5.8 is
  unblocked and cheap (`saveFrameToPng` measured in the 5.5 pass).
- No modals this pass, and no dialogs from any hygiene call - the one
  wedge risk (a save prompt from `newProject` on a dirty project) is
  avoided by `close(DO_NOT_SAVE_CHANGES)` first, which is worth reusing.
- Still open from earlier passes: `duplicate_comp` takes a name without
  uniquing; no read-only `get_bounds`; and the harness dialog triage still
  cannot tell three different wordless #32770s apart (filed 2026-08-28,
  wants a deliberate design).
- Worth a human eye, small: `organize_project` is still the one tool that
  cannot be suite-tested at all. `clean_project` shows the shape of the
  fix - a `dryRun` preview that names what would move - so if the remote
  session wants that gap closed, the pattern now exists to copy.

## 2026-08-28 (remote) — 0.10.0 cut, and three design calls answered

The first full unattended night (15 passes, 0.9.21-0.9.31, suite
214->385) was reviewed commit-by-commit and merged to main as PR #48;
the stubbed suite was re-run independently before the merge (41 files
green). One piece of tree pollution found in review, fixed at the root:
requiring chat-probe in tests seeded workflow templates INSIDE the repo
on machines without APPDATA (settings.js's extension-path fallback) —
test-chat-probe now hands the fallback a throwaway root.

**0.10.0 is cut.** The feature-track batch rides it: add_text_animator
(+ the dormant-slot fix), list_presets/apply_preset, render_comp/
list_render_templates (+ AELL_NO_UNDO_GROUP), clean_project, the
portable workflow templates, and the tier/arbiter work. CI now reads
release-notes.txt into the feed's notes field so the update banner says
what a release IS instead of just its number.

**Design calls the passes filed, now answered in WORKPLAN item 4:**
- Version-aware template seeding: hash-history file
  (.hash-history.json, append-only, CI-checked like the capability
  doc); present+known-hash = stale shipped copy -> overwrite,
  present+unknown = user edit -> never touch. Local builds it.
- organize_project gets clean_project's dry-run shape. Local builds it.
- Dialog triage learns to READ (WM_GETTEXT then on-screen screenshot to
  logs\dialogs\), still auto-answers, marks UNRECOGNIZED DIALOG loudly.
  Its own pass, harness run twice after.
- The mixed-round rollback (failed PANEL tool + succeeded host tools in
  one round) stays REMOTE — it needs the round/undo design, not a local
  pass.

Queue for tonight, in order: the three specs above, then 5.7-5.9
(mogrt last), 6.1-6.2, item 7 (tier P4).

## 2026-08-28 (local, fifteenth pass) - item 4: a shipped template that never reached a shipped panel

Harness green on arrival (385/385), so the pass took the first of the
three specs the remote session answered on 2026-08-28: **version-aware
template seeding**. Patch bump (0.10.0 -> 0.10.1): this fixes shipped
behaviour, and it is the kind of fix that has to reach a panel to mean
anything.

### The bug, measured on this machine before touching any code

`ensureDataDirs` seeded bundled ComfyUI templates with "copy what is
missing, touch nothing that is present", so an install froze on whatever
it first saw. Comparing %APPDATA%\AE-Llama\comfy-workflows against the
bundle: **AE_LLAMA_H3_I2V_V1.manifest.json was the version shipped on
2026-08-26**, three releases and two content changes behind - missing the
corrected node attribution and the removal rules that make the template
run on a bare ComfyUI. Every push since had "shipped" it and none of them
had delivered it.

### The one thing the spec could not have known: line endings

The same comparison said the TEMPLATE differed too. It did not. There is
no `.gitattributes` here, so git checks these text files out with the
platform's line endings, and the installed copy was CRLF where the bundle
is LF - byte-different, version-identical. A raw-byte hash would have
recorded hashes that no Windows install ever matches, called every
untouched file a user edit, and re-frozen the exact bug this mechanism
exists to end. So the identity used everywhere is **sha1 of the bytes
with CRLF normalized to LF**, in the script and in setup.js both. It is
the reason only ONE file on this machine turned out to be stale rather
than three.

Second measurement that changed the build: `git log -- <path>` lists ONE
commit for the H3 template where `git log --all --full-history` lists
three (history simplification, plus the panel ships from the dev branch
as well as main). The three happened to hold identical bytes, so nothing
was lost this time, but a version missing from the history is an install
misread as user-edited forever - the seeder walks the full history.

### Built

- `scripts/workflow-hash-history.js` maintains
  `extension/comfy-workflows/.hash-history.json`, append-only: 11
  versions of 6 bundled files, seeded from git. `--check` fails when a
  bundled file's current hash is unrecorded, `--from-git` walks history,
  `--dir` points it at another bundle (the tests use it).
- `ensureDataDirs` now decides per file: absent -> copy; hash IS in the
  history -> unedited shipped copy, refresh it; hash unknown -> a human's
  work, never touched. No readable history (an older ZXP, a build that
  dropped the dotfile) -> the old never-overwrite rule stands, because a
  bundle that lost its record must not start guessing. It returns a
  summary {seeded, refreshed, preserved, current}, and main.js logs a
  refresh rather than changing a workflow file in total silence.
- The dotfile is bundle metadata: it is not seeded into the data root,
  and the history does not record itself. Confirmed the ZXP packager
  carries it (`Copy-Item -Recurse` does take dotfiles in subdirectories -
  tested directly, since a dotfile silently missing from the ZXP would
  degrade to the old behaviour with no symptom).

### Verified in the field

Ran the real `ensureDataDirs` against the real %APPDATA%\AE-Llama: it
**refreshed AE_LLAMA_H3_I2V_V1.manifest.json**, reported the other five
as current, preserved nothing (nothing was edited here), and the second
run was a clean no-op. All six installed files now hash equal to the
bundle. This machine is no longer running a five-release-old manifest.

### Covered without AE

- `tests/test-workflow-seeding.js` (new, 33 checks) drives the real
  setup.js against throwaway bundles: fresh seed, stale-unedited refresh
  from the FIRST and from a MIDDLE recorded version, user edit preserved
  byte-for-byte, both CRLF cases (a CRLF copy of the current version is
  "current", a CRLF copy of an old one is still refreshed), missing
  history, unparseable history, a history that forgot one file, an absent
  bundle, and the real shipped bundle (every file must read as current -
  if any shipped file's own hash were missing, a real install of it would
  read as an edit and never update again).
- `tests/test-workflow-hash-history.js` (new, 16 checks) runs `--check`
  against the shipped bundle the way test-capability-doc does, and proves
  the CI failure it exists for: change a template without recording it
  and --check fails naming that file and not the untouched one; record it
  and the OLD hash survives (append-only - some install is still on it).
- docs/CAPABILITIES.md curated half updated. Stubbed suite: **43 files
  green** (41 -> 43). **Harness: 385/385 PASSED**, green before and after.

### For the next pass

- Two specs left from the remote's three: **organize_project's dry-run
  shape**, then **the dialog triage that READS before it answers**. Then
  5.7 (audio to keyframes), 5.8, 5.9 (mogrt last).
- The harness found AE **already blocked by a wordless dialog on arrival**
  for the second run of this pass and answered it with Cancel, as
  designed. Nothing this pass did could raise one (no AE writes outside
  the suite), so it was left over from the first run's teardown - which is
  precisely the case the dialog-triage spec wants evidence for. Both runs
  passed 385/385 and AE was clear afterwards.
- Small, for whoever does the next template change: run
  `node scripts/workflow-hash-history.js` after editing a bundled
  template, or CI fails. That is deliberate.
- Note for anyone driving Windows paths through the Bash tool here:
  an inline `node -e "...'C:\Users\...'..."` had its backslashes eaten
  and created a literal `C:\UsersmrAppDataRoamingAE-Llama` tree. Found
  and removed in the same pass; use a script file for Windows paths.
- Still open from earlier passes: `duplicate_comp` takes a name without
  uniquing; no read-only `get_bounds`.

## 2026-08-28 (local, sixteenth pass) - item 4: organize_project promised a folder it never used (0.10.2)

Harness green on arrival (385/385), so the pass took the second of the
remote session's three specs: **organize_project gets clean_project's
dry-run shape**. Patch bump 0.10.1 -> 0.10.2: it changes shipped
behaviour, including one thing that was quietly wrong.

### What AE actually does (AE 2026, 26.3x87, one probe run)

Every classification rule in this tool was measured before a line was
written, in a throwaway project:

- a comp created by script lands at the **project root**, so every comp
  the panel makes is "loose" until this tool runs;
- AE parks a solid's SOURCE in its own `Solids` folder the moment the
  solid is created (`parentIsRoot=false`), so solids are almost never
  loose and a `Solids: 0` count is the normal answer, not a miss;
- **a SolidSource reports `isStill` TRUE**, so the solid test has to come
  before the still test or every solid files as an image;
- a PNG is `hasVideo` + `isStill`, an audio-only WAV is `hasAudio` with
  `hasVideo` false, an MP4 is both with `isStill` false. The shipped
  order was already right; now it is pinned by a test.

### The shipped bug the probe fell over

The rig had a folder called `Comps` NESTED inside `PR Archive` (the kind
of thing a real project accumulates). The shipped tool resolved its
destination with `AELL_findFolder`, which matches a folder name ANYWHERE
in the project, and filed both root comps into **`PR Archive/Comps`** —
somebody else's folder, chosen because it happened to share a name — while
answering `{"organized":{"Comps":2,...}}` and "existing folder structure
was left alone". Two sentences, both true-sounding, describing a move the
user did not ask for.

So destinations are now looked for **at the root only**. A same-named
folder deeper in the tree is reported as `sameNameElsewhere` (by path)
with a note saying the project will end up with two folders of that name
— named, never used. This is a behaviour change beyond the dry-run spec,
and it is deliberate: a preview cannot be honest while the destination it
promises is picked by a tree-wide name search.

### Built

- `organize_project {dryRun?}`, `dryRun` defaulting to TRUE. The preview
  names each move as `item -> folder`, counts them in `byFolder`, names
  the folders it would CREATE, counts what is `alreadyFiled` and how many
  `rootFolders` exist, and caps every list with a `...NotShown` count
  (the shared `AELL_hygCap`, 40).
- Execute does not trust its own preview: after each reparent it checks
  where the item actually landed, reports `moved` for the ones that did
  and `notMoved` (with where it still is) for any that did not.
- `AELL_orgDest` / `AELL_orgRootFolder` / `AELL_orgHomonyms` carry the
  measurements above as comments, so the next reader does not re-probe.
- tools.js: the tool doc says the preview comes first and that a Solids
  count of 0 is normal; the system prompt gained "'file / sort / organize
  the project panel' = organize_project ... A preview is not an organized
  project — never report one as done."

### Verified in the field, and covered without AE

- Real AE, throwaway project: the preview changed nothing (snapshot
  identical), the execute matched the preview exactly (5 moves, 4 folders
  created), the nested `PR Archive/Comps` stayed EMPTY, an already-filed
  comp stayed put, the second preview was a clean no-op, and **one undo
  put the whole panel back**.
- `tests/test-organize-project.js` (new, 49 checks) stubs the project
  model with the measured facts — including a SolidSource whose `isStill`
  is true, checked through the RAW stub first so a stub that stopped
  modelling the trap cannot let the tool pass on a technicality. It covers
  fresh preview, execute, second-run no-op, the loose solid, the nested
  homonym (the comp must land in a ROOT `Comps` and the nested one must
  stay empty), reuse of an existing root folder, a move AE refuses
  (reported, never counted as done), the 40-item cap, and an empty
  project.
- Six suite steps in `extension/js/selftest.js`, **previews only** — an
  execute step would file every loose item in the user's own project. The
  load-bearing one re-reads the project afterwards and fails if the item
  count or the folder count moved at all, or if the rig comp acquired a
  parent folder. `tests/test-self-test.js`'s canned host learned
  `organize_project` (previewing, refusing the nested folder), started
  listing FOLDERS in `get_project_info`, and now resolves a folder
  `delete_item` by the id `create_folder` handed back, the way real AE
  does — a host answering "ok" would let all six steps pass.
- docs/CAPABILITIES.md regenerated (organize_project drops off BOTH
  computed coverage-gap lists) and its curated half updated.

**Harness: 391/391 PASSED** (385 -> 391). Stubbed suite: 44 files green.

### For the next pass — dialog triage, and three facts it can have free

The last of the remote's three specs is **the harness dialog triage that
READS before it answers**, and this pass ran into its subject matter three
times. What it cost, and what it is worth:

1. **`GetWindowText` is why the dialogs look wordless.** The harness's
   `OnWordCheck` calls `GetWindowTextW` on each child; for a control owned
   by ANOTHER process that returns empty, so every AE alert reads as
   "no readable text". `SendMessage(hwnd, WM_GETTEXT=0x000D, ...)` on the
   same child returned the full sentence immediately, first try, no
   screenshot needed: "Unable to execute script at line 35. After Effects
   error: Unable to call "addComp" because the call requires 6
   parameters." — my probe's own bug, identified in one call after two
   blind re-runs had already failed. Build step (1) of the spec on
   WM_GETTEXT, not GetWindowText.
2. **`PostMessage(WM_CLOSE)` does NOT answer these alerts** — the dialog
   was still there afterwards. Posting `WM_KEYDOWN`/`WM_KEYUP` with
   VK_RETURN dismissed both alerts this pass hit; `WM_COMMAND IDOK` did
   nothing either. Worth knowing before the triage pass changes how
   answers are posted.
3. **A wedged AE swallows the next `-r` script silently.** While that
   alert was up, two `AfterFX.exe -r probe.jsx` launches did nothing at
   all — no output file, no error, AE "Responding: True". A probe that
   seems to produce nothing is a dialog until proven otherwise.

Two probe rules for whoever writes the next one:
- **Flush every line** (`open("a")` / `writeln` / `close` per line). The
  first probe of this pass opened its output with `open("w")` and died at
  line 35, leaving a ZERO-BYTE file and no clue.
- **Never call `app.executeCommand(16)` (Undo) inside a `-r` script run.**
  It raises "After Effects warning: Undo group mismatch, will attempt to
  fix." — AE wraps a `-r` run in its own undo group. The undo itself still
  worked (the panel came back on the first one), and the shipped rollback
  is unaffected because it runs inside `AELL_callBatch`, but the warning
  wedges an unattended run. Also: `app.findMenuCommandId("Undo")` returned
  **2371**, not 16, and executing it did nothing — use 16.

### Still open

- Item 5.7 (audio to keyframes) is next on the feature track after the
  dialog-triage pass; 5.8 is unblocked and cheap.
- `duplicate_comp` takes a name without uniquing; no read-only
  `get_bounds`. Both still unclaimed.
- `release-notes.txt` still reads "0.10.0: ..." while the feed ships
  0.10.2, so the update banner describes the last MINOR. The 0.10.1 pass
  left it alone too; it belongs to the remote session's release cut, so
  this is a flag, not a fix.
- The project AE was holding when this pass started (25 leftover items,
  unsaved) was saved before the probes isolated: a temp copy plus
  `X:\_CLAUDE\26_08_19_AE_Llama\aell-project-snapshot-2026-08-28-organize.aep`.
  AE was left on an empty project.

## 2026-08-28 (local, seventeenth pass) - item 4: the harness reads the dialog before it answers it

Harness green on arrival (391/391), so the pass took the LAST of the
remote session's three specs: **harness dialog triage learns to READ
before it answers**. No version bump, for the reason the 2026-08-26
harness pass gave: the panel ships `extension/` alone, and this touches
`scripts/` and `tests/` only. Bumping would publish a feed telling every
installed panel to update to a build identical to the one it is running.

### The thing that was never true

For months every After Effects dialog reached the triage as "no readable
text", and the whole machinery was built around that: verdicts decided
from the SITUATION (is AE started, is a script executing, has the popup
lasted), because nothing could read the words. `GetWindowTextW` returns
EMPTY for a control owned by another process, which is the whole of it.

`SendMessage(WM_GETTEXT)` on the very same child returns the sentence.
Measured on the save-changes prompt, first try, no screenshot needed:

    [#32770] title=''
      DroverLord  GWT='OS_ViewContainer'     WMGT='OS_ViewContainer'
      DroverLord  GWT='OS_ViewContainer'     WMGT='OS_ViewContainer'
      DroverLord  GWT='OS_EditTextContainer' WMGT='OS_EditTextContainer'
      Edit        GWT=''                     WMGT='Save changes to
                                                   "Untitled Project.aep"
                                                   before closing?'

One `Edit` child holds the text, its `GetWindowTextW` is empty, and the
quotes are CURLY. The buttons (Save / Don't Save / Cancel) are drawn by
AE and have no windows at all.

### What shipped, and the one line it must never cross

- `HarvestDialogText` in the runner's C#: for every visible top-level
  `#32770` of the AE process, the window title plus `WM_GETTEXT` from
  every child. `SendMessageTimeoutW` with `SMTO_ABORTIFHUNG` and 400ms,
  never `SendMessage` -- this runs unattended and a wedged dialog must
  not wedge the harness with it. A control that does not answer is
  recorded as `<no answer>`, so a failed read cannot pass for a dialog
  with nothing to say.
- `Get-AellHarvestClass` (triage lib) sorts a harvest into known-benign
  (nothing readable, or the save-changes prompt) and everything else.
  Judged LINE BY LINE, never on the joined text: two popups can be up at
  once and "the save prompt is in there somewhere" must not launder an
  error alert standing next to it. The pattern reaches AROUND the
  project name (`Save changes to .* before closing`) because the real
  text has curly quotes and the .ps1 is ASCII by rule.
- The harvest is **evidence, not a verdict**, and this is the load-
  bearing decision of the pass. `Get-AellStaleDialogPlan` answers a
  leftover dialog only on the `unreadable` verdict. Feed it the harvest
  and the save-changes prompt becomes readable, the verdict flips to
  `blocked`, and the harness stops answering the ONE dialog the whole
  mechanism exists for -- an unattended pass would be back to losing its
  first run to a prompt the previous run left up. Reading a dialog must
  not make the runner more timid than it was when it was blind, so the
  answer set is exactly what it was: still gated on the situation, still
  only a `#32770` that is wordless to `GetWindowText`, still
  `PostMessage`. A stub test pins the separation (the verdict function
  may not mention the harvest functions).
- Screenshot to `logs\dialogs\<timestamp>.png` for everything except the
  recognized save prompt -- the wordless case the spec asked for, plus
  every unrecognized one, so the `UNRECOGNIZED DIALOG` marker always has
  a picture to point at. `logs/` is gitignored.
- `UNRECOGNIZED DIALOG <context>` printed with the text and the PNG
  path, at both places a dialog is now read: before the pre-launch
  answer, and in the exit-4 report. The run proceeds either way.

### Three measurements that cost an attempt each

1. **The dialog is not drawn where Win32 says it is.** `GetWindowRect`
   returned 60,60 for a prompt whose visible frame started near 133,127.
   A crop to the rect captured the desktop behind it -- twice. Fix: grab
   the whole virtual screen.
2. **"Move it only if the rect leaves the screen" is not enough**, for
   the same reason. The error alert's RECT fitted, its PICTURE ran off
   the bottom-right, and the first evidence PNG had the sentence cut off
   mid-word. Every dialog is now moved to the top-left unconditionally
   (staggered so two do not stack) before the capture. It only happens
   when the harness is already taking evidence on a dialog it is about
   to answer, and a picture missing the words is not evidence.
3. **A moved window has not repainted yet.** A capture taken immediately
   after `MoveWindow` caught the desktop; raise it (`BringWindowToTop` +
   `SetForegroundWindow`) and wait 1.2s and it is perfectly readable.

### Two bugs the stub test found, both real

- `return ,$words` in the new word filter. The comma wraps an EMPTY
  array in a one-element array, so a dialog with nothing to say came
  back with Count 1 (its one "word" being an empty array), fell through
  to the unknown loop, added nothing, and classified as the save-changes
  prompt. Every wordless popup would have been reported as recognized.
  Plain `return $words` plus `@()` at the call sites is right for none,
  one and many.
- The test's own `psString` could not carry AE's text: **PowerShell 5.1
  accepts curly quotes as string DELIMITERS**, so pasting the real
  sentence into a double-quoted literal ends the string mid-way and the
  script does not parse. It now splices them in with `[char]0x201c` and
  writes the temp .ps1 as UTF-8 with a BOM -- the old ASCII write masked
  U+201C into a control character, and the test would have proved the
  pattern matches garbage rather than what AE actually says.

### Verified in the field

Every path exercised against real AE 2026:

- **Unrecognized dialog**: a deliberate `addComp("wedge")` (6 params
  required) left AE's own error alert up. The harness read it in one
  call -- "Unable to execute script at line 3. After Effects error:
  Unable to call addComp because the call requires 6 parameters." --
  saved a PNG showing the whole alert including the OK button, printed
  `UNRECOGNIZED DIALOG answered before the launch`, answered it, and ran
  391/391. Run twice: the first PNG was the one cut off at the screen
  edge, which is how measurement (2) above was found.
- **Recognized dialog**: the save prompt raised by posting WM_CLOSE to a
  dirty AE. Named in the log, NO screenshot, NO marker, answered,
  391/391.
- **Clean runs**: the harness twice back-to-back as the spec requires.
  391/391, exit 0, both times, with none of the new output on screen.
- Stubbed suite: 44 files green, `tests/test-selftest-runner.js` grown
  by 20 checks over the harvests captured from real AE.

**Harness: 391/391 PASSED, twice.** No suite steps changed (this is
harness machinery, not panel behaviour).

### One earlier note corrected, and what is still open

The organize_project entry above recorded that `PostMessage(WM_CLOSE)`
does NOT answer AE's script-error alerts. On AE 2026 it does: the posted
WM_CLOSE cleared the addComp alert on both runs of this pass ("answered
1 dialog(s)" then "cleared", suite green immediately after). That note
held for whatever alert the earlier pass was looking at; it is not a
general rule, so a dialog that does not clear is still expected and
still reported.

- All three of the remote session's specs are now built (0.10.1 workflow
  seeding, 0.10.2 organize_project preview, this one).
- Next on the feature track: item 5.7 (audio to keyframes); 5.8 is
  unblocked and cheap.
- `duplicate_comp` takes a name without uniquing; no read-only
  `get_bounds`. Both still unclaimed.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.2.
  Third pass to flag it; it belongs to the remote session's release cut.
- Unattended runs write evidence PNGs to `logs\dialogs\`. Nothing prunes
  them. They are ~100KB each and only written when a dialog is not the
  save prompt, so this is a note rather than a problem.

## 2026-08-28 (local, eighteenth pass) - item 5.7: audio to keyframes

Harness green on arrival (391/391), so the pass took the next unfinished
feature-track item. Probe, build and lock-in all landed; no version bump,
because a NEW tool rides the remote session's next MINOR.

### The sketch was half wrong, and the half that was wrong is the design

The workplan asked for `audio_to_keyframes {layer}`. AE's command has no
notion of a layer at all. Measured, in this order:

- `app.findMenuCommandId("Convert Audio to Keyframes")` = **4218**.
  "Convert Audio To Keyframes" (capital To) = 0. The same string with an
  ellipsis = 0. The spelling is not a style choice.
- It converts **the ACTIVE comp**. With another comp in the viewer it ran,
  returned, and created nothing anywhere.
- It **ignores the selection**. With only a silent solid selected it still
  measured the whole comp mix - same peak, 56.53, as with nothing
  selected.
- A **muted layer contributes an all-zero curve**. That is the whole basis
  of per-layer isolation, and it was measured both ways round on two
  copies of one beat offset by 2s: mute B and the second half of the curve
  is flat, mute A and the first half is.
- It is **bounded by the work area**. Work area 0.5..1.5 on a 4s/24fps
  comp gave 25 keys from 0.5 to 1.5, not 97 from 0 to 4.
- It **never uniques the null's name**. Two runs, two layers both called
  "Audio Amplitude" - and then every name-based reference after that
  (link_property, any expression) silently takes whichever is higher.
- With **no audio-capable layer it does nothing at all**: no layer, no
  exception, no dialog. Silence is the only signal it gives.
- The created layer: a null, `nullLayer` true, 100x100, spanning the COMP
  (not the audio), three `ADBE Slider Control` effects in the order Left
  Channel / Right Channel / Both Channels, each holding a "Slider"
  (`ADBE Slider Control-0001`) with LINEAR keys, one per frame. It also
  leaves a footage item named "Audio Amplitude" in the project, the way
  every AE null does.
- `layer.id` is a plain unique number and object identity holds, so
  "which layer is new" is answerable without guessing at names.

So the shipped tool is `audio_to_keyframes {comp?, layer?, name?, range?}`
and is almost entirely the difference between that list and what a user
means:

- the target comp is opened in the viewer before the call;
- `layer` isolates by muting every OTHER audible layer and un-muting it
  again, in a restore block that runs whatever happened, so a throw cannot
  hand the user a comp with a layer left muted (a stub test forces that
  throw);
- `range` defaults to `"comp"`: the work area is widened to the whole
  comp, restored exactly, and the widening is REPORTED. `range:
  "workArea"` keeps AE's own behaviour and says so. **Assumption written
  down:** AE's native behaviour is work-area-bound, and I made the tool's
  default differ from it. A user asking for beat-driven animation and
  silently getting one second of keys is the worse surprise, and the
  result names the range either way;
- the null is renamed to the first free "Audio Amplitude N" and the
  rename is reported;
- refusals come BEFORE the call, because after it there is nothing to
  read: no audio-capable layer (lists the layers that ARE there and names
  `import_file`), every audio layer muted (names them), a named layer
  with no audio (lists the ones with audio), and a bad `range` - which is
  checked FIRST, ahead of the comp's state, so an argument typo is not
  reported as "this comp has no audio";
- `audioActive` is deliberately NOT used for any of that. It also asks
  whether the layer is audible at the CURRENT time, so a music layer
  starting at 2s reads false with the playhead at 0 and the tool would
  refuse a perfectly good comp. `audioEnabled` is the mute switch and is
  time-independent.

### The suite needed audio and got it with no file on disk

`import_file` is still uncovered because it needs a file, and the audio
steps looked like they had the same blocker. They do not: applying **Tone
(`ADBE Aud Tone`) to a plain solid flips `layer.hasAudio` to true** and
the converter measures it - 73 keys, peak 34.33 on a 3s/24fps comp, two
tone layers 36.02. That gap is what the lock-in steps read: mix, isolate
(must be BELOW the two-layer mix), mix again (must be back UP to it),
which is the only way the suite can prove the un-muting really happened.
Thirteen steps in a comp of their own, including the three refusals and a
`link_property` step that closes the loop the tool's own `next` promises.

### Two bugs found before AE ever saw them, both real

- The uniquing counted the layer AE had just made. `AELL_uniqueLayerName`
  walks the comp, and the new null is already IN the comp when it runs, so
  EVERY conversion would have come back "Audio Amplitude 2" with a
  spurious `nameTaken` note. Fixed with `AELL_uniqueLayerNameExcept`,
  which holds one layer out of the taken set.
- `AELL_layerNamesOf` already returns a joined STRING; four call sites had
  `.join(", ")` on it. That is a "join is not a function" in ES3, inside
  the refusal path - the grounded errors would all have thrown.

The canned host in `tests/test-self-test.js` was unfaithful in a way that
mattered too: its `link_property` returned no `expression`, though the
real tool always does. A suite step asserting on it passed against AE and
failed against the stub. The canned host now writes the expression.

### One dialog, and it was mine

The first harness run after the change came back exit 4 on "After Effects
warning: Undo group mismatch, will attempt to fix." Two clean facts
separate the tool from the blame: replaying the ENTIRE thirteen-step
group through AELL_call / AELL_callBatch in a `-r` script produced no
warning at all, and the harness has been green 404/404 twice back-to-back
since. What differed was the earlier PROBE: it wrapped its AELL_call
rounds in its own `app.beginUndoGroup(...)` / `endUndoGroup()`, so the
menu command ran two undo levels deep. **Probe rule for the next pass:
never wrap AELL_call in your own undo group** - the tool opens one
already, and a menu command inside the nested pair leaves the count wrong
for whoever calls `endUndoGroup` next, which was the harness. Same family
as the render_comp warning already in the log, and the same delayed,
misleading signature.

`audio_to_keyframes` IS registered in `AELL_MUTATING` (one Ctrl+Z undoes
a round) and in `AELL_PER_LAYER_LIST` (for_each_layer may drive it: one
amplitude null per audio layer is a coherent ask, and a silent layer just
earns the grounded refusal). It is NOT exempted the way `render_comp` is;
measured across six calls in one group with no warning.

**Harness: 404/404 PASSED, twice** (391 -> 404). Stubbed suite: 45 files
green, including the new `tests/test-audio-keyframes.js` (66 checks).

### Still open

- Next on the feature track: 5.8 (frame round-trip), which also unblocks
  `import_file`'s suite coverage and H3 r2v.
- No suite step covers the work-area path: nothing in the tool set can
  SET a comp's work area, so `range` is proven by the stub only. A
  `set_comp_setting` that reached workAreaStart/workAreaDuration would
  close it, and is a small pass of its own.
- `duplicate_comp` takes a name without uniquing; no read-only
  `get_bounds`. Both still unclaimed. The uniquing bug above is the same
  class as the first of those.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.2.
  Fourth pass to flag it; it belongs to the remote session's release cut.
- Probe scratch files were written under `logs/` (gitignored) and AE was
  left on an empty untitled project.

## 2026-08-29 (local) - item 5.8: the frame round-trip, and the fit AE will not do for you

Harness green on arrival (404/404), so the pass took the next feature
item: 5.8, the comp<->file bridge. It shipped whole in one pass -
`snapshot_frame` and `import_as_layer`, both docs, 100 stub checks, 17
suite steps - because most of the probing was already on disk.

### A probe nobody logged

`logs/probe58.txt` and `probe58b.txt` were sitting in the (gitignored)
logs folder, written 2026-08-28 21:58-22:01, with no WORKPLAN-LOG entry
anywhere. A pass ran the 5.8 PROBE and died before it could write
anything down; the log's last entry is 5.7, and the run that made those
files left no other trace. The measurements were good and were reused
rather than repeated. **The lesson is the log's own rule, from the other
direction: a pass that has measured something and not yet written it
down has produced nothing.** Had those two files been swept, this pass
would have re-run every probe.

### The three questions the earlier probe left open

One more probe round (`logs/probe58c.jsx`) answered them:

- **Is `saveFrameToPng` safe inside an undo group?** YES - three nested
  `beginUndoGroup`/`saveFrameToPng`/`endUndoGroup` rounds followed by
  three innocent group cycles, no exception and no "Undo group mismatch"
  modal. This is NOT the render_comp case: AE's renderer closes the
  script's group out from under it, this does not.
- **What does a non-.png extension do?** AE writes **PNG bytes into the
  name it was given**. `wrongext.jpg` is a 897-byte PNG called .jpg, and
  no .png appears beside it. A user double-clicking that file gets a
  broken-image icon and no idea why.
- **Does `mainSource.reload()` work on an imported still?** Yes, keeps
  the item id and the dimensions. That is what makes re-placing a
  regenerated file safe.

Plus one accident worth more than the three: matching project items by
`mainSource.file.fsName` found **2** items for one path in the harness's
own leftover project, and 37 items with no file at all (comps answer
`undefined` for `mainSource`, solids hold a `SolidSource`). Both shapes
are now handled and the duplicate is reported.

### PROBE RULE: never call app.newProject() in a probe

The first run of probe58c produced no output file at all and AE looked
healthy. It was blocked on **"Save changes to \"Untitled Project.aep\"
before closing?"** - `app.newProject()` on the dirty project the HARNESS
leaves behind. Every `-r` script after that was swallowed silently, the
same signature as the overwrite modal and the undo-group modal. The
harness's own `Clear-AellStaleDialog` answered it with WM_CLOSE (Cancel)
on the next run. Probes work inside whatever project is open and clean
up after themselves; the rewritten probe does exactly that and removed
its 12 items on the way out.

### What AE does silently, and what the tools say instead

Every one of these is measured, and every one is now a refusal or a
spoken note:

- a folder that does not exist is a **silent no-op** - `saveFrameToPng`
  returns normally and writes nothing;
- an out-of-range time **CLAMPS** and writes a BLANK frame (time 99 and
  time -5 on a 4s comp both wrote 378 bytes where the real frame was
  644);
- an existing file is replaced with **no dialog and no undo** (unlike a
  render, which raises a modal - so the refusal here protects the user's
  file rather than the harness);
- a comp left at **Half resolution** writes a half-size frame and says
  nothing. The default overrides the downsample, restores it in a block
  that runs whatever happens, and REPORTS it; `{resolution: "comp"}`
  keeps AE's behaviour and warns about the smaller frame;
- the reported dimensions are read back out of the **PNG's own IHDR
  header**, not repeated from the comp, so "did I get the pixels I asked
  for" is answerable rather than assumed;
- guide layers are not rendered into a snapshot;
- `importFile` on a path the project already holds makes a **second
  item** and says nothing, so an existing item is reused and reloaded;
- `canImportAs(FOOTAGE)` answered **TRUE for a .txt** that `importFile`
  then refused outright, so the throw is the only honest signal and the
  refusal names what AE really reads.

### The fit arithmetic is ours, because AE's is unusable here

`app.findMenuCommandId("Fit to Comp")` resolves (2156, plus 2732/2733
for Width/Height) and **does nothing at all with no comp viewer open** -
scale stayed 100,100 across every rig. With a viewer open it works, and
those numbers are what the panel's own arithmetic reproduces:

| source 320x240 par 1 | AE Fit to Comp | Width | Height |
|---|---|---|---|
| in 800x480 par 1 | 250 x 200 | 250 x 250 | 200 x 200 |
| in 720x480 par 1.2121 | **272.727** x 200 | 272.727 x 272.727 | 200 x 200 |

So `rx = 100 * (compW * compPar) / (srcW * srcPar)`, `ry = 100 * compH /
srcH`, and the modes are combinations of the two: `stretch` = AE's "Fit
to Comp" (non-uniform, distorts), `width`/`height` = its uniform
siblings, `fit` = min (contain, the default), `fill` = max (cover),
`none`/`center` = AE's own 100%. The pixel-aspect correction on X is the
part nobody would guess - the pixel-only answer there is 225, not
272.727 - and the suite asserts the real AE numbers, not the formula.

### Where the two tools sit in the undo machinery

`import_as_layer` is ordinary: `AELL_MUTATING`, one Ctrl+Z.
`snapshot_frame` is in **`AELL_NO_UNDO_GROUP`**, but for the second half
of render_comp's reasoning rather than the first. It is SAFE inside a
group (measured above); what it is not is undoable - the file it writes
survives any Ctrl+Z - so counting it as a mutation would let a
successful snapshot arm `AELL_maybeRollback` and spend the round's one
undo on somebody else's edit. `tests/test-undo-groups.js` caught this
the moment the tool was documented `mutating: true` and listed in
neither map: a tool owes the host one answer or the other, and that
invariant is what made the question get asked at all.

### import_file, covered at last

It has shipped since the beginning, had zero suite steps, and the only
thing it ever needed was a file on disk - which `snapshot_frame` now
makes. Two steps: it returns an item, and the comp's layer count does
not change, which is the whole difference between it and
`import_as_layer`. **`docs/CAPABILITIES.md`'s computed gap list now
reads "Host tools never exercised by the self-test suite: none"** - the
first time every host tool has been touched in real After Effects.

### Verification

- `tests/test-frame-roundtrip.js`: 100 checks, including a STUB FIDELITY
  block that drives the raw API first so a stub that stopped modelling
  the hazards cannot let the fixes pass on a technicality.
- Full stub sweep: 46 files, all green.
- **Harness: 404 -> 419 -> 421/421 PASSED**, three consecutive runs
  (419 twice back-to-back before the two import_file steps were added).
- The canned host in `tests/test-self-test.js` learned all three tools,
  and a `resetFrRig()` with them: the second (deliberately failing) run
  shares the virtual disk, so without it the layer-count assertion
  counted two runs' imports and the injected-failure test read
  419/421.

### Still open

- Next on the feature track: 5.9 (.mogrt export) - flagged in the
  workplan as a LAST-item-of-the-night job for dialog risk, which this
  pass's save-changes modal is a fresh argument for.
- Generation wiring stays remote, but the bridge it was waiting on is
  now here: `comfy_generate` still calls `import_file` and leaves its
  output in the project panel. Pointing it at `import_as_layer` is a
  small remote-session pass, and the reuse+reload path was built for
  exactly the regenerate-the-same-path case.
- No suite step covers `snapshot_frame`'s resolution override: nothing
  in the tool set can SET a comp's resolutionFactor, so it is proven by
  the stub only. Same shape as 5.7's work-area gap, and the same
  `set_comp_setting` extension would close both.
- `duplicate_comp` still takes a name without uniquing; no read-only
  `get_bounds`. Both still unclaimed.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.2 -
  fifth pass to flag it; it belongs to the remote session's release cut.
- Probe and patch scratch files under `logs/` (gitignored). AE left on
  the harness's own project, which is dirty - see the probe rule above.

## 2026-08-29 (local) - the two comp settings nothing could reach, and the
## frame they were quietly stealing

Harness green on arrival (421/421), so the pass took the item the last
two entries had each filed as "a small pass of its own": `set_comp_setting`
could not reach the WORK AREA or the comp RESOLUTION, which left 5.7's
`range: 'workArea'` and 5.8's `resolution` override proven by stubs alone.
Both are now real-AE steps - and closing that gap turned up a shipped bug
that had been moving the user's work area by a frame since 5.7 landed.

### What AE does with a work-area write, measured

`logs/probe-cs.txt`, then `probe-cs3.txt` for the part that mattered:

- a write **SNAPS to the frame grid**, silently: on a 24 fps comp 0.333s
  reads back as exactly 8 frames and 1.7s as 41;
- an out-of-range write **THROWS**, it does not clamp ("Value 99 out of
  range 0.04 to 4") - and AE's message arrives with mojibake curly quotes
  through ExtendScript, so the tool refuses in its own words first;
- the legal range for `workAreaDuration` is computed from the CURRENT
  start, so widening from a late start throws ("out of range 0.04 to 1"
  with the start at 3s) - duration-before-start is a trap;
- a `workAreaStart` write keeps the DURATION and shortens it only when
  that would run past the end of the comp (0..4s work area, start 3.9 ->
  start 3.9167, duration 0.0833, end still 4);
- **and the one that cost a bug: a start written EXACTLY onto the work
  area's own current end comes back one frame EARLY and one frame LONG.**
  [0..24] frames on a 3s/24fps comp, `workAreaStart = 1` -> [23..48].
  From any other state the same write is exact ([0..24] with start 0.5 ->
  [12..36]). Widening to the whole comp first makes every target exact,
  which is what `AELL_setWorkArea` now does: widen, start, duration.
- shortening `comp.duration` drags the work area in with it, silently;
  layer outPoints survive it.

Resolution is simpler and stricter: `[x, y]` whole numbers 1..99, both
elements required, non-uniform pairs legal ([1, 3] is fine), and a bare
number, a one-element array, a fraction, 0 and -1 each throw a different
raw message. So 'full'/'half'/'third'/'quarter' are names the tool
accepts and everything else is refused before AE is asked.

### The bug the suite found the moment it could ask the question

The new steps set a 1s-2s work area on the audio comp, convert inside it
(25 keys), let the default widen to the whole comp (73 keys), and then
ask AE what the work area is. It was **0.958s-2s**. `audio_to_keyframes`
has restored the user's work area since 5.7 with the naive triple
(`start = 0`, `duration = wasDur`, `start = wasStart`) - which is exactly
the collision above, every time the start equals the duration. One frame
earlier and one frame longer, silently, on every audio conversion over a
partial work area. Both it and `set_comp_setting` now go through
`AELL_setWorkArea`, and both stub suites reproduce the quirk: reverting
the host to the naive order makes `tests/test-audio-keyframes.js` fail on
"the user's work area is put back EXACTLY" (0.958333 / 1.041667) and
`tests/test-comp-settings.js` fail on the same shape. That is the loop
working end to end - field truth caught it, the stubs hold it.

### Also shipped in this pass

- `set_comp_setting` gained `workAreaStart` / `workAreaDuration` /
  `workAreaEnd` / `workArea: 'comp'` and `resolution`, reports `bgColor`
  and `changed`, speaks every snap and every quiet shortening (including
  AE's own drag when the comp is re-timed), and refuses an empty call
  with the whole menu of what it can set.
- `get_comp_details` now reports `workArea` and `resolution`: a setting
  the model can write has to be one it can read, or a narrowed work area
  is indistinguishable from a short comp.
- Three stub suites had comps without a `bgColor`, a work area or a
  resolutionFactor - properties every real comp has from birth. Made
  faithful rather than worked around in the host.

### Verification

- `tests/test-comp-settings.js`, new: 58 checks, opening with a STUB
  FIDELITY block that drives the raw API so a stub that stopped modelling
  the throws could not let the tool pass on a technicality.
- Full stub sweep: 47 files, all green.
- **Harness: 421 -> 437/437 PASSED** (and 436/437 on the run that found
  the work-area bug, which is why the entry above exists).

### Probe hazards, both paid for tonight

- An uncaught throw in a `-r` probe leaves AE on a modal and every later
  `-r` script is swallowed in silence - the same signature as the
  save-changes prompt. Harvested via WM_GETTEXT, it read "Unable to
  execute script at line NN. Object of type Error found where a Number,
  Array, or Property is needed", and WM_CLOSE cleared it. Worth knowing:
  **`e.toString()` on an AE-thrown error inside a probe's catch can
  itself throw that**, so a probe's catch should say as little as
  possible about the error object. Write every probe line to disk as it
  is measured (open, writeln, close) - a buffered file closed at the end
  loses everything a throw interrupts.
- The harness's own dialog triage then answered a leftover of exactly
  that kind on the next run, logged it as UNRECOGNISED with a screenshot,
  and carried on. It works.

### Still open

- Next on the feature track: 5.9 (.mogrt export), still flagged as a
  LAST-item-of-the-night job for dialog risk.
- `duplicate_comp` still takes a name without uniquing; no read-only
  `get_bounds`. Both still unclaimed.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.3 -
  sixth pass to flag it; it belongs to the remote session's release cut.
- Probe scratch under `logs/` (gitignored). AE left on the harness's own
  project, dirty, with no dialog open.

## 2026-08-29 (local) - duplicate_comp: the copy that could not be reached
## by the name it was given

Harness green on arrival (437/437), items 1-4 all closed by earlier
passes, so the pass took the oldest unclaimed shipped-behaviour item -
`duplicate_comp` "still takes a name without uniquing", flagged in three
separate entries and never picked up. The tool was five lines
(`comp.duplicate()`, `dup.name = String(args.name)`), and the probe found
that four of the things it was quiet about are AE's, not the tool's.

### What comp.duplicate() actually does, measured

`logs/probe-dup.txt` (AE 2026, 26.3x87):

- AE **names the copy itself**: "Src" -> "Src 2", the next one "Src 3".
  The tool never needs to invent a name.
- The copy lands in the **source's own folder**, at the project index
  directly after it (a root comp's copy stays at the root), and carries
  every comp setting with it - bgColor, resolutionFactor, work area,
  motionBlur, comment, markers, 4 ms for the whole thing.
- It does **not touch the project-panel selection**: the source stays
  selected, the copy is not. So unlike every layer-creating tool here,
  nothing needs restoring.
- **Layer SOURCES are shared, not copied.** The nested precomp, the
  solids, the footage are the SAME project items in both comps
  (`dup.layer(n).source === src.layer(n).source`). "Duplicate this comp
  and make the copy blue" edits the original too - and this panel ships
  `set_solid_color`, whose whole `makeUnique` argument exists for that
  trap.
- **Expressions are copied verbatim and nothing is rewritten.** A
  relative one (`thisComp.layer("A")`) correctly follows the copy;
  an absolute `comp("Src")` one still drives off the ORIGINAL, and
  `expressionError` stays EMPTY, so nothing else would ever mention it.
  Parenting IS remapped inside the copy.
- **The bug: `dup.name = <a name another item holds>` is ACCEPTED.** The
  project then has two items with that name and a by-name walk finds the
  OLDER one (measured), so the copy the model just made was unreachable
  by the name it just asked for. Same shape as the collision 5.4 found in
  precompose. A **blank** name is accepted too, leaving a comp with no
  name at all.

### What the tool does now

`AELL_uniqueItemName` grew an `except` argument (an item may keep the
name it already has, so asking for the name AE already gave the copy is a
no-op, not a bump to " 3"), and duplicate_comp auto-numbers + registers
the request-scoped comp alias exactly as create_comp and precompose do.
One deliberate exception, and it is the reason the alias needed thinking
about at all: **when the requested name is the SOURCE'S own** ("duplicate
Main and call it Main") the alias is NOT registered - later commands
saying "Main" still mean the comp it was copied from, and the result says
so. A blank name is refused before anything is duplicated. The result
also reports `folder`, `sharedSources` (each named as precomp/solid/
footage) with the consequence spelled out, and `stillDrivenBySource` for
the expressions AE left pointing at the original.

### Verification

- `tests/test-duplicate-comp.js`, new: 46 checks, opening with a STUB
  FIDELITY block that drives the raw API - a stub that stopped accepting
  the name collision would let the tool pass on a technicality.
- `tests/test-property-access.js` and the canned host in
  `tests/test-self-test.js` both modelled a duplicate with no
  parentFolder, no layers and no name rules. Made faithful rather than
  worked around in the host.
- Full stub sweep: 48 files, all green (capability doc regenerated).
- **Harness: 437 -> 446/446 PASSED**, nine new steps: the shared solid is
  named, the source's own name is auto-numbered and the original still
  answers to it, a blank name is refused, and the copy reports the
  expression still reading the original.
- Bumped 0.10.3 -> 0.10.4 (fix to shipped behaviour, verified in AE).

### One measurement that came back inconclusive

Probe B (`logs/probe-dup2.txt`) asked whether `duplicate()` is undone by
one Ctrl+Z, because probe A suggested it was not. It is not answerable
this way: the CONTROL - a plain `items.addComp` inside the same
begin/endUndoGroup - was not undone either, so `executeCommand(Undo)`
simply does not take effect on PROJECT ITEMS from inside a running `-r`
script. Nothing here is specific to duplicate_comp, and the shipped
rollback (which issues its Undo inside the same batch execution) was
verified on layers in 0.9.14. Worth a proper look by whoever next touches
rollback: if item creation really is outside its reach, a round that
created a comp and then failed is not fully rolled back.

### Still open

- Next on the feature track: 5.9 (.mogrt export), still flagged as a
  LAST-item-of-the-night job for dialog risk.
- No read-only `get_bounds` yet (unclaimed).
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - a small remote-session pass.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.4 -
  seventh pass to flag it; it belongs to the remote session's release cut.
- Probe scratch under `logs/` (gitignored). AE left on the harness's own
  project, dirty, with no dialog open.

## 2026-08-29 (local) - get_bounds: the measurement that used to cost you
## your anchor point

Harness green on arrival (446/446), so the pass took the oldest unclaimed
item in the log's own "still open" list - the read-only `get_bounds`
filed by the 0.9.31 pass on 2026-08-28 and re-flagged in eight entries
since. Until now the only route to a layer's rendered size was
`center_anchor_point`, which MOVES the anchor to tell you, so no step and
no chat request could ask "how wide is this text" without changing the
comp.

### What real AE measures, and what it lies about

Three probes (`logs/probe-bounds{,2,3}.txt`, AE 2026 26.3x87):

- `sourceRectAtTime` exists on every layer that draws pixels - solid,
  text, shape, null (100x100), adjustment, precomp - and does NOT exist
  at all on a camera or a light (`typeof` is undefined, so a call throws
  AE's raw "Function is undefined"). It needs BOTH arguments; one throws.
- It ignores the layer's own transform completely (position, scale,
  rotation, anchor - the rect is unchanged), ignores MASKS, and ignores
  even an expanding effect (a 200px drop shadow moves nothing).
- **THE TRAP: its time argument is the layer's own SOURCE time.** Every
  property time in AE scripting is COMP time and slides with the layer -
  a key at 2s reads 3s once startTime is 1, and 4s once the layer is
  stretched to 200% - but sourceRectAtTime's argument is unshifted by
  startTime and unscaled by stretch. Two clocks, one function call.
  `center_anchor_point` had been handing it `comp.time` since it shipped,
  so on any slid or stretched layer it centred the anchor on a frame the
  viewer was not showing. Fixed at the root with `AELL_sourceTime`, which
  get_bounds uses too.
- `extents: true` is a SHAPE thing: it grows the box by the stroke's
  MITER ALLOWANCE, not by half its width - a 40px stroke adds 100 on
  every side (half-width x (the default miter limit 4 + 1)), measured
  twice on different rects. On TEXT, extents changed nothing at all, even
  with a 20px stroke applied.
- Text is measured from the BASELINE, so a text rect's `top` is
  negative. An empty text layer and a shape layer with no drawn content
  both measure 0x0.
- **AE's own `sourcePointToComp` cannot be trusted once 3D is
  involved.** It agrees with hand-rolled 2D math exactly on 2D rigs
  (including through parenting, non-uniform scale and rotation - scale
  before rotation), but it ignores a 3D layer's Z entirely (z=0 and
  z=500 give the same answer), ignores the camera (moving it changes
  nothing), and ignores a 3D PARENT's rotation. It also samples at the
  comp's CURRENT time and takes no time argument. So the tool does the 2D
  math itself and refuses to invent a comp-space box for a 3D chain.
- Cost is nil: 200 rect reads 2 ms, 200 text extents reads 23 ms.

### The tool

`get_bounds {comp?, layer?, time?, extents?}` - read-only, no undo group,
no selection change. It returns the source rect (left/top/right/bottom/
width/height/centre), the comp-space box AND the four corners through the
whole parent chain, `compSize`, and `inFrame: fully|partly|outside` with
an `outsideBy` naming each side that overflows and by how many pixels. A
rotated layer gets `rotated` + a note that comp.width is the axis-aligned
box around it, not the layer's size. A slid or stretched layer gets
`sourceTime` + a note naming both clocks. A 0x0 layer gets `empty`
instead of a box of zeroes. A camera or light is refused with the list of
what DOES have bounds. A 3D chain gets the exact source rect, `comp:
null`, and `compBoxUnavailable` naming the 3D layer and why no honest
number exists. `{layers: [...]}` is refused with the way to do it
instead (it is classified read-only for for_each_layer, which would
throw every measurement away).

The system prompt gained the rule that pays for it: never assume how big
a layer's content is - "fit the title", "put it under the logo", "is it
cut off" all start with get_bounds.

### Verification

- `tests/test-get-bounds.js`, new: 51 checks, opening with a STUB
  FIDELITY block - the stub keys its rect by SOURCE time, throws on a
  one-argument call, and gives cameras no such method, so a tool that
  went back to comp time cannot pass. `tests/test-anchor-point.js`'s
  stub was made faithful the same way (it accepted any arguments and
  ignored them).
- `tests/test-self-test.js`'s canned host grew a bounds rig modelling
  AE's side (transforms, the parent chain, source time, the miter
  allowance), and its `shapeSeedLayer` now honours the size it is given
  instead of always seeding 10x10.
- Full stub sweep: 49 files, all green; capability doc regenerated.
- **Harness: 446 -> 477/477 PASSED**, 31 new steps in a comp of their
  own, including the source-time trap end to end (a shape whose Size is
  keyframed, slid two seconds, measured at comp 2s and 4s), the miter
  allowance, the frame test, the 3D refusal, the camera refusal and a
  read-back proving the anchor did not move.
- Bumped 0.10.4 -> 0.10.5: the pass fixes shipped behaviour
  (center_anchor_point's timebase). The new TOOL still rides the remote
  session's next minor.

### What the new steps found in a SHIPPED tool - next pass's item

**`set_layer_parent` moves the layer it parents.** The first version of
the parenting step asserted the box was unchanged by the link, because
`layer.parent = p` is AE's pick-whip and compensates (measured in probe
2: the child's Position became -100,-100 by itself). Real AE failed the
step: the box slid by exactly the null's position, [600,450] ->
[900,650]. The tool has the two calls the wrong way round -
`keepPosition !== false` selects `setParentWithJump`, which is AE's
JUMPING form - while its result still says "Visual positions preserved".
One line. It is NOT fixed here: four other rigs in the suite parent
things and the change moves the ground under them, so it deserves its own
pass rather than being smuggled into this one. The two bounds steps now
measure the link's result instead of assuming it, and say so in a comment.

### Still open

- **`set_layer_parent`'s inverted keepPosition (above) - take this
  first.**
- Next on the feature track: 5.9 (.mogrt export), still flagged as a
  LAST-item-of-the-night job for dialog risk.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - a small remote-session pass.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.5 -
  eighth pass to flag it; it belongs to the remote session's release cut.
- Rollback's reach over PROJECT ITEMS is still unmeasured (filed by the
  duplicate_comp pass).
- Probe scratch under `logs/` (gitignored). AE left on the harness's own
  project, dirty, with no dialog open.

## 2026-08-29 (local) - set_layer_parent had AE's two calls swapped

Harness green on arrival (477/477), so the pass took the item the
previous entry filed as "take this first": `set_layer_parent`'s inverted
`keepPosition`, spotted when a get_bounds step measured a link that was
supposed to move nothing and found the layer 300px away.

### What real AE does (probe `logs/probe-parent.txt`, AE 2026 26.3x87)

The two ways to set a parent do the OPPOSITE of what the names suggest,
and the tool picked the wrong one for its own default from the day it
shipped:

- **`L.parent = p` is the pick-whip.** AE REWRITES the child's transform
  so nothing moves on screen: a child at [400,300] under a parent whose
  layer origin sits at [50,50] reads back [350,250]. Not just Position -
  a 200%/45deg parent left the child at 50%/-45. Z included.
- **`L.setParentWithJump(p)` leaves every value alone**, so the layer
  JUMPS by the parent's transform.
- **Unparenting obeys the same rule.** `.parent = null` restores
  comp-space values; `setParentWithJump(null)` leaves the child sitting
  wherever the parent had been putting it. So the bug was not confined to
  linking - "unparent this without moving it" moved it too.
- **`.parent =` rewrites EVERY KEYFRAME, not just the current value.** A
  child with Position keys at [400,300] and [600,300] came back with
  [350,250] and [550,250]. Nothing told the model its numbers were gone.
- `setParentWithJump` exists on camera, light, text and shape layers, so
  the old `typeof` guard never actually fell through on this build.

### What the tool does now

The branches are swapped: `keepPosition` (the default) is `.parent =`,
`keepPosition:false` is `setParentWithJump`. The result reports
`keepPosition` and a note that names the CONSEQUENCE instead of the old
blanket "Visual positions preserved" - the honest version says AE rewrote
Position/Scale/Rotation into the parent's space and the old values should
be read back, with a separate wording for unparenting and for the jump.
`keyframesRewritten` names each layer whose keys AE just rewrote and how
many, and `keyframesNote` says the old numbers are gone. If a build ever
lacks `setParentWithJump`, `keepPosition:false` is now SKIPPED with the
reason rather than silently doing the exact opposite of what was asked.

### Verification

- `tests/test-layer-parent.js`, new: 47 checks, opening with a STUB
  FIDELITY block. The stub's `parent` setter does the real compensation
  arithmetic (current value and every key) and `setParentWithJump` does
  not, so the tests assert on WHERE THE LAYER ENDS UP - a tool that only
  reported the right thing cannot pass.
- `tests/test-property-access.js` actively asserted the BUG
  ("multi-layer parenting uses setParentWithJump") against a stub whose
  two calls were the same function. Both made faithful.
- `tests/test-self-test.js`'s canned host modelled only the default path
  and no keyframes; it now models both branches, the key rewrite,
  `set_keyframes`/`delete_layer` in the bounds rig, and `get_property`
  for Position.
- Full stub sweep: 50 files, all green; capability doc regenerated.
- **Harness: 477 -> 482/482 PASSED.** The bounds-rig step that filed this
  bug went back to being the assertion it wanted to be (the link does not
  move the box, centre 600,450), plus four new steps: the default link
  leaves the box where it was AND Position reads 200,200 instead of
  500,400; `keepPosition:false` jumps by exactly the parent's position and
  says JUMPED; a keyframed layer has both keys rewritten and is told so.
- Bumped 0.10.5 -> 0.10.6 (fix to shipped behaviour, verified in AE).

### The two steps this moved the ground under

As the previous entry predicted, the camera/light rig broke: "the
parented camera's transform is left to its parent" and its light twin
asserted LITERALS ([400,300,-800] / [400,300]) that were only right
because the old code jumped. Their real claim is that `scale_comp` does
not touch a parented layer's transform, so they now capture the Position
right after the link and assert scale_comp left THAT unchanged. Stronger
than the literal was, and it no longer encodes which parenting call was
used. The other three parenting sites in the suite (grid rig, precompose
rig, anchor rig) set their keyframes after the link or assert on names,
so nothing there needed touching.

### Still open

- Next on the feature track: 5.9 (.mogrt export), still flagged as a
  LAST-item-of-the-night job for dialog risk.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - a small remote-session pass.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.6 -
  ninth pass to flag it; it belongs to the remote session's release cut.
- Rollback's reach over PROJECT ITEMS is still unmeasured (filed by the
  duplicate_comp pass).
- Not measured here: whether `.parent =` compensation survives a child
  that is 3D under a 2D parent, or a parent with a keyframed transform.
  The probe covered 3D-under-3D only.
- Probe scratch under `logs/` (gitignored). AE left on the harness's own
  project, dirty, with no dialog open.

## 2026-08-29 (local) - the rollback reaches project items; its own
## check could not see them (0.10.7)

Harness green on arrival (482/482), so the pass took the oldest thing on
the still-open list rather than the next feature: "Rollback's reach over
PROJECT ITEMS is still unmeasured", filed by the duplicate_comp pass and
re-filed by three entries after it. 5.9 (.mogrt) is still deferred by its
own rule - LAST item of any night, and at 03:20 with the loop still
running there would have been another pass behind this one to wedge.

### The question that was filed, answered: it reaches

`logs/probe-rollback-items.txt`, AE 2026 26.3x87. Probe B of the
duplicate_comp pass had suggested `executeCommand(16)` simply does not
take effect on project items from inside a running `-r` script, because
its CONTROL - a plain `items.addComp` in a begin/endUndoGroup - was not
undone either. That is wrong, and the control is what was wrong with it.
Six shapes, all in one execution:

- `items.addComp` inside a group: **undone.**
- comp + layer in ONE group: **both undone** by the single Undo.
- `comp.duplicate()`: **undone.**
- `items.addFolder`: **undone** (this is the sentinel's own fallback).
- `item.remove()`: the item **comes back.**
- layer control: undone, as 0.9.14 documented.

Then the SHIPPED path, seven armed rounds through `AELL_callBatch`
(`logs/probe-rollback-items2.txt`): create_comp, create_comp+add_solid,
create_folder+move_to_folder, delete_item, duplicate_comp and
rename_item each paired with a failing mutating command. Every one came
back `rolledBack:true` with the item gone (or restored, for the delete
and the move), and the all-succeeding control was correctly left alone.
16-67 ms per round. Nothing needed fixing here.

### What the probe found instead: the check was blind in 21 places

`AELL_fingerprint` exists to prove the one Undo landed EXACTLY on the
pre-round state - and it is the only guard against the Undo overshooting
past our group into the user's own last edit, which is the hazard the
sentinel and the single-Redo rule are both built around. Probe 3
(`logs/probe-rollback-items3.txt`) wrote 25 dimensions that a tool in
`AELL_MUTATING` can write, undid each with one Undo, and asked two
questions per dimension: did the value come back, and did the
fingerprint move.

**AE reverted all 25. The fingerprint saw 4** - name, enabled, comment,
and a text layer's source string. The blind 21:

- **Every comp setting**: bgColor, resolutionFactor, workAreaStart,
  workAreaDuration, pixelAspect, displayStartTime, motionBlur,
  shutterAngle, frameBlending, hideShyLayers. `set_comp_setting` writes
  five of those by name.
- **Comp markers and layer markers** (`add_marker`).
- **Every layer switch**: threeDLayer (`set_layer_3d`), blendingMode,
  shy, locked, motionBlur, adjustmentLayer, audioEnabled.
- **The 3D-only rotations**: Rotate X, Rotate Y, Orientation - which is
  exactly what `set_layer_3d` was documented in 0.9.25 as discarding.
- **The solid SOURCE's colour** (`set_solid_color`). It lives on the
  project ITEM, so no walk of a comp's layers could ever have seen it.
- **A text layer's fontSize/font/tracking/justification**
  (`set_text_style`, which never touches `.text`, the one text field the
  fingerprint did record).

Nothing was being left in anyone's project today: AE's Undo is better
than the check watching it. But the check had nothing to check. A
rollback that half-landed would have reported itself clean, and an
overshoot that ate the user's last edit was invisible whenever that edit
was a switch, a work area or a background colour - the common case.

### The fix

`AELL_fingerprint` and `AELL_layerSig` now record all of it, via two new
helpers. `AELL_sigOf(obj, key)` reads one switch and turns a build that
lacks it, or an object that refuses it, into a STABLE absence - a camera
has no `adjustmentLayer`, and a throw part-way through a concatenation
would silently drop every field behind it and, worse, move the
fingerprint from one read to the next. `AELL_markerSig` records the key
TIMES as well as the count, because `add_marker` was measured in 5.4
REPLACING a marker already at that time - a count alone calls that a
no-op. It is capped at 50 so a heavily marked comp cannot make the
verification the expensive half of a round.

Cost, measured on the harness's own 338-item project: one fingerprint
was 11031 chars in 6 ms before. The arming round pays one of these.

### Verification

- `tests/test-round-rollback.js`: 48 -> 121 checks. The stub grew all 23
  dimensions as real, undoable state, and each gets both halves - written
  normally the round must roll back CLEAN (which is what fails if the
  widened fingerprint ever starts reading noise), and written as a TORN
  change the undo stack cannot reverse, the round must be reported as NOT
  rolled back. Before the fix every torn half reported `rolledBack:true`
  over a change still sitting in the project. Plus a byte-stability check
  and a layer that THROWS on all eight switches, asserting each refusal
  reads as `?` in place rather than truncating the signature.
- One stub bug found on the way: the sentinel-fallback test emptied
  `project._items` and pushed back only the comp, so the footage item was
  silently gone for every test after it.
- `tests/test-self-test.js`'s canned host modelled an Undo over LAYERS
  only, so an item-level rollback step could pass while nothing was
  rewound. It now snapshots and restores the created comps, the create
  counter, comp settings and the makeUnique solids, and it tracks the
  rollback comp by its CURRENT name - a substring match on "Rollback"
  lost the comp exactly when a step renames it, and every tool aimed at
  it started succeeding, which is the one answer that makes the step
  vacuous.
- Full stub sweep: 50 files green; capability doc regenerated.
- **Harness: 482 -> 490/490 PASSED**, twice consecutively. Eight steps:
  a round that created a comp and failed leaves no comp; a round that
  changed the work area and preview resolution puts both back (read back
  through get_comp_details); a round that turned a layer 3D AND added a
  marker AND recoloured its solid with makeUnique rolls all three back
  (get_bounds stops calling it a 3D layer); a round that renamed the comp
  leaves it answering to its old name. A suite step cannot make a torn
  write, so these own the OTHER risk the widening created - a field AE
  reports with noise would make every rollback in the product report
  itself as an abandoned overshoot, and each of these fails loudly if
  that ever starts.
- Bumped 0.10.6 -> 0.10.7 (fix to shipped behaviour, verified in AE).

### One thing this pass caused and cleaned up

The first harness run after the change was 489/490: the hygiene step that
asserts a grounded "Comp not found" listed the six PRBI comps my own
probes had left in the harness project. Not a regression - probe debris.
Removed with `logs/probe-cleanup.jsx`, and both runs after that were
490/490. Worth remembering: probe rigs that outlive their pass are read
by any suite step that quotes the project's contents back.

### Still open

- What is NOT fingerprinted, deliberately, and why it is a limit rather
  than a bug: arbitrary PROPERTY values beyond the transform basics
  (Position/Scale/Rotate Z/Opacity/the 3D rotations) and effect/mask
  COUNTS. Covering them means a per-layer tree walk on every armed round,
  which is the one cost this check cannot afford. A `set_effect_param`
  round that half-undid would still be reported clean.
- Two same-named folders are indistinguishable to it: `parentFolder` goes
  in by NAME, so a `move_to_folder` between homonyms is invisible. Cheap
  to close with the item id; not measured here, so not done here.
- Next on the feature track: 5.9 (.mogrt export), still flagged as a
  LAST-item-of-the-night job for dialog risk. Tenth pass to defer it -
  worth the remote session deciding whether that rule can ever fire under
  a loop that always starts another pass.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - a small remote-session pass.
- Not measured here: whether `.parent =` compensation survives a child
  that is 3D under a 2D parent, or a parent with a keyframed transform
  (filed by the previous pass).
- Probe scratch under `logs/` (gitignored). AE left on the harness's own
  project, dirty, with no dialog open, and with this pass's PRBI rigs
  removed.

## 2026-08-29 (local) - "nothing moved" was only ever true at one frame
## (0.10.8)

Harness green on arrival (490/490), so the pass took the oldest thing the
open list carries: the question the set_layer_parent pass filed about its
own fix - "not measured here: whether `.parent =` compensation survives a
child that is 3D under a 2D parent, or a parent with a keyframed
transform. The probe covered 3D-under-3D only." Both halves are measured
now. The first survives. The second does not, and the tool had been
promising it since the day it shipped.

### The probe (`logs/probe-parent2.txt`, AE 2026 26.3x87)

Nine rigs, each measured the only honest way: a probe null carrying
`thisComp.layer("X").toComp([0,0,0])` as its Position expression, read
back with `valueAtTime` at several times, so the question is always
"where do the pixels land" and never "what does the tool say".

**Mixed dimensions: compensation holds.**

- A 3D child under a 2D parent stays put (world 394.16,276.79 ->
  393.85,275.56 - AE re-decomposes the parent's 2D rotation into the
  child's Orientation, [10,20,30] -> [18.65,12.39,359.73], and the
  round trip costs about a pixel). The Z is NOT touched: a 2D parent
  leaves 200 at 200. Worth stating plainly because turning the 3D switch
  off zeroes exactly that number, and the two look alike from outside.
- A 2D child under a 3D parent does not move either, and the reason is
  that the parent's Z and Y-rotation never reach it at all: the
  compensation is a pure X/Y translation by the parent's `position -
  anchor`. Rig I, a parent moved ONLY in Z, still rewrote the child's
  Position by the parent's X/Y and left the picture where it was.

**An animated parent: the promise breaks, and nothing said so.**

- (D) A STILL layer parented to a 2-key parent: world 360 at every time
  before, and 360 / 560 / 760 at t=0/1/2 after. It sat still at exactly
  one frame and was 400 px away two seconds later.
- (E) A KEYFRAMED child under the same parent: 360/460/560 became
  360/660/960. Not an offset - its speed doubled. The tool's existing
  `keyframesNote` says the old numbers are gone; it never said the
  MOTION was gone.
- (F) A parent driven by an EXPRESSION does the same with ZERO
  keyframes, which is precisely what the key-count accounting cannot
  see.
- (G) The compensation lands on the PLAYHEAD. The same rig parented at
  t=1 instead of t=0 came out with different numbers and a different
  frame left standing still (160/360/560). The tool never set comp.time,
  so the same call gave different results depending on where the user
  had left the playhead - and the model has no way to know where that
  was.
- (H) Unparenting is the same class: a layer riding an animated parent
  keeps only the position it had at that one frame (360/560/760 ->
  360/360/360) and silently loses the motion.

### The fix

`set_layer_parent` still does the same two AE calls; what changed is that
it no longer claims more than AE delivers.

- `AELL_animatedXform` reports which transform properties MOVE -
  keyframes or expression, so rig F is visible - and `AELL_movingChain`
  asks it of the parent AND everything above it, because a still parent
  bolted to a moving grandparent moves in comp space just the same.
- `parentAnimated` names them; `parentAnimatedNote` says the link is NOT
  jump-free across the timeline, names the frame it IS true at, and adds
  the E sentence when the child has keys of its own. Unparenting gets its
  own wording about the motion it just took away.
- `compensatedAt` is reported on every keep-position call, including the
  quiet ones, and says whether the frame came from the caller or from the
  playhead. A tool whose result depends on invisible state should say
  what that state was.
- New `atTime` / `atFrame`: set the playhead, parent, put it back. This
  is the only way to ask for "don't move AT THE START of the animation"
  rather than "don't move wherever the user happens to be parked".
  Refused with the comp's range when out of bounds, refused when combined
  with `keepPosition:false` (there is no frame to compensate at), refused
  with the value when not a number.

Deliberately NOT done: no refusal on an animated parent, and no attempt
to bake the parent's motion into the child. The user asked for a link;
AE's answer is a legitimate one. The house rule is that nothing
disappears quietly, not that the tool second-guesses the ask.

### Verification

- `tests/test-layer-parent.js`: 47 -> 89 checks. The stub's fidelity block
  grew the part that made this bug invisible - `valueAtTime` on every
  property, an `_originInComp(t)` that answers "where does it draw AT A
  TIME", and a `parent` setter that takes its offset from the parent's
  value at `comp.time` ONCE. So the tests assert the layer is at x=400 at
  the compensation frame and at x=800 two seconds later; a tool that only
  printed the right warning cannot pass them. Eight new groups: animated
  parent, still parent (says nothing), expression-only parent, moving
  GRANDparent, atTime/atFrame pinning (including that the playhead is put
  back), the three refusals, unparenting, and a keyed child told its
  motion changed.
- `tests/test-self-test.js`'s canned host modelled the bounds rig with no
  notion of time and no Z at all, so it could not have run any of the new
  suite steps. It now has `bnPosAt` (keyframed position, linear), a
  time-aware `bnXform`/`bnCompPoint`/`bnBounds`, a Z that only passes
  between two 3D layers, and the compensation-at-a-frame rule with its
  refusals.
- Full stub sweep: 50 files green; capability doc regenerated.
- **Harness: 490 -> 498/498 PASSED**, twice consecutively, every new step
  green on its first real-AE run - which is the interesting part, since
  the steps assert exact numbers (450 at the pinned frame, 850 two
  seconds later, 50 at the frame that gives way, Position [300,200,200]
  under a 2D parent, [0,0] under a 3D one). Real AE agreed with all of
  them. Eight steps: the moving-parent rig, the animated link and its
  warning, `atFrame` picking the frame, the default playhead path
  (asserted playhead-agnostically - the layer must simply travel), the
  unparent, the out-of-range refusal, and the two mixed-dimension pins.
- Bumped 0.10.7 -> 0.10.8 (fix to shipped behaviour, verified in AE).

### Still open

- The ~1 px drift when a 3D child is parented to a ROTATED 2D parent
  (394.16,276.79 -> 393.85,275.56). It is AE's own matrix-to-Orientation
  decomposition, not this panel's arithmetic, and nothing here can fix
  it. Not pinned in the suite because the exact numbers are AE's to
  change; recorded here so the next pass does not re-discover it as a
  bug.
- Next on the feature track: 5.9 (.mogrt export), still flagged as a
  LAST-item-of-the-night job for dialog risk. Eleventh pass to defer it.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - a small remote-session pass.
- `release-notes.txt` still reads "0.10.0" while the feed now ships
  0.10.8 - tenth pass to flag it; it belongs to the remote session's
  release cut.
- Rollback's two stated limits are unchanged: arbitrary property values
  beyond the transform basics, and folders that share a name.
- Probe scratch under `logs/` (gitignored); the probe removed its own
  PPAR2 rig. AE left on the harness's own project, dirty, with no dialog
  open.

## 2026-08-29 (local) - item 6.1 Pass A: whisper.cpp acquired, and the
## release nobody was choosing

**Item:** 6.1 Pass A - acquire a prebuilt whisper.cpp Windows binary plus
the ggml-base.en model the way `get-llama.ps1` does llama-server, and
verify it runs on a WAV.

Picked because the harness was already green (498/498 before any change),
items 2-5.8 are struck, and 5.9 (.mogrt) is gated by its own rule to the
LAST item of a night - twelfth pass to defer it, and the first one to say
so while actually moving the item behind it.

### What shipped

- `scripts/lib/whisper-assets.ps1` - WHICH file to take. Split out for
  the same reason `ae-dialog-triage.ps1` is: the acquirer is PowerShell,
  so the decision has to live somewhere a Node test can drive it without
  a network or a 640 MB download.
- `scripts/get-whisper.ps1` - the I/O half. `-Variant cpu|blas|cublas`,
  `-Tag`, `-Model`, `-SkipModel`, `-SkipVerify`.
- `tests/test-whisper-acquire.js` - 43 checks, no network.

### Probe facts, and the four that break the obvious implementation

1. **The newest tag is not the one with the files.** On 2026-08-29
   `ggml-org/whisper.cpp`'s newest release is `v1.9.3` - a PRERELEASE
   with ZERO assets, published six minutes AFTER `b4938`, which carries
   all nine. `/releases/latest` happens to skip prereleases, but an
   asset-less normal release would sail through it, so the choice walks
   the release LIST and takes the first that actually has a build.
2. **The archive is not flat and `main.exe` is a decoy.** Everything
   sits under `Release\`, and `main.exe` is 27 KB - a deprecation shim.
   The transcriber is `whisper-cli.exe` (479 KB). "Find main.exe" finds
   the stub. The zip also ships `whisper-server.exe`, which is the same
   HTTP-server shape as llama-server and may matter for Pass C.
3. **The models are under `ggerganov`, not `ggml-org`.** llama.cpp moved
   to the ggml-org org and the whisper REPO moved with it, so
   `ggml-org/whisper.cpp` is the natural guess for the weights too.
   Measured: it answers **HTTP 401**, not 404 - which reads like a token
   problem and sends you looking in the wrong place entirely.
   `ggerganov/whisper.cpp` answers 200, 147 964 211 bytes.
4. **`Invoke-RestMethod` does not enumerate a JSON array.** It emits ONE
   object that IS the array. So `@(Invoke-RestMethod .../releases)` is a
   one-element array holding all 15 releases.

### The bug (4), and why it looked green

The first version of `get-whisper.ps1` wrote exactly that `@()`. Its
`foreach` therefore ran ONCE with `$r` bound to the whole list, and
PowerShell's property flattening turned `$r.assets` into every asset of
every release pooled together. It found a real `whisper-bin-x64.zip` in
that soup - from no particular release - downloaded it, extracted it,
transcribed the WAV correctly and printed `Verify: PASS`.

The only symptom was six characters in one log line: `Release:
System.Object[]`. The walk that exists to skip the asset-less prerelease
had never executed at all, and the version actually installed was
whichever release's asset happened to sort first.

Fixed with `Expand-AellReleaseList`, which flattens whatever shape it is
handed and runs INSIDE the choice so nothing can reach the walk without
it. It emits its result WITHOUT a leading comma on purpose: `return
,$out` hands back a single object that IS the array, and the caller's own
`@()` then re-wraps it into one element - the exact nesting being undone.
That mistake was made and caught here too.

Three more found by writing the test, each a silent wrong answer:

- **`[version]` pads with -1, not 0.** `[version]'11.8'` compares LESS
  than `[version]'11.8.0'`, so a driver reporting `11.8` REJECTED the
  `whisper-cublas-11.8.0` build made for it and fell through to "no
  compatible build". Both sides are now padded to three parts.
  (`get-llama.ps1` pads to two and has the same latent trap; its assets
  are `12.4`-shaped so it does not bite today. Flagged, not touched.)
- **An empty JSON asset list yields `$null`, and `@($null)` has Count
  1.** The grounded error printed `Looked at: v1.9.3 ()` instead of
  saying the release had no assets.
- **This machine's nvidia-smi says `CUDA UMD Version: 13.4`**, not
  `CUDA Version:` (driver 616.56, RTX 5090). The regex every script here
  greps with - `get-llama.ps1` included - matches NOTHING, and the caller
  silently loses its driver ceiling. `Get-AellCudaVersionFromSmi` reads
  both spellings; after the fix the cublas dry-run resolves 13.4 and
  picks `whisper-cublas-12.4.0-bin-x64.zip` from `b4938`.

### Decisions taken (no human awake to ask)

- **Default variant is CPU.** base.en does 3 s of speech in ~820 ms on
  this machine, and the CUDA build is a 640 MB download whose VRAM would
  come out of the same budget the tier arbiter in `tools.js` rations
  between the chat model and ComfyUI. `-Variant cublas` is there for
  anyone who wants to spend it; Pass C can revisit if captions turn out
  to be slow on long comps.
- **`bin\` and `models\` are separate folders.** `get-llama.ps1` clears
  its whole vendor folder because a llama.cpp build IS the download; here
  an 8 MB binary update must not cost the 141 MB model. Re-running wipes
  only `bin\`. Verified: two re-acquisitions, model untouched both times.
- **The model downloads to `.part` and is renamed on completion**, so an
  interrupted download cannot look acquired on the next run and fail at
  load instead.
- **Scope held to Pass A.** The verify step synthesizes its WAV with
  System.Speech at 16 kHz mono 16-bit (whisper refuses anything else)
  because Pass A has to run on *a* WAV and there is no sample in the zip.
  Pass B still owns making that a skip-when-absent stub test; this is the
  one-shot version of it, inside the acquirer.

### Verification

- `node tests/test-whisper-acquire.js`: 43 checks, all green. The
  assertions are about the RELEASE an asset came from, not just about
  finding an asset - a test that only checked "we picked
  whisper-bin-x64.zip" passes on the broken version. The nested shape is
  reproduced explicitly (`WRAPPED_COUNT=1`) and the chosen asset is
  pinned BY SIZE, so a flattening regression that reorders the pool lands
  on v1.9.2's asset and is caught. Release lists and the nvidia-smi
  banner are captured verbatim from this machine.
- Full stub sweep: all 51 test files exit 0. CI globs `tests/test-*.js`,
  so the new suite is picked up with no workflow change.
- Real end-to-end run, three times: acquire -> extract -> model ->
  synthesize -> transcribe. Transcript exact, `Verify: PASS`, 818 ms and
  829 ms. `Release: b4938` now prints a tag.
- **Harness: 498/498 PASSED**, before and after. Nothing in `extension/`
  was touched.
- Capability doc still fresh (no new tools).

### No version bump

Deliberate. The panel ships `extension/` alone and this pass added only
`scripts/` and `tests/` - there is no shipped behaviour for a feed to
carry. Same call as the 2026-08-28 harness-dialog-triage pass.

### Still open

- **`get-llama.ps1` has two of the same latent traps**: it greps for
  `CUDA Version:` (misses this machine's `CUDA UMD Version:`, so the
  driver ceiling silently stops applying) and pads versions to two
  parts. Neither bites today - the compute-cap rule still runs and its
  asset names are `12.4`-shaped - so it was left alone rather than
  widening a one-item pass. Small remote-session job, or the next local
  pass that has nothing better.
- 6.1 Pass B is now unblocked and is the natural next item on this track.
  Pass C follows B; 5.5 landed, so nothing else blocks it.
- 5.9 (.mogrt export) still deferred by its own LAST-item-of-the-night
  rule. Twelfth pass. If the queue ahead of it keeps emptying, someone
  should decide whether that rule means "last pass of a night" or "never".
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.8 -
  eleventh pass to flag it; remote session's release cut.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - small remote-session pass.
- Machine state: AE left on the harness's own project, no dialog open.
  `%APPDATA%\AE-Llama\vendor\whisper.cpp` now holds the CPU build and
  ggml-base.en (149 MB total) - new, and not cleaned up, because Pass B
  needs it.

## 2026-08-29 (local) - item 6.1 Pass B: the verification that would have
## passed on silence

**Item:** WORKPLAN 6.1 Pass B - a whisper.cpp verification harness with
no human audio: speak a phrase with the OS synthesizer, transcribe it,
assert the phrase came back, and make it a stub-level test that skips
cleanly where there is no binary (CI has none).

Harness green at 498/498 before the pass, so item 1 was satisfied and
Pass B was the top unfinished item - Pass A landed earlier tonight and
Pass C is explicitly blocked behind it.

### What shipped

- **`scripts/lib/whisper-verify.ps1`** - the round-trip, split out the
  same way `whisper-assets.ps1` holds the download choice.
  `Find-AellWhisperInstall`, `ConvertTo-AellWhisperText`,
  `Test-AellPhraseHeard`, `New-AellSpokenWav`, `Invoke-AellWhisperCli`,
  `Get-AellWhisperCliError`, `Invoke-AellWhisperCheck`,
  `Invoke-AellWhisperVerify`.
- **`scripts/verify-whisper.ps1`** - run it standalone. Exit 0 on pass
  AND on "not installed" (prints SKIP), 1 on a failed phrase, 2 when
  `-Require` turns a missing install into a failure.
- **`get-whisper.ps1`'s verify step now calls the shared check** instead
  of carrying its own copy. That was the point of splitting it: two
  copies drift, and the one that ships is whichever the user ran.
- **`tests/test-whisper-verify.js`** - 52 checks, 49 of which need no
  install at all.

### Five things the machine said that the obvious version gets wrong

1. **Two seconds of digital silence transcribes as " You".** Not `''`,
   not `[BLANK_AUDIO]` - a plain, confident word. Every "did it work?"
   check that asserts the transcript is non-empty therefore PASSES on a
   file with no speech in it, which is the exact failure a verification
   harness exists to catch. The assertion has to be the SPOKEN PHRASE.
   Pinned by `OUT_SILENCE` in the test.
2. **Draining stdout before waiting on the process hangs forever.**
   whisper-cli writes ~6 KB to stderr (backend banner, plus its whole
   usage screen on any argument error) and NOTHING to stdout when it
   fails. `StandardOutput.ReadToEnd()` blocks until the child exits; the
   child blocks writing into a full stderr pipe; neither moves. Measured
   as a five-minute wall-clock timeout with both processes alive - the
   symptom is total silence, which reads like a slow model rather than a
   bug in the caller. Both pipes are now read asynchronously with a hard
   timeout on top. Regression-tested WITHOUT the binary by compiling a
   stand-in console exe on the spot (`Add-Type -OutputAssembly`) that
   writes 200 KB to stderr and exits 7; on the broken implementation that
   case never returns.
3. **base.en writes numbers as digits, and the synthesizer's "pack" is
   heard as "hack".** The first phrase list included "pack my box with
   five dozen liquor jugs" and it came back as "hack my box with 5 dozen
   liquor jugs" - two independent failures in one line. A verification
   phrase is a FIXTURE: one the model gets wrong tests nothing but
   itself. All three defaults are now measured-exact, and the test
   asserts no default phrase contains a number word.
4. **44.1 kHz audio transcribes fine.** The note in the code this
   replaced said whisper "refuses anything but 16 kHz mono 16-bit". It
   does not - a 44 100 Hz mono WAV (header read back to confirm it really
   was 44 100) transcribed correctly, exit 0. It resamples. Corrected in
   place, and it matters for Pass C: comp audio out of the render queue
   does not need converting first.
5. **`-like "*$phrase*"` is a wildcard match, not a contains.** The code
   being replaced compared that way. A phrase holding `*` matches almost
   anything and reports PASS for audio nobody spoke; a phrase holding `[`
   opens a character class and never matches. Now literal `.Contains()`
   on normalized text, with both traps as test cases.

### The negative control

Every phrase check only ever asks the comparison to say YES, so a
`Test-AellPhraseHeard` that returned `$true` unconditionally - or a
normalizer that reduced both sides to `''` - would report a perfect score
on a broken install. The runner now also asserts that phrase 2 is NOT
heard in the recording of phrase 1. It reuses text already transcribed,
so it costs nothing, and a harness that cannot fail proves nothing.

### Verification

- `node tests/test-whisper-verify.js`: 52 checks green with the install
  present. Re-run with `APPDATA` pointed at an empty folder to model a CI
  runner: 49 green, 3 skipped, exit 0 - the skip path is measured, not
  assumed.
- `node tests/test-whisper-acquire.js`: 3 assertions in it pointed at the
  verify block that moved. Rewritten to assert the opposite and stronger
  thing - that the acquirer dot-sources the shared library and carries NO
  second copy of the synthesizer or the comparison. Green.
- Full stub sweep: all 52 test files exit 0.
- `scripts\verify-whisper.ps1`: 4/4 PASSED against the real install
  (~680 ms per phrase, base.en, CPU). Skip and `-Require` paths exercised
  against five fabricated trees - missing root, wrong exes, no model,
  named model absent - each answering with a grounded reason that lists
  what IS there.
- `scripts\get-whisper.ps1` re-run end to end after the refactor:
  re-downloaded the 8 MB build, kept the 141 MB model, `Verify: PASS` in
  837 ms.
- **Harness: 498/498 PASSED**, before and after. Nothing in `extension/`
  was touched.

### No version bump

Deliberate, same call as Pass A and the 2026-08-28 harness-dialog pass:
the panel ships `extension/` alone, and this pass added only `scripts/`
and `tests/`. There is no shipped behaviour for a feed to carry.

### Still open

- **`get-llama.ps1` still has the two latent traps Pass A flagged**: it
  greps for `CUDA Version:` (misses this machine's `CUDA UMD Version:`,
  so the driver ceiling silently stops applying) and pads versions to two
  parts. `Get-AellCudaVersionFromSmi` and `ConvertTo-AellPaddedVersion`
  in `whisper-assets.ps1` are the fixes, already written and tested -
  this is a small pass that points get-llama at them.
- 6.1 Pass C (AE wiring: `transcribe_to_captions`) is now unblocked and
  is the natural next item. 5.5 landed, so nothing else blocks it. Note
  for whoever takes it: `Invoke-AellWhisperCli -Timestamps` already
  exists and is unused, and comp audio at 48 kHz needs no conversion
  (finding 4).
- 5.9 (.mogrt export) still deferred by its own LAST-item-of-the-night
  rule. Thirteenth pass. Someone should decide whether that rule means
  "last pass of a night" or "never".
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.8 -
  twelfth pass to flag it; remote session's release cut.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - small remote-session pass.
- Machine state: AE left on the harness's own project, no dialog open.
  `%APPDATA%\AE-Llama\vendor\whisper.cpp` holds the CPU build and
  ggml-base.en (149 MB), left in place because Pass C needs it. Temp
  WAVs and the compiled stand-in exe are removed by the code that makes
  them.

## 2026-08-29 (local) - item 6.1 Pass C: captions, and the pipeline whose
## failure mode is a confident wrong answer

**Item:** WORKPLAN 6.1 Pass C - AE wiring for local captions. Render a
comp's audio, transcribe it with timestamps, put the segments on the
timeline as text layers or markers: `transcribe_to_captions`.

Harness green at 498/498 before the pass, so item 1 was satisfied. Pass C
was the top unfinished item: A and B landed earlier tonight, 5.5 (the
render queue) landed 2026-08-28, and nothing else blocked it.

### What shipped

Three tools, split so the two ends can be tested where the middle
cannot:

- **`render_comp_audio`** (host) - renders ONLY the comp's audio, picking
  an audio-only output module itself. Refuses a comp with no audio layer,
  or one whose audio layers are all muted, naming what IS there. It
  DELEGATES the render to `render_comp` rather than carrying a second
  copy of the hold-back / overwrite-refusal / extension-forcing logic.
- **`add_captions`** (host) - one text layer per segment trimmed to its
  own span, or one marker per segment with `{as: "markers"}`. Every
  segment is validated BEFORE anything is created. In `AELL_MUTATING`
  (one Ctrl+Z), and in `AELL_PER_LAYER` for for_each_layer.
- **`transcribe_to_captions`** (PANEL) - the only one the model calls.
  It has to be panel-side: the middle step is a child process, which
  ExtendScript cannot spawn.
- **`extension/js/whisper.js`** - finds the install under
  `<dataRoot>\vendor\whisper.cpp`, runs whisper-cli, parses the
  timestamped output into segments. Independent of
  `scripts\lib\whisper-verify.ps1` on purpose: the panel cannot shell out
  to PowerShell for every caption.

### Six things real AE and the model said that the obvious version gets wrong

1. **A comp with NO audio renders a full, valid, audio-only AIFF.**
   Status DONE, 772 674 bytes, no warning of any kind. And two seconds of
   silence transcribes as the word "You" with exit code 0 (Pass B's
   finding, from the other end). So the honest-looking end of the obvious
   pipeline is a caption layer reading "You" over a comp nobody spoke in,
   and every step of it reports success. Nothing downstream can tell that
   file apart from a real one, so the refusal has to happen BEFORE the
   render. That is the load-bearing suite step, and the panel tool also
   refuses the "You" shape if a silent LAYER gets past it.
2. **`layer.inPoint` is a SLIDE, not a trim.** It drags outPoint with it
   and preserves the duration: a fresh text layer in a 5 s comp reads
   in=0 out=5, and after `inPoint = 2` it reads in=2 **out=7**. Set out
   before in and every caption is the wrong length, in silence. In is now
   always set first, and the suite asserts the resulting spans rather
   than trusting the call.
3. **An inverted span is accepted without a word.** in=2 then out=1 reads
   back in=2 out=1 - a layer of negative duration that never appears on
   the timeline. Zero-length (in=1, out=1) too. Both are refused by
   `add_captions` and dropped by the parser, because whisper does emit
   the occasional `0.000 --> 0.000` line.
4. **in/out QUANTIZE to AE's internal time base, not the frame grid.**
   0.3333 reads back 0.33329264322917; 1.7777 reads back
   1.7777099609375. Every comparison in the tests and the suite is a
   tolerance. An equality assertion here would have looked right and
   failed on the machine.
5. **whisper.cpp reads AE's AIFF directly.** stderr says "trying to
   decode with miniaudio" - a 964 674-byte stereo 48 kHz AIFF straight
   out of the render queue transcribed in 682 ms, exit 0. So there is no
   conversion step, no WAV rewrite, and 6.2 (ffmpeg) is NOT a
   prerequisite for captions. This is the finding that shrank the pass.
6. **The audio format comes from the TEMPLATE, not from the API.**
   `om.getSettings(GetSettingsFormat.STRING)` throws ("Object of type
   Object found where a Number, Array, or Property is needed") and
   `om.setSettings({Format: "WAV"})` answers "Invalid Value for key:
   <Format>. Property is read-only". So the module is matched by NAME
   against the installed list (word-bounded, WAV preferred over AIFF over
   MP3, never an `_HIDDEN` internal), and a machine with no audio module
   gets a grounded refusal listing what it does have. This machine ships
   exactly one: "AIFF 48kHz".

### The end-to-end run

The suite cannot transcribe - that needs a ~150 MB install no CI runner
has - so the round trip was driven by hand in real AE with the shipped
code: 20 s comp of synthesized speech -> `render_comp_audio` (0.1 s,
3 844 674 bytes, "AIFF 48kHz") -> whisper-cli (1053 ms, five segments)
-> `Whisper.parseSegments` -> `add_captions`. Result: five text layers
spanning 0-3.32, 3.32-6.24, 6.24-9.90, 9.90-13.28, 13.28-15.92, every
one within quantization tolerance of the transcript. That is fact 2
proved on the machine rather than argued.

### Verification

- `node tests/test-captions.js`: 115 checks, green. Seven of them are
  STUB FIDELITY checks that drive the raw API first, so a stub that
  stopped modelling the inPoint slide cannot let the fix pass on a
  technicality. It builds a real (tiny) whisper tree in %TEMP% to prove
  the walk, the smallest-model rule and the three grounded refusals.
- Two existing suites caught the new code before I did, which is what
  they are for: `test-for-each-layer` refused an unclassified layer tool,
  and `test-chat-probe` refused a `global.Whisper` that mapped to no
  panel file. `add_captions` is now classified, and it REFUSES `layer`
  with text captions - which is what stops `for_each_layer
  {tool: "add_captions"}` from building the whole transcript once per
  selected layer.
- Full stub sweep: all 53 test files exit 0. `capability-report.js`
  regenerated.
- **Harness: 514/514 PASSED** (from 498), green on two consecutive runs
  plus a third after cleanup.

### No version bump

The feature-track rule in WORKPLAN section 5: new tools ride the next
MINOR, which the remote session cuts after reviewing the batch. Same call
as Passes A and B and as 5.5-5.8. Pushing without bumping is correct
here - the feed publishing an equal version is the intended outcome.

### Still open

- **The harness caught my own debris, and the mechanism is worth a note.**
  The first run after the new steps failed one UNRELATED step:
  `clean_project`'s "Comp not found" refusal lists the project's comps
  and that list is CAPPED, so my two probe comps pushed the comp the step
  was looking for out of the list. Removing them made it green. The
  latent issue is real though: in a user's large project that refusal can
  fail to name the comp the user just asked about. Small remote-session
  job - the grounded list should prefer near-matches to alphabetical
  order.
- **Project debris from earlier passes is still in the harness project**:
  two comps both called `AELL_PROBE_WA`, `PROBE_PARENT`, and roughly 250
  nulls named "Audio Amplitude" (5.7 measured that AE never uniques that
  name; these are the leftovers). Harmless today and the harness is green
  with them, but they are what makes the capped-list trap above easy to
  hit. A human with the project open could clear them in a minute.
- **`get-llama.ps1` still has the two latent traps Pass A flagged**: it
  greps for `CUDA Version:` (misses this machine's `CUDA UMD Version:`)
  and pads versions to two parts. `Get-AellCudaVersionFromSmi` and
  `ConvertTo-AellPaddedVersion` in `whisper-assets.ps1` are the fixes,
  already written and tested - a small pass points get-llama at them.
- **6.1 is now COMPLETE** (A, B, C). 6.2 (ffmpeg) is the next item on
  that track, and finding 5 above means it is no longer a prerequisite
  for anything - it is only worth what `export_gif` / `export_social`
  are worth on their own.
- `Invoke-AellWhisperCli -Timestamps` in the PowerShell library is still
  unused by shipped code; the panel has its own runner. It is used by
  this pass's manual verification and is worth keeping for that.
- 5.9 (.mogrt export) still deferred by its own LAST-item-of-the-night
  rule. Fourteenth pass. Someone should decide whether that rule means
  "last pass of a night" or "never".
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.8 -
  thirteenth pass to flag it; remote session's release cut.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - small remote-session pass.
- Machine state: AE left on the harness's own project with every comp and
  footage item this pass made removed, no dialog open. Temp WAVs, AIFFs
  and probe scripts deleted. `%APPDATA%\AE-Llama\vendor\whisper.cpp`
  still holds the CPU build and ggml-base.en (149 MB) - now used by
  shipped code, so it stays.

## 2026-08-30 (local) - item 6.2 Pass A: ffmpeg acquired, and the exit
## code that means nothing

First pass of the night. Harness green on arrival (514/514), so item 1
was satisfied and the next unfinished workplan item was 6.2 Pass A:
"acquire a static ffmpeg build the same way; verify with ffprobe."
5.9 was skipped by its own LAST-item-of-the-night rule, which this pass
is not.

Built, mirroring the whisper Pass A/B split so the choice and the check
are testable without a network or a binary:

- `scripts/lib/ffmpeg-assets.ps1` - WHICH download to take.
- `scripts/lib/ffmpeg-verify.ps1` - install discovery, the process
  runner, the clip round trip, the encoder census.
- `scripts/get-ffmpeg.ps1` - acquire into
  `%APPDATA%\AE-Llama\vendor\ffmpeg\bin`, then verify.
- `scripts/verify-ffmpeg.ps1` - standalone; SKIP + exit 0 with no
  install, `-Require` to make that a failure.
- `tests/test-ffmpeg-acquire.js` - 55 checks.
- `scripts/lib/gh-releases.ps1` - `Expand-AellReleaseList` lifted out of
  whisper-assets.ps1, which now dot-sources it. Both acquirers walk the
  same GitHub release shape and there is now one place to get it wrong.
  `test-whisper-acquire.js` re-run green after the move.

Source is BtbN/FFmpeg-Builds, chosen over gyan.dev because it publishes
through the releases API - the same shape get-whisper.ps1 already walks -
and because it ships an LGPL build alongside the GPL one, which this
product needs to be able to choose.

### Seven things the obvious version gets wrong

1. **ffmpeg EXITS 0 WHEN IT REFUSES TO WRITE.** Handed an output path
   that already exists and no `-y`, it prints "File ... already exists.
   Exiting." and "Error opening output file", writes nothing, and returns
   **0**. Measured twice; the file is byte-for-byte identical before and
   after. Real argument errors do return non-zero (-22 for a bad filter,
   -2 for a missing input), which is exactly what makes the 0 believable.
   For 6.2 Pass B this is the whole ballgame: an `export_social` that
   checks the exit code hands the user LAST WEEK'S render as this week's,
   and every layer of the pipeline reports success.
2. **Without `-nostdin` that same case HANGS FOREVER.** The
   already-exists path is an interactive "Overwrite? [y/N]" on stdin.
   Measured: killed at a 10 s timeout with the process alive and idle.
   Unattended that is a wedged pass with no output at all. Every
   invocation in the new library passes `-nostdin`, and `-y` is explicit
   rather than assumed.
3. **A VALID FILE CAN CONTAIN NOTHING, AND EVERYTHING SAYS IT IS FINE.**
   `ffmpeg -t 0` exits 0 and writes a 262-byte MP4 that is structurally
   perfect: ffprobe exits 0 on it, prints valid JSON, writes NOTHING to
   stderr, and scores `probe_score: 100` - with `"nb_streams": 0` and an
   empty streams array. This is the ffmpeg twin of 6.1 Pass B's "silence
   transcribes as You". So the check reads width, height and FRAME COUNT
   back out of the stream, and `Test-AellFfmpegCheckerRejectsEmpty`
   builds that empty file ON PURPOSE every run and fails if the checker
   accepts it - a checker that returned true unconditionally passes every
   other assertion in the file.
4. **ffprobe exits 0 on a file with no matching stream too.**
   `-select_streams v` against an audio-only file answers
   `{ "streams": [] }`, exit 0, empty stderr. It DOES exit 1 on a
   zero-byte or non-media file - while still printing parseable `{ }`.
   So neither the exit code nor "the JSON parsed" is a check.
5. **Matroska reports NEITHER `nb_frames` NOR `duration`.** Measured
   across four containers: .mp4 and .gif carry both; .webm and .mkv carry
   neither, on the stream. The first version of the checker read that as
   "0 frames" and rejected a perfectly good 10-frame VP9 file - the
   mirror image of the bug it exists to catch, and one that would have
   made this unusable for half the formats Pass B needs. The frame count
   now falls back to ffprobe's `-count_frames` (correct for all four,
   25 ms for a 1 s clip) and the duration to the FORMAT's duration.
   Neither fallback loosens anything; both produce the real number where
   the fast field was absent.
6. **The asset names are TWO schemes, not one, and the first version of
   the choice silently disabled half the walk.** The rolling `latest` tag
   names files `ffmpeg-n9.0-latest-win64-gpl-9.0.zip`; the dated
   autobuild releases name the SAME builds
   `ffmpeg-N-126313-g1ae4048218-win64-gpl.zip` and
   `ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip`. Matching `-latest-`
   literally chose correctly from `latest` - so every positive test
   passed - while reading every dated release as carrying NOTHING: the
   fallback for the day `latest` lacks a build could never fire, and the
   grounded error printed those tags as `()` while looking well-formed.
   The build field is no longer parsed at all; the trailing series suffix
   is, and its ABSENCE is what means master, in both schemes.
   Two smaller traps in the same names: `-like '*gpl*'` MATCHES the LGPL
   build (different licence, different codec set), and `n10` sorts BEFORE
   `n9` as a string - invisible today, and it silently picks the older
   build the day an n10 series is published. Series are compared as
   padded `[version]`, the same fix whisper-assets.ps1 uses for CUDA
   lines.
7. **`-encoders` is a COMPILE-time list, not a runtime one.** This build
   names `h264_amf` and `h264_qsv`, and BOTH fail at encode time on this
   machine (exit -558323010 and -1313558101, zero bytes written) for want
   of an AMD or Intel device - while libopenh264, h264_nvenc and h264_mf
   all produce real h264 in 37-190 ms. Pass B must not pick the first
   name off the census and trust it.

### The licence call, settled by measurement

BtbN publishes each build twice. This is a COMMERCIAL product, and
bundling an installer that fetches GPL binaries alongside closed source
is a question for a human, not a default for a script - so **LGPL is the
default** and `-License gpl` is an explicit, logged choice.

The reason that default is affordable is measured rather than assumed,
which is why the acquirer prints the census: the LGPL build has no
libx264 or libx265, but it DOES have **libopenh264** - software H.264,
verified encoding a real h264 stream in 37 ms - plus h264_nvenc and
h264_mf. So `export_social` needs no GPL binary on anyone's machine.
Default to libopenh264; treat the hardware encoders as an opt-in that has
to be TRIED, per finding 7.

### One PowerShell trap worth writing down

`$series` inside `Select-AellFfmpegRelease` IS the `$Series` parameter -
PowerShell variable names are case-insensitive - so building the seen
list overwrote what the caller had asked for, and the grounded error read
back its own list instead. Caught only because the error text looked
wrong. Here it cost one line of message; the same shadowing in a loop
that re-ran the filter would have changed the WALK.

### Verification

- `node tests/test-ffmpeg-acquire.js`: 55 checks, green. The choice is
  driven over BOTH captured naming schemes and over the nested shape
  `Invoke-RestMethod` really returns (asset pinned by SIZE, so a
  flattening regression that pools every release's assets cannot pass);
  the checker is driven against files the test writes itself, so the
  missing/zero-byte/no-install cases run on a CI runner with no binary;
  and the live half, gated on an install being present, asserts the
  round trip reads back 96x64 with the 12 frames 8fps x 1.5s implies AND
  that the checker rejects the deliberately empty file.
- Full stub sweep: all 54 test files exit 0.
- `scripts/verify-ffmpeg.ps1 -VendorOnly -Require`: 4/4 PASSED against
  the freshly installed build.
- The acquirer was run END TO END TWICE - a clean install and a re-run
  that wipes `bin` first - both exit 0, both verifying the binary they
  had just downloaded. n9.0.1-11-ge47273f4d9-20260829, 140.2 MB.
- `capability-report.js` regenerated: no change (this pass adds no AE
  tools).
- **Harness: 514/514 PASSED**, before the pass and after it. Nothing here
  touches AE. See the note below about the run in between.

### The harness failed once in the middle, and it was not this pass

Between the two green runs, one run exited 4 with "UNRECOGNIZED DIALOG:
Executing Script aell-selftest-run.jsx...". That string is AE's own
SCRIPT PROGRESS window, not a modal anyone has to answer - the blocked
check caught the suite legitimately running. The run before it had left
a stale "Save changes to Untitled Project.aep before closing?" prompt,
which the triage answered with Cancel as designed; that keeps AE open on
the old project and evidently makes the next launch slow enough to be
caught mid-execution. AE was `Responding=True` with no dialog up by the
time it was checked, and the immediate re-run was green.

Worth a small pass rather than a fix smuggled in here: the dialog triage
should treat a window whose text is `Executing Script *` as BENIGN and
keep waiting, the same way it already knows the save-changes prompt.
Today it screenshots it, calls it unrecognized and fails the run, which
on an unattended night turns one slow launch into a lost pass. The
screenshot is at `logs\dialogs\2026-08-30T01-04-58.png`.

### No version bump

Binary track, same lifecycle as 6.1 Passes A-C and the 5.x feature
items: no shipped behaviour changed, `extension/` is untouched, and
nothing new is reachable from the panel yet. Pushing without bumping is
correct - the feed publishing an equal version is the intended outcome.

### Still open

- **The panel cannot reach any of this yet, by design.** Pass A is the
  acquirer only. There is no `Ffmpeg` panel module the way there is a
  `Whisper` one, and no tool in `tools.js` - that is Pass B's job, and
  `test-chat-probe.js` will refuse a `global.Ffmpeg` that maps to no
  panel file, exactly as it did for Whisper.
- **This machine already had an ffmpeg** - gyan.dev 8.1 GPL essentials at
  `C:\Program Files\ffmpeg\bin`, on PATH, 96 MB per binary. That is why
  `Find-AellFfmpegInstall` falls back to PATH rather than insisting on
  the vendored copy: making a user download 140 MB they already have is
  the kind of thing they notice. It is also a second real build to test
  against, and the verify passes on both. Worth remembering that a user's
  own ffmpeg may be a GPL one - which is THEIR licence choice to have
  made, not ours, but Pass B should not assume a codec set from it.
- `Invoke-AellFfmpegProcess` duplicates the async-pipe-drain pattern from
  `whisper-verify.ps1` rather than sharing it. Deliberate for now (the
  two differ in what they return, and the whisper one is load-bearing for
  a shipped feature), but if a third acquirer appears that is the next
  thing to lift into `lib/`, the same way `Expand-AellReleaseList` was
  lifted this pass.
- **`get-llama.ps1` still has the two latent traps 6.1 Pass A flagged**:
  it greps for `CUDA Version:` (misses this machine's `CUDA UMD
  Version:`) and pads versions to two parts.
  `Get-AellCudaVersionFromSmi` and `ConvertTo-AellPaddedVersion` in
  `whisper-assets.ps1` are the fixes, already written and tested - a
  small pass points get-llama at them. Third flag; now that
  `lib/gh-releases.ps1` exists, that pass has an obvious home for the
  shared half too.
- Project debris in the harness project is unchanged from the 6.1 Pass C
  entry (two comps called `AELL_PROBE_WA`, `PROBE_PARENT`, ~250 nulls
  named "Audio Amplitude"), and the capped-grounded-list trap it makes
  easy to hit is still a small remote-session job.
- 5.9 (.mogrt export) still deferred by its own LAST-item-of-the-night
  rule. Fifteenth pass. Someone should decide whether that rule means
  "last pass of a night" or "never".
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.8 -
  fourteenth pass to flag it; remote session's release cut.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - small remote-session pass.
- Machine state: AE was not driven by this pass beyond the harness runs;
  it is left on the harness's own project with no dialog open. Temp clips
  and probe scripts deleted. `%APPDATA%\AE-Llama\vendor\ffmpeg` now holds
  the LGPL n9.0 build (ffmpeg/ffprobe/ffplay); `vendor\whisper.cpp` is
  untouched.

## 2026-08-30 (local) - item 6.2 Pass B: the comp goes out as a file, and
## the encoder that was named but could not run this frame

**Item:** WORKPLAN 6.2 Pass B - `export_gif` / `export_social`. The
harness was green before the pass (514/514), so this is the next
unfinished queue item rather than a repair.

**Shipped**

- `extension/js/ffmpeg.js` - the panel's side, the same split whisper.js
  uses: this is the PANEL's implementation and `scripts\lib\`
  `ffmpeg-verify.ps1` is the acquirer's and CI's, deliberately
  independent because the panel cannot shell out to PowerShell for every
  export. Find (vendor, then PATH), `planSize`, the argument builders,
  `inspect` (the only real check), `tryEncoder`/`pickEncoder`,
  `checkOutput`.
- `export_gif` and `export_social` in `tools.js`, PANEL tools for
  `transcribe_to_captions`' reason: the middle step is a child process
  and ExtendScript cannot spawn one. Both ends of the pipeline are
  already covered in real AE by the suite (`render_comp`), so this pass
  adds NO suite steps - what it adds is a refusal at every point where a
  step reports success and means nothing.
- `tests/test-ffmpeg-export.js` - 122 checks, no ffmpeg binary and no AE.
- `extension/index.html` and `scripts/chat-probe.js` load the new module;
  `tests/test-chat-probe.js` knows about it (Pass A predicted exactly
  this and was right).

The shape is `comp -> render_comp "Lossless" -> rawvideo AVI -> ffmpeg
-> .gif/.mp4`, master deleted on every path including the failures.

### Six things the obvious version gets wrong

1. **AE's "Lossless" is RAWVIDEO, and it is enormous.** ffmpeg reads it
   natively - `rawvideo`/`bgr24` in an AVI, no QuickTime and no
   intermediate codec, which is the good news. The bad news is the
   price: measured 231 040 B/frame at 320x240 and **6 224 440 B/frame at
   1920x1080**, i.e. 1.87 GB for ten seconds of 1080p30 and 5.6 GB for
   thirty. An exporter that just renders and then encodes fills
   someone's disk and finds out afterwards. So the master is ESTIMATED
   from width*height*3*frames before anything is queued, refused over a
   cap (default 8 GB, `maxIntermediateGB` raises it), and refused again
   if the temp volume has less free than the estimate. The refusal shows
   the arithmetic - bytes a frame, frame count, both levers - because a
   number without its derivation is not actionable.
2. **THE WORK AREA SILENTLY SHORTENS THE RENDER.** `render_comp` with no
   span takes AE's own default, which is the queue item's, which is the
   **work area**. Measured: a 3 s comp trimmed to `workAreaStart 1,
   workAreaDuration 1` renders `start 1s, 10 frame(s)`, status DONE,
   file written, every layer of the stack reporting success. An explicit
   `startTime`/`durationSeconds` beats it and leaves the work area
   alone. This is AE's own Ctrl+M behaviour so it stays the DEFAULT -
   what is not acceptable is it happening in silence, so the export
   compares the master's real duration against the comp's and says
   "Exported 1s of a 3s comp, because that is the comp's WORK AREA",
   naming `{wholeComp: true}`.
3. **The lossless AVI carries the comp's AUDIO.** Measured by adding a
   2 s 48 kHz stereo tone to the rig: the AVI grew by exactly 384 000
   bytes and ffprobe found a second stream, `pcm_s16le`. So
   `export_social` needs no separate `render_comp_audio` pass and no
   muxing step - one intermediate serves both. When there is no audio
   stream the export says so in a note, because "my video has no sound"
   is otherwise a support question.
4. **A NEGATIVE finding worth as much as a positive one.** Bottom-up BGR
   in an AVI is the classic upside-down trap, and AE's is NOT affected.
   A rig with a red top half and a blue bottom half came back out of
   ffmpeg with pixel (0,0) = (254,0,0). No vflip. Written down so the
   next person does not add one "to be safe" and invert every export.
   (The 254 rather than 255 is AE's own 8-bit rounding of a [1,0,0]
   solid, measured, and not worth chasing.)
5. **ffmpeg exits 0 having written nothing, and can write a container
   with no picture in it** (Pass A's findings 1 and 3). So `-nostdin -y`
   lead every argument list this module builds, and the exit code is
   never the check: `inspect()` reads WIDTH, HEIGHT and FRAME COUNT back
   out of both the master AE rendered AND the file ffmpeg wrote, with
   Pass A's `-count_frames` fallback for the containers that report
   neither. The stub suite drives all four shapes off captured ffprobe
   output - the 262-byte zero-stream MP4 that scores `probe_score: 100`,
   the zero-byte file that exits 1 while still printing `{ }`, the
   matroska that carries no `nb_frames`, and a real export.
6. **`-encoders` is a compile-time list, and trialling it at the wrong
   size is the same lie with extra steps.** Pass A said an encoder must
   be TRIED, so `tryEncoder` encodes one frame of colour bars and
   inspects the result. The first version trialled at a fixed 64x64 and
   the field run picked **h264_mf on a machine with an NVIDIA card** -
   because `h264_nvenc` answers "InitializeEncoder failed: invalid param
   (8): Frame Dimension less than the minimum supported value", exit
   -22, zero bytes written. Measured boundary on this card: **146x50
   encodes, 144x48 does not, 128x128 does not, 160x96 does.** The trial
   now runs at the size the export will actually be and the verdict is
   cached per name AND size. Re-run in the field: `hardware: true` at
   1280x720 now picks `h264_nvenc`, and at 128x128 it correctly still
   falls through to software.

   This one is worth dwelling on. Every stub check passed with the 64x64
   trial - the mechanism worked perfectly, `inspect` correctly rejected
   nvenc's zero-byte output, `pickEncoder` correctly moved on, and the
   export succeeded. Nothing was broken. It was just answering a
   question about a picture nobody was going to encode. The only thing
   that caught it was the field run naming an encoder that disagreed
   with the hardware in the box.

### A defect in chat-probe, found on the way in

`scripts/chat-probe.js` loaded panel modules with
`new Function("window", src)(window)`. Ten of the twelve modules end
`})(window)` and two - whisper.js and now ffmpeg.js - end `})(this)`.
Those are the SAME OBJECT in a browser, where `this` at the top of a
script is `window`, and they are not the same object at all inside
`new Function`, where `this` is Node's global. So `Whisper` was
published on globalThis while tools.js looked for `global.Whisper` on
the probe's window and found nothing, and `transcribe_to_captions`
answered **"Speech-to-text is not available in this panel build"** - a
shipped-looking refusal that says nothing whatever about the machine.
Fixed with `.call(window, window)`, which works for both shapes.

`test-chat-probe.js` had been asserting that the probe LOADS each file,
which is why this passed for a whole release: loading it is not the same
as it arriving. It now loads every module the way the probe does and
asserts the module lands on the probe's window.

**This is not a shipped bug.** The panel is a browser, `this === window`
there, and the real product was never affected - which is precisely why
it survived. No version bump is owed for it.

### Design calls, made and written down

- **`size` parses two conventions that genuinely disagree**: `"480"` is
  a WIDTH (how GIFs are spoken about), `"720p"` is a HEIGHT (how video
  is), `"1080x1920"` is both. Guessing between the first two would be
  wrong half the time, so the `p` is honoured rather than inferred.
- **`fit` defaults to `contain`** (letterbox). Cropping the edges off
  someone's comp is not a thing to do without being asked; both modes
  emit a note naming the other one.
- **`export_gif` defaults to 480 px wide at 12 fps** and says that it
  did. A GIF at comp size is a GIF nobody can post. It never UPSCALES -
  a 320-wide comp stays 320.
- **Dimensions round DOWN to even.** libopenh264 does NOT refuse odd
  ones (measured: 101x75 encodes fine), so this is a compatibility
  choice for players and platforms, and it is stated as one rather than
  dressed up as a crash guard.
- **libopenh264 is the default encoder**, per Pass A's licence
  measurement: the LGPL build has no libx264 and this is a commercial
  product. `hardware: true` opts into the nvenc/mf ladder, which is
  tried, not trusted. libopenh264 has no CRF, so `quality` becomes a
  real bitrate here (bits per pixel per frame: 0.06/0.1/0.15, floored at
  200 kbps and capped at 20 Mbps - 1080p30 medium lands on 6221 kbps).
- **The output extension picks the MUXER**, so unlike `render_comp` -
  where a wrong extension is cosmetic and gets reported - a wrong one
  here cannot run at all and is refused with the list of what can.
  `.webm`/VP9 and animated `.webp` are deliberately NOT built; they are
  refused by name.
- `mutating: true` on both, which for a PANEL tool only gates the dry
  run (panel tools are excluded from `batchable()`, so the round
  rollback's Ctrl+Z can never reach them). That is the behaviour wanted:
  a dry run should not spend three seconds and 534 MB.

### Verification

- `node tests/test-ffmpeg-export.js`: **122 checks, green.** The pure
  half (sizing, filters, bitrates, path checks) is proved outright; the
  install walk runs against a real tiny tree including the nested
  `bin\ffmpeg-...-lgpl\bin\` layout this machine really has and the
  half-install case; `inspect` and `pickEncoder` run against a SCRIPTED
  child_process replaying captured field output, including nvenc's
  size floor; and the two tools run end to end against a scripted AE
  whose `render_comp` truncates to the work area the way the real one
  measurably does.
- `node tests/test-chat-probe.js` green with the new module assertions.
- **Full stub sweep: all 55 test files exit 0.**
- **Field, in real AE 2026 with the bundled LGPL ffmpeg** - a 1920x1080
  30 fps 3 s comp with an animated solid, five paths, all green:
  - `export_gif` -> 480x270, 12 fps, 36 frames, 23 958 bytes, **2.8 s**
    (534 MB master rendered, converted and deleted).
  - `export_social {size: "1080x1920"}` -> 1080x1920 h264, 90 frames,
    38 302 bytes, 6221 kbps, 2.9 s, letterbox note present.
  - `export_social {fit: "cover", quality: "high"}` -> same frame,
    9331 kbps, crop note present.
  - existing output with no `overwrite` -> refused, with the file's size
    in the message.
  - `export_social {hardware: true, size: "720p"}` -> `h264_nvenc`,
    1280x720, 90 frames, 3.1 s. (This is the run that found finding 6:
    before the fix it said `h264_mf`.)
  - `stray masters in TEMP: []` after all five.
- `capability-report.js` regenerated: 73 -> 75 tools, 4 -> 6 panel-side.
- **Harness: 514/514 PASSED**, before the pass and after it. Unchanged
  by design - this pass adds no AE tool, so there is nothing new for the
  suite to drive.

### No version bump

Feature track, the same lifecycle as 6.1 Passes A-C and the 5.x items:
new tools ride the next MINOR, which is the remote session's. The
chat-probe fix is a script, not `extension/`, and was never a shipped
defect. Pushing without bumping is the intended outcome here.

### Still open

- **The panel UI has no button for either tool.** They are reachable by
  the model through chat, which is the product's main path, but a
  "Export GIF" affordance in Settings/main is a remote-session design
  call the way the render-queue one was.
- **`export_social` cannot write `.webm` or animated `.webp`.** Both
  encoders are in the LGPL build (`libvpx-vp9`, `libwebp_anim`) and both
  are refused by name today. Whether VP9's encode time is acceptable for
  a panel that blocks is a measurement plus a product call.
- **The intermediate is always the FULL comp size**, then scaled by
  ffmpeg. For a 4K comp exported to a 480 px GIF that is a lot of bytes
  moved to throw most of them away. AE's render settings can resize
  (Half/Third/Quarter) but `render_comp` exposes no way to ask, and
  `om.getSettings()` throws (6.1 Pass C measured that). A `resolution`
  argument on `render_comp` would make this much cheaper and is a
  self-contained small pass.
- **The 8 GB intermediate cap is a guess**, not a measurement. Nobody
  has established whether AE's AVI writer survives past the classic 2 GB
  / 4 GB RIFF boundaries, or whether ffmpeg reads what it writes there.
  Testing it costs a multi-gigabyte render; worth one deliberate pass
  rather than a surprise on someone's 30-second 1080p export.
- **Panel tools read as UNCOVERED in the generated capability table**
  ("stub tests: -"). `stubCoverage()` counts `call("tool")`, the
  host-tool convention, so `comfy_generate`, `transcribe_to_captions`
  and now both exports show a dash despite real coverage. Pre-existing
  shape of the metric, not a regression; a one-line regex change if
  anyone minds.
- **The dialog triage still calls AE's "Executing Script *" progress
  window an UNRECOGNIZED DIALOG** and fails the run. Second flag; the
  6.2 Pass A entry has the screenshot path and the reasoning. On an
  unattended night this turns one slow AE launch into a lost pass.
- `get-llama.ps1` still has the two latent traps 6.1 Pass A flagged
  (`CUDA Version:` vs this machine's `CUDA UMD Version:`, two-part
  version padding). Fourth flag; `whisper-assets.ps1` has both fixes
  written and tested, and `lib/gh-releases.ps1` is now the obvious home
  for the shared half.
- 5.9 (.mogrt export) still deferred by its own LAST-item-of-the-night
  rule. Sixteenth pass.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.8 -
  fifteenth flag; remote session's release cut.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - small remote-session pass.
- Project debris in the harness project is unchanged (two comps called
  `AELL_PROBE_WA`, `PROBE_PARENT`, ~250 nulls named "Audio Amplitude").
- Machine state: AE left on the harness project with no dialog open, 95
  items (down from the 100 the probes left). The export rig comp, the
  four probe comps, the tone WAV and every temp master are gone;
  `%TEMP%\aell-probe-ffmpeg` holds only probe outputs and can be
  deleted. No change to `%APPDATA%\AE-Llama\vendor`.

  Worth writing down because this entry nearly claimed the cleanup had
  happened when it had not: **the probes' own `delete_item` calls all
  failed silently and every probe comp survived.** Not a tool defect -
  `delete_item` takes `{item: ...}` and the probe passed `{name: ...}`,
  so it returned a perfectly good grounded refusal into a `try/catch`
  that threw the message away. The lesson is about the probe, not the
  tool: a cleanup step whose result is not read is not a cleanup step.
  Caught only by going back and LOOKING at the project before writing
  the sentence that said it was clean.

## 2026-08-30 (local) - the window After Effects did not draw, and the
## dialog the evidence never looked at

Harness green on arrival, 514/514, so the pass took the item the last two
entries had filed and neither had spent: **the dialog triage calls AE's
"Executing Script *" progress window an UNRECOGNIZED DIALOG and fails the
run.** It was flagged as a small pass. It was not a small pass, because
the filed symptom was not the defect - it was the second-loudest thing in
the room.

### What the screenshot said that the log entry did not

`logs\dialogs\2026-08-30T01-04-58.png`, saved by the run that exited 4,
shows AE's progress window reading **"Script execution time 0 minutes 17
seconds"** in front of a perfectly ordinary After Effects. Nothing was
stuck. Seventeen seconds is eight 2s polls plus the time to take the
picture - which is exactly `Get-AellVerdictPatience`'s patience for the
`unreadable` verdict. So the run was stopped by something the probe could
see and not read, and the "Executing Script" headline came from the
EVIDENCE path afterwards, naming a different window entirely.

### The measurement: AE's drop shadow outvotes AE's progress window

A probe drove a cold launch with a 26s sleep script and dumped every
top-level window of the process, the probe's own text, the harvest and
the verdict, every 1.5s. At **t=28..31s, three consecutive polls**, with
the suite provably running:

    vis=1 en=0 [tooltips_class32] ''
    vis=1 en=1 [SysShadow] ''
    vis=1 en=1 [#32770] 'Executing Script sleep.jsx...'
    vis=1 en=0 [AE_CApplication_26.3] 'Adobe After Effects 2026 - ...'

    verdict = unreadable

`SysShadow` is the drop shadow Windows draws under a tooltip and
`tooltips_class32` is the tooltip itself. Both are **visible top-level
windows owned by the AfterFX process**, both carry no text whatever, and
`OnTop` listed them as popups - so the triage saw two dialogs nobody
could read. A wordless block outranks a running script (`blocked` >
`startup` > `unreadable` > `running`), so the verdict was `unreadable`
while AE's own window sat there in plain English saying it was busy.

**Eight of those in a row is exit 4 on a suite that goes on to pass
514/514.** That is the lost run. Not the progress window: the shadow the
tooltip cast beside it.

The two are one bug in two layers, and both are fixed:

- `ae-dialog-triage.ps1` - a block with no words whose header class is
  `SysShadow` or `tooltips_class32` is not a popup. Judged on CLASS and
  only for a block with nothing to say: one of those windows that
  somehow carries words is still read for its words. This is the
  load-bearing half, because it is the half a Node test can drive.
- `run-ae-selftest.ps1` - `OnTop` does not list them at all, and skips
  them BEFORE the popup counter, so a probe that finds only chrome does
  not fall through to "main window is disabled but no popup text could
  be read" - the same wrong answer by a different road.

`Get-AellHarvestClass` also learned AE's progress window (harvested
verbatim: `Executing Script <file>...` + `OS_ViewContainer`), which is
the defect as filed. It was real, it was just not what cost the night:
what it cost was the diagnosis, by headlining UNRECOGNIZED DIALOG over
the top of AE reporting that it was busy doing what it was asked.

### Then the harness went red again, and the fix was incomplete

Post-fix field run 1 of 4 exited 4 on a popup no capture in this repo
has ever recorded:

    [DroverLord - Window Class]
        OS_ViewContainer
        OS_ViewContainer
        OS_EditTextContainer

Adobe's own toolkit shell, not the standard dialog class, carrying the
same three containers as the save-changes prompt and no words. The
immediate re-run was green and so were the three after it.

What that run PRINTED is the finding worth keeping. Its evidence read:

    what it says (WM_GETTEXT):
      Executing Script aell-selftest-run.jsx...

...because `HarvestDialogText` only ever harvested `#32770`. The window
that stopped the run was never read, never photographed, and the harness
reported on the one window in the room that was not the problem. Two
things came apart that had been assumed to be one:

- **what the HARVEST recognises is not what STOPPED the run.** The
  harvest reads dialog-shell windows; the verdict judges every popup the
  probe can see. A benign harvest beside a fatal popup now photographs
  the screen anyway: `Write-AellDialogEvidence -AlwaysShoot`, passed by
  the blocked path and only by it. (This pass introduced that hole
  itself, by letting a known harvest skip the picture. Caught by the
  field, four runs later.)
- **reading is widened; ANSWERING is not.** The harvest now reads
  `DroverLord` shells as well as `#32770`. `CloseWordlessDialogs` still
  posts WM_CLOSE to `#32770` alone, and a test pins that it does: what
  may be answered by an unattended run is a much narrower question than
  what may be looked at, and nobody has identified this window yet.

### Verification

- `node tests/test-selftest-runner.js` green. **Reverted against the
  pre-fix scripts it fails 8 assertions**, including
  `chrome-beside-progress reads as running (got unreadable)` - the bug
  class is caught without AE.
- New coverage, all from captures taken in real AE this pass: the chrome
  sample beside the progress window (`running`), alone (`clear`), beside
  a real modal (still `blocked`, on schedule, 3 polls), beside the
  teardown flicker (still `unreadable`); a 20-poll chrome timeline that
  must never stop; the DroverLord popup (`unreadable`, and NOT swallowed
  by the chrome filter - which is why that filter is two class names and
  not "anything wordless"); the progress-window harvest alone, beside
  the save prompt, and beside an error alert.
- **Full stub sweep: all 55 test files exit 0.**
- **Harness: 514/514 PASSED, three consecutive runs**, plus the green
  run this pass opened with. The one red run in between is the
  DroverLord finding above.
- Both .ps1 files re-checked pure ASCII.

### No version bump

`extension/` is untouched - the panel ships `extension/` alone and this
is harness tooling. Same call, for the same reason, as the 2026-08-28
dialog-triage pass.

### Still open

- **What IS the DroverLord popup?** Unidentified, and the honest answer
  is that this pass could not make it happen again. It is now readable
  and photographed when it recurs, which is the whole point of the two
  changes above, but until someone catches it the harness has a failure
  mode that cost one run in five tonight. Whoever meets it next: the
  picture and the WM_GETTEXT will both be there. Do NOT widen
  `CloseWordlessDialogs` to answer it blind - a wordless AE popup that
  persists 16s is exactly the case that refusal exists for.
- The chrome filter is proven two ways - a verbatim real-AE capture and
  a stub test that fails without it - but **the post-fix field runs did
  not reproduce the chrome state**, so they prove no regression rather
  than proving the filter firing. A deliberate attempt to raise a
  tooltip on demand (a scan grid of cursor positions across AE's window)
  raised none, so this is written down rather than claimed. The trigger
  is a tooltip lingering as AE disables its main window, which is mouse
  position and timing, not something the harness controls.
- Everything the 6.2 Pass B entry left open is unchanged: no panel UI
  for the export tools, no `.webm`/`.webp`, the full-size intermediate
  and the `resolution` argument `render_comp` does not have, the 8 GB
  cap that is still a guess, panel tools reading as uncovered in the
  capability table.
- `get-llama.ps1` still has the two latent traps 6.1 Pass A flagged.
  Fifth flag.
- 5.9 (.mogrt export) still deferred by its own LAST-item-of-the-night
  rule. Seventeenth pass.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.8 -
  sixteenth flag; remote session's release cut.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer`.
- Machine state: AE left running on an empty Untitled project with no
  dialog open, three green runs behind it. The project debris the
  earlier passes recorded went with the harness project, which this
  pass's probe closed WITHOUT saving (`CloseOptions.DO_NOT_SAVE_CHANGES`
  then `app.quit()`, deliberately, so no save prompt was raised and AE
  was never force-killed - a hard kill is what raises the recovery
  dialog on the next launch). `%TEMP%\aell-probe-progress` holds the
  four probe scripts and their logs and can be deleted.

## 2026-08-30 (local) - item 6.2 follow-up: the pixels After Effects
## never had to render, and the template that quietly ate the setting

Harness was GREEN on arrival (514/514), so the pass went to the queue.
Sections 1-4 are struck through, 5.9 is still held back by its own
last-item-of-the-night rule (eighteenth pass), and the freshest open
item is the one 6.2 Pass B filed against itself: **the lossless master
is always rendered at the FULL comp size and then thrown away by the
scaler.** A 4K comp exported to a 480 px GIF moves 24 MB a frame to
keep 0.4. Pass B called a `resolution` argument on `render_comp` "a
self-contained small pass". It was.

### What the probe measured (AE 2026, two temp .jsx runs)

Everything below is field truth; none of it was in the sketch.

- **The render-queue ITEM answers `getSettings()`.** It hands back a
  plain name-keyed map (Quality, Resolution, Time Span, ...). This is
  worth writing down because the OUTPUT MODULE's `getSettings()`
  THROWS - 6.1 Pass C paid for that fact - and the two objects had been
  assumed to behave alike.
- **`getSetting("Resolution")` and `getSettings()["Resolution"]` do not
  answer the same question.** The first returns the JSON-ish pair
  verbatim, curly braces and all: `({"x":2,"y":2})`. The second returns
  the NAME: `Half`. A human asked for a name, so the tool reports the
  name and reads it from the map.
- **Resolution is written by NAME and by nothing else.** `"Half"` works;
  `"half"`, `2` and `"Custom"` all take the same throw - *Invalid Value
  for key: <Resolution>. Missing or incorrect component. Must have form:
  "x,y"* - which names a form the API will not actually accept from a
  script. So the tool normalises ("half", "1/2", 2, "QUARTER") and
  refuses anything else with AE's real four.
- **`applyTemplate` RESETS Resolution to Full.** This is the whole
  reason this pass has an ordering test in three places. Set the
  resolution next to the other arguments - the obvious place - and AE
  wipes it when the render-settings template lands, renders full size,
  and reports success. Same trap shape as Pass A's "template BEFORE
  file", one line further down.
- **The rendered frame is `ceil(dim/factor)` per axis, not floor.**
  Measured with ffprobe on real renders: 640x360 at Third is **214x120**
  and 641x361 at Half is **321x181**. A floor would have been wrong on
  both.
- And the thing the argument exists for: resolution changes the OUTPUT
  FILE, not just AE's sampling. 640x360 -> 320x180 -> 214x120 -> 160x90,
  1 389 680 bytes down to 93 680.

### What shipped

- `render_comp {resolution}` (hostscript.jsx): parsed and validated
  BEFORE anything is queued, applied AFTER both templates, then READ
  BACK from `getSettings()` rather than trusted. The result reports
  `resolution` (AE's name) and `renderedSize` (with the comp's own size
  beside it when they differ), and a `resolutionWarning` when what AE
  confirms is not what was asked for.
- `export_gif` / `export_social` `{masterResolution}` via
  `Ffmpeg.planMaster` (the pure half, so it is stub-testable):
  full/half/third/quarter/auto. **`auto` picks the largest reduction
  that still COVERS the output**, so ffmpeg never enlarges; a named
  reduction that would land under the requested size is REFUSED and the
  refusal names the largest one that would work. The intermediate
  estimate and the cap message are computed from the reduced size, and
  the cap refusal now points at `{masterResolution: "auto"}` as a way
  through.
- **Opt-in, deliberately.** AE's reduced-resolution render is its own
  sampler and nobody here has measured it against ffmpeg's downscale on
  real FOOTAGE (a flat solid proves nothing about aliasing). Making it
  the default would be a silent quality change to a shipped path on an
  unmeasured assumption. The default is exactly what shipped.

### Verification

- **Harness: 517/517 PASSED in real AE** (514 before), three new suite
  steps: half really writes 80x60 AND fewer bytes than the same frame at
  full; a render-settings template together with a resolution still
  reports Quarter (the ordering step); an arbitrary percentage is refused
  with the four names. The existing "writes one real frame" step also
  now asserts `Full` / `160x120`, so the default is pinned too.
- `tests/test-render-queue.js` 82 -> 108 checks. The stub learned five
  more AE facts (facts 13-17 in its header comment: the applyTemplate
  reset, the item-level `getSettings`, the pair-vs-name split, the
  name-only write, the ceil rounding). **Reverted against a hostscript
  that sets the resolution before `applyTemplate`, three assertions
  fail** - including `resolutionWarning` firing - so the bug class is
  caught without AE.
- `tests/test-ffmpeg-export.js` 122 -> 138 checks for `planMaster`,
  including the two refusals and the auto ladder (700 wide stops at
  half, because a third of 1920 is 640).
- `tests/test-self-test.js`: its hand-written render_comp stub learned
  the same rules, or the suite's new steps would have passed against a
  fake that knows nothing about resolution. 517/517 there too.
- **Full stub sweep: all 55 test files exit 0.** Capability report
  regenerated (render_comp 8 -> 11 steps); curated half updated.
- **Export path driven end to end in real AE** through the panel tools
  (a probe that slices chat-probe.js's own bridge out of the file, so
  it cannot drift from what the panel does):
  - `export_gif {masterResolution: "auto"}` on a 1920x1080 comp to 480
    wide -> quarter master, 480x270 GIF, and the note says so.
  - `export_social {masterResolution: "half"}` -> 960x540 h264,
    libopenh264, master 960x540.
  - `{masterResolution: "quarter"}` for a 1920x1080 output -> refused:
    "AE would render 480x270 ... would have to ENLARGE the master".
  - `"35%"` -> refused with the list.
  - **The payoff, measured:** a 10 s 1080p comp to 480x270 with
    `maxIntermediateGB: 0.2` is REFUSED at full size (1.74 GB) and RUNS
    with `auto` (116 MB). Wall clock 6 598 ms full vs 5 966 ms quarter.
  - `stray masters in TEMP: []` after every run; the probe comps were
    removed and the removal COUNT was read (the Pass B lesson).

### No version bump

Feature track: this is a new argument on shipped tools, not a fix to
shipped behaviour - nothing was broken before it. Same call, for the
same reason, as 6.1 Passes A-C and 6.2 Passes A-B. It rides the next
MINOR, which is the remote session's.

### Still open

- **The quality question this pass deliberately did not answer.** Is
  AE's own downsample at Half/Quarter as good as rendering full and
  letting ffmpeg's scaler do it? Measured on a flat solid: identical
  output bytes, which proves nothing. On real footage with fine detail
  it might alias. Until someone measures it (an SSIM comparison against
  a detailed source would settle it in one pass), `masterResolution`
  stays opt-in and the default stays full.
- **The speed claim is smaller than it looks on this machine.** 6.6 s ->
  6.0 s for 10 s of 1080p. The disk here is fast and the test comp was a
  solid; a comp with heavy effects should gain much more, because AE
  computes a quarter of the pixels - but that is reasoning, not a
  measurement, and it is written here as such. The measured, banked win
  is the intermediate: 1.74 GB -> 116 MB, which is the difference
  between an export the cap refuses and one that runs.
- **What IS the `DroverLord - Window Class` popup?** Unchanged from the
  previous entry, and still not reproduced. Evidence will be captured
  when it recurs.
- Everything 6.2 Pass B left open otherwise: no panel UI for the export
  tools, no `.webm`/`.webp`, the 8 GB cap that is still a guess (this
  pass makes it easier to live with, not measured), panel tools reading
  as uncovered in the capability table.
- `get-llama.ps1` still has the two latent traps 6.1 Pass A flagged.
  Sixth flag.
- 5.9 (.mogrt export) still deferred by its own LAST-item-of-the-night
  rule. Eighteenth pass.
- `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.8 -
  seventeenth flag; remote session's release cut.
- `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer`.
- Machine state: AE left running with no dialog open, harness green
  behind it. Both probe comps (`AELL_EXPORT_RES`, `AELL_EXPORT_RES2`)
  were removed and the removal count read back (2 and 1). The probe
  folder under TEMP holds the four probe scripts, their JSON results
  and the small test renders, and can be deleted.

## 2026-08-30 (local) - item 7 Tier P4 bullet 1: the arithmetic that
## every shipped manifest made impossible (0.10.9)

Harness green before the pass (517/517) and green after, so the item was
the top unfinished one: WORKPLAN item 7's first bullet, the chat<->
generation VRAM handoff, measured on the real 5090 for the first time.
Everything tiers.js and the arbiter assert had until tonight been
arithmetic the stubs themselves supplied.

### What the probe is

`scripts/handoff-probe.js` — settings.js + tiers.js + setup.js + llama.js
+ comfy.js + tools.js loaded into a Node `window`, then
`Tools.executeCommands([comfy_generate])` against a REAL llama-server, a
REAL local ComfyUI and REAL nvidia-smi, sampled every 500 ms into a
labelled timeline that goes into the transcript. Two rounds, because the
interesting thing is the difference: (A) no override, the card's own
32 GB; (B) `vramOverrideGB: 8`, the same job on an impersonated T3.
Every generation runs `{import: false}` — no After Effects, so no dialog
can be raised and the user's project is never touched.

It wraps `Tiers.planHandoff` and `Comfy.freeVram` to record their exact
inputs and answers, because neither is visible in a tool result: one is a
status line, the other is best-effort and swallows its own error.

### The finding the bullet existed to make, and it is the opposite of what the bullet predicted

The bullet says a T7 card "should run CONCURRENT". It could not, ever.

**No shipped workflow manifest carries a single `sizeMB`.** They carry
`file`, `dir`, `role` and a download `url` — that is all. `genNeedMBFor`
summed `sizeMB` and returned null when it found none, so the field answer
on a 32 GB card with a 7B chat model was:

    planHandoff({vramGB:32, chatLoadedMB:6002, genNeedMB:null, auto})
      -> handoff: "the fit cannot be verified - pausing chat is the safe
         default"

Every generation on every card paused the chat model, whatever the
arithmetic would have said, while T6/T7's own settings copy tells the
user "the panel checks the arithmetic per job". And with
`comfyPauseLlm: "never"` a 5090 owner got a refusal that says "The panel
cannot verify this generation fits" — for every job, forever.

The stub suite could not see it: `tests/test-vram-arbiter.js` handed the
arbiter a manifest with `sizeMB: 6000` — a shape no bundled template has
ever had. The stub was testing a manifest format that does not exist.

**Fix at the root: measure the weights on disk.** `genNeedMBFor` now
resolves each non-optional `{dir, file}` against the model roots the
panel already knows — `comfyModelsDir`, each `comfyModelRoots` entry
(including the per-kind `"checkpoints=D:\SD\ckpts"` form), the user's
`comfyDir/models`, and the hidden backend's own tree — and stats it. A
manifest that DOES author a `sizeMB` is still believed first. The file is
the weights; an authored number goes stale the first time somebody swaps
a quantization.

**One unknown weight poisons the whole answer.** The old code returned a
partial sum as soon as any one entry had a size. A partial sum reads like
a verified fit and understates the bill in exactly the direction that
OOMs a card, and "unprovable" already has a safe meaning here: pause.

### The measurement, on the real card

RTX 5090, 32 607 MiB. Chat: Qwen2.5-7B-Instruct-Q4_K_M (llama-server
reports 6002 MB by the arbiter's file-size+1536 rule). Generation:
AE_LLAMA_KREA2_V1 at 768x768, weights measured on disk at **18 110 MB**
(12 868 diffusion + 5 000 text encoder + 242 VAE). ComfyUI 0.32.0.

- Idle, nothing loaded: 3 255 MB. ComfyUI up and idle: ~3 750 MB.
  Chat loaded on top: **9 724 MB**.
- **Round A, no override -> CONCURRENT.** "fits beside chat: the
  generation needs ~17.7 GB and the chat model holds ~5.9 GB of the
  card's 32 GB". No pause status line, `Llama.getState()` sampled
  every 250 ms said `running` throughout, generation **10 s**, peak
  **29 064 MB** — chat and Krea side by side with ~3.5 GB to spare. It
  did not OOM.
- **Round B, vramOverrideGB 8 -> HANDOFF**, now with honest numbers
  instead of "cannot verify": "it does not fit beside the chat model
  (the generation needs ~17.7 GB and the chat model holds ~5.9 GB of the
  card's 8 GB)". VRAM 9 736 -> **4 004 MB** at the pause, generation
  14 s peaking 22 372 MB, /free, chat warmed back up to `running`.
- So the handoff costs what it looks like it costs: the same job is 10 s
  concurrent and 14 s plus a model reload when it has to pause.

### Two more defects the same run paid for

**1. ComfyUI 0.32 lets go BEFORE the round ends, and the resume waited
for a drop that had already happened.** The timeline is unambiguous:
generation peaks at 23 291 MB at t=16.2 s and is back to 3 995 MB at
t=18.2 s — ten seconds before `resumeIfPaused` runs. That code sampled a
fresh baseline at that moment and then polled for it to drop a further
512 MB, which can never occur, so it burned the full 10 s timeout and
told the user "VRAM did not visibly release within 10 s" on every single
healthy paused round. Fixed: the pause now remembers the floor the card
settled at, and the resume asks the absolute question — "are we back at
that floor?" — which the first poll answers. Also answers the tier plan's
open question: **POST /free is supported, HTTP 200, ~65 ms, and frees
0 MB here because there is nothing left to free.**

**2. "Workflow finished but produced no output files (no
SaveImage/SaveVideo node?)" was blaming the one thing that was not
wrong.** Hit for real when the probe first came up against a ComfyUI one
release behind (the electron app's bundled 0.22.2, which does not know
`CLIPLoader` type `krea2`). ComfyUI **queues** a prompt whose outputs all
failed validation: `/prompt` answers 200 WITH a `prompt_id` and a
`node_errors` bag, the run "executes" in 0.01 s, and `/history` reports
it complete with no error and no outputs. The reason was handed over at
queue time and thrown away. The error now says what ComfyUI said:
"ComfyUI dropped every output branch of this workflow when it validated
it, so nothing was rendered: node 1 (CLIPLoader): Value not in list -
type: 'krea2' not in [...]".

### Verification

- **Handoff probe: 15/15 verdicts PASS** in the field, both rounds.
- `tests/test-vram-arbiter.js` 13 -> 22 checks. Its manifest stub now has
  the SHIPPED shape (file + dir, no sizeMB) and a fake disk it resolves
  against, plus the missing-weight, `comfyModelsDir`, per-kind-root and
  wrong-kind cases, and scenario 6 for the resume stall. **Reverted
  against the old tools.js, five assertions fail** — including "on 32 GB
  the same job runs CONCURRENT", the `never` refusal losing its numbers,
  and the resume taking 22 nvidia-smi reads and 18 poll delays instead
  of 3 and 0.
- `tests/test-comfy-node-errors.js` is new (5 checks): a fake ComfyUI
  reproducing the field capture exactly — 200 + prompt_id + node_errors,
  then a completed history entry with no outputs. **Reverted against the
  old comfy.js, three of them fail.** The control case (nothing skipped,
  genuinely no save node) still gets the old message.
- Full stub sweep: all 56 test files exit 0. Capability report
  regenerated (no tool changes).
- **Real-AE harness 517/517 before and after** — nothing AE-side moved,
  and it proves the pass left AE alone.

### Version

**Patch bumped to 0.10.9.** All three changes are fixes to shipped
behaviour, not new capability: a promise the panel makes in its own
settings copy and could not keep, a 10 s stall plus a false alarm on
every paused round, and an error message that named the wrong cause.

### Notes for whoever runs the next pass

- **The backend matters and this machine has two.** The ComfyUI the
  electron app ships in `AppData\Local\Programs\ComfyUI\resources\ComfyUI`
  is **0.22.2** and cannot run KREA2. The one the earlier passes used is
  **0.32.0**, at
  `AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI`. Launch:
  `C:\Users\mr\Documents\ComfyUI\.venv\Scripts\python.exe -s <that
  main.py> --base-directory C:\Users\mr\Documents\ComfyUI --port 8188
  --listen 127.0.0.1 --disable-auto-launch`. `Comfy.ensureRunning` cannot
  start either one: it only knows the vendor portable layout, and there
  is no vendor ComfyUI installed here.
- **The concurrent decision is a weights-only sum.** Measured tonight,
  KREA2's peak ran ~1.4 GB above its weights (19.5 vs 18.1 GB) and the
  tier's 1 GB headroom nearly covered it; the 29 064 MB peak left 3.5 GB
  on a 32 GB card. That is ONE model at ONE size. A workflow whose
  activations cost much more than its weights could still overshoot, and
  nothing here measures that. If a concurrent run ever OOMs in the field,
  this is the number to grow.
- The remaining item 7 bullets are unblocked by this pass and none were
  attempted: the `never` refusal in the field (it now produces real
  numbers instead of "cannot verify", so it is finally worth testing),
  the catalog measurements, the 4/6/8/12/16/24 impersonation ladder, and
  OOM recovery.
- Machine state: AE left running with no dialog open, harness green
  behind it. **The ComfyUI this pass started was stopped again** — it was
  not running when the pass began. llama-server is stopped (the probe
  stops it on the way out). Probe transcripts and the small test renders
  are under `logs/handoff-probe*`; they can be deleted.
- Still open from earlier passes, unchanged and unattempted tonight: the
  `DroverLord - Window Class` popup; no panel UI for the export tools;
  no `.webm`/`.webp`; the 8 GB intermediate cap that is still a guess;
  AE's downsampler never measured against ffmpeg's on real footage;
  `get-llama.ps1`'s two latent traps (seventh flag);
  `release-notes.txt` still reads "0.10.0" while the feed now ships
  0.10.9 (eighteenth flag, remote session's release cut);
  `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer`; and 5.9 (.mogrt export) deferred again by its own
  LAST-item-of-the-night rule — nineteenth pass, at 02:30 local with the
  loop still running.

## 2026-08-30 (local) - item 7 Tier P4 bullet 3: the refusal nobody can
## see, and the card that was never there (0.10.10)

Harness green before the pass (517/517), so the item was the top
unfinished one that is eligible: item 7's third bullet, the pause-
"never" refusal, measured through the MODEL for the first time. (5.9
.mogrt still outranks it on paper and still defers itself by its own
LAST-item-of-the-night rule - twentieth pass, the loop is still
running.)

### Why this bullet is not the same as the arithmetic

0.10.9 measured the handoff arithmetic on the real card. What it could
not say is what happens on the ONE generation outcome a user cannot
check for themselves: a refusal renders nothing, imports nothing, opens
no dialog and touches no VRAM. The only evidence that reaches a human is
the sentence the model chooses to write. A model that answers "here's
your image" is indistinguishable from a working panel until they go
looking for the file.

So the bullet is now `scripts/chat-probe.js` **step 14**, permanent:
impersonate an 8 GB card (T3), turn pausing off, ask for a picture.

### What the field run did

Two runs, both PASS, neither with ComfyUI running - the refusal comes
from the arbiter BEFORE `Comfy.ensureRunning`, which is also why the
step costs no VRAM and no backend. Chat model was this machine's own
Qwen2.5-32B-Instruct-Q4_K_M; KREA2's weights measured 18 110 MB.

Three rounds each time, and the interesting half is the first two:

- The model invented a workflow name (`image-to-image`, then
  `Stable Diffusion` on the second run), took the grounded
  "Unknown workflow ... Available: AE_LLAMA_H3_I2V_V1,
  AE_LLAMA_KREA2_V1" error and re-planned onto KREA2 unaided. That is
  0.9.28's finding reproducing twice more.
- Then the refusal, and it was relayed: *"The generation requires more
  VRAM than is currently available. Please pause the chat during
  generation or stop the chat server and try again."* (Run 1: *"It looks
  like there isn't enough GPU memory to generate the image while the
  chat model is running. Please pause the chat during generation..."*)
  Declined, reason, and the setting to change - all three.

### Defect 1: the refusal quoted a card that does not exist

Run 1's shipped sentence, verbatim:

    the generation needs ~17.7 GB and the chat model holds ~20 GB of
    the card's 8 GB

A chat model holding 20 GB of an 8 GB card is impossible on its face.
Both numbers are true and they cannot both be about the same machine:
the chat figure is MEASURED off the model really loaded (a 32B), and the
card figure comes from `vramOverrideGB`, which is a fiction by design.
Only the budget's provenance was missing. `planHandoff` now takes
`overridden` (the arbiter already had `eff.overridden` in hand) and says
"of the card's 8 GB **(VRAM override)**". A real 8 GB card's refusal is
unchanged - asserted, so the annotation cannot leak into the normal
sentence.

Narrow but shipped: `vramOverrideGB` is a settings field, not a debug
flag, and this is the sentence anyone who sets it reads.

### Defect 2: the default workflow was the seeder's hash record

Found by the pre-check that measured `genNeedMBFor` before the field run
- `Comfy.listWorkflows` on the BUNDLE answers:

    .hash-history, AE_LLAMA_H3_I2V_V1, AE_LLAMA_KREA2_V1, example-txt2img

`.hash-history.json` is 0.10.1's append-only record of every template
version ever shipped. It is a real `.json` in the workflow directory, it
was offered to the model as a template, and a leading dot sorts FIRST -
so `comfy_generate`'s default (`list[0]`, which is "whatever the
alphabet says", per test-comfy-workflow-choice's own note) was the
record file. A generation that named no workflow ran it as a graph.

Reach: the seeder deliberately never INSTALLS it (test-workflow-seeding
asserts that), so shipped installs were not hit. What was hit is
anything pointing at `extension/comfy-workflows` - which is exactly what
this project's own probes do on purpose (`handoff-probe.js`: "the REPO's
shipped template, not a stale install copy"). Fixed at the root:
listWorkflows skips dotfiles, so the next sidecar is covered too.

### One more thing the step needed, and the trap in it

A step can now carry `settings: {...}`, applied for its own sentence and
restored after. Deliberately NOT `Settings.set`: set() mirrors every key
to `%APPDATA%\AE-Llama\settings.json`, so a probe that died mid-step
would leave the OWNER'S panel running on an 8 GB budget with chat
pausing turned off. `Settings.get()` hands back one cached object every
tool reads, so patching it in place reaches the whole panel path and
restoring puts back exactly what was there. Read back after both field
runs: `vramOverrideGB = 0`, `comfyPauseLlm = auto`.

### Verification

- **Field: 1/1 both runs**, exit 0, transcripts in `logs/`.
- `tests/test-comfy-workflow-choice.js` +3 checks (the dotfile is not a
  workflow, and cannot be the default). **Reverted against the old
  comfy.js, five assertions fail** - including the one that prints
  `ran: ...\.hash-history.json`, which is the bug stated as evidence.
- `tests/test-vram-arbiter.js` scenario 3b: the same refusal on an
  impersonated card names the override, a real card's does not, neither
  loses its measured numbers. Writing it also exposed a latent
  test-order bug - scenario 4 was INHERITING its card from whichever
  scenario ran before it, and silently changed meaning the moment one
  was inserted above it. It declares its own now.
- `tests/test-chat-probe.js` +12 checks on step 14's verdict, against
  the real field capture: no comfy_generate, a generation that
  SUCCEEDED (the OOM case), a refusal about something else (the arbiter
  never reached), a refusal with no arithmetic (the 0.10.9 regression),
  an unlabelled fictional card, a chat model evicted by a job that never
  started, silence, a hallucinated success, no reason, no setting.
- Full stub sweep: **56/56 test files exit 0**.
- **Real-AE harness 517/517 after** (517/517 before) - nothing AE-side
  moved, and it proves the pass left AE alone.

### Version

**Patch bumped to 0.10.10.** Both changes are fixes to shipped
behaviour: a user-facing sentence that states an impossibility, and a
default workflow choice that could run a bookkeeping file as a graph.

### Notes for whoever runs the next pass

- **Step 14 needs no ComfyUI and no GPU work** - it is the cheapest
  ComfyUI-adjacent step in the probe. Steps 12 and 13 still need a
  backend, and `Comfy.ensureRunning` still cannot start either ComfyUI
  on this machine (0.10.9's note stands: the electron app's bundled
  0.22.2 cannot run KREA2; the working 0.32.0 must be launched by hand).
- The step asserts THREE things about the model's reply (it declined, a
  reason, the setting). The 32B cleared all three unprompted on both
  runs, so no system-prompt rule was needed. If a smaller model ever
  drops the setting, that is a prompt fix, not a looser check.
- Remaining item 7 bullets, none attempted: measure the catalog
  (sd15/sdxl/wan22-5b/minimax-h3 VRAM deltas + honest sizes), the
  4/6/8/12/16/24 impersonation ladder, and OOM recovery. The ladder is
  now cheap - step 14 proves the impersonation plumbing works end to
  end through the model.
- Machine state: AE left running with no dialog open, harness green
  behind it. llama-server stopped (the probe stops it on the way out).
  ComfyUI was never started. Two probe transcripts under `logs/`.
- Still open from earlier passes, unchanged and unattempted tonight: the
  `DroverLord - Window Class` popup; no panel UI for the export tools;
  no `.webm`/`.webp`; the 8 GB intermediate cap that is still a guess;
  AE's downsampler never measured against ffmpeg's on real footage;
  `get-llama.ps1`'s two latent traps (eighth flag); `release-notes.txt`
  still reads "0.10.0" while the feed now ships 0.10.10 (nineteenth
  flag, remote session's release cut); `comfy_generate` still calls
  `import_file` rather than 5.8's `import_as_layer`; and 5.9 (.mogrt
  export) deferred again by its own LAST-item-of-the-night rule -
  twentieth pass, at 03:10 local with the loop still running.

## 2026-08-30 (local) - item 7 Tier P4 bullet 4: every size in the catalog
## was wrong, and not one URL was (0.10.11)

Harness green before the pass (517/517), so the item was the top
unfinished one: item 7's fourth bullet, the catalog measurement. (5.9
.mogrt still outranks it on paper and still defers itself by its own
LAST-item-of-the-night rule - twenty-first pass, the loop is still
running.)

The bullet asks for three things: honest sizes, live URLs, and a real
VRAM delta per model. Two of the three need no GPU, no generation and
not one byte of the weights downloaded - and those two are the ones the
remote session could never do, because HuggingFace is unreachable from
there. They are done. The third is not, and the reason is written into
the workplan rather than guessed at here.

### The probe

`scripts/catalog-probe.js`, permanent, reads-only. It loads the REAL
panel stack (version.js + settings.js + tiers.js + setup.js) and, for
every URL in both catalogs:

- HEADs it. HuggingFace answers `resolve/main/...` with a 302 whose
  headers carry **`x-linked-size`** - the exact byte count of the file
  the download would have fetched, without fetching it. That is the
  whole trick; the CDN URL behind the redirect does NOT carry it.
- looks the same file up on this machine's own model roots (settings'
  comfyModelRoots + comfyDir + Setup.findComfyInstall + the Desktop
  app's ComfyUI-Shared store). Eight of the fourteen files are already
  here, and a stat beats a network header.

### Finding 1: no URL is dead. All twelve answered.

Worth stating plainly because the bullet expected the opposite ("they
are training-quoted"). Every `resolve/main/` path in both catalogs is
still valid: 4 chat GGUFs on bartowski, sd15 on Comfy-Org's archive,
sdxl on stabilityai, 3 Wan 2.2 files, 4 H3 files and the int8 encoder.
Nothing to correct.

### Finding 2: every size was wrong, and the reason was a UNIT

The catalog was counting in DECIMAL MB. Everything downstream of it
counts in MiB: nvidia-smi reports MiB, `tools.js modelFileMB` divides by
1048576, `planHandoff` multiplies vramGB by 1024, and Windows labels GiB
"GB" in its own Explorer. So every file was overstated by ~4.9%:

    Qwen2.5-32B   19900 -> 18932 MiB   (19851336576 B)
    Qwen2.5-14B    9000 ->  8572 MiB    (8988110976 B)
    Qwen2.5-7B     4700 ->  4466 MiB    (4683074240 B)
    Llama-3.2-3B   2100 ->  1926 MiB    (2019377696 B)  9.0% off - the
                                        decimal number was wrong too
    sd15           2132 ->  2034 MiB
    sdxl           6939 ->  6617 MiB
    wan22 diff     9700 ->  9536 MiB   (1.7% off - a wrong guess, not
                                        the unit)
    wan22 umt5     6400 ->  6424 MiB   (0.4% - the only near-right one)
    wan22 vae      1400 ->  1344 MiB

The four MiniMax H3 numbers (19999 / 14960 / 4967 / 577) were EXACT to
the byte. They came from the real manifest when 2d adapted the template;
everything else came from training. One field, two provenances, no label
- which is how it went unnoticed.

The consequence was not theoretical. `main.js` drew the model dropdown
with `sizeMB / 1000` and `setup.js` wrote its download status line with
`sizeMB / 1024`, so the same file was quoted two different sizes in the
same window, and `setup.js`'s progress-bar fallback
(`sizeMB * 1048576`, used whenever the server sends no Content-Length)
set a total 5% larger than the file - a bar that stops at 95% and never
finishes. With the data in MiB both are now right; main.js's /1000 is
fixed to /1024 and the divergence is a test.

### Finding 3: two entry totals disagreed with their own parts

`wan22-5b` said 17000 while its three urls summed to 17500; `minimax-h3`
said 40543 against 40503. The entry total is the only figure a user sees
before agreeing to a multi-gigabyte download, so a total that does not
match its own file list is a bug on its own terms. Both are now the sum
(17304 / 40503, in MiB), and the sum is asserted for every entry.

### Verification

- **Field: catalog-probe 0 failures** after the fix, 9 before (the
  transcript of both runs is in `logs/catalog-probe-*.md`).
- `tests/test-model-catalog.js` 17 -> 88 checks, built on the byte counts the
  network actually reported that day - the field capture replayed as a
  stub, the same shape as 0.10.8's SysShadow capture. Reverted against
  the old version.js/main.js, **12 assertions fail**, including
  `main.js: no decimal-MB arithmetic on sizeMB (found sizeMB / 1000)`.
  That last one is a source scan, so the NEXT consumer that assumes
  decimal fails CI without needing the network.
- Also asserted: a chat model's URL filename is the name it is saved
  under (the downloader looks it up by `model.name`), every url entry
  names its models/ subfolder, and an entry with nothing to download
  quotes no total.
- Full stub sweep: **56/56 test files exit 0**.
- **Real-AE harness 517/517 after** (517/517 before) - nothing AE-side
  moved, and it proves the pass left AE alone.

### Version

**Patch bumped to 0.10.11.** Shipped, user-facing numbers: the size on
every download button, the download progress bar's fallback total, and
the disk the user is asked to give up.

### Notes for whoever runs the next pass

- **The VRAM half of this bullet is a pass PER MODEL, not one pass.** It
  needs the weights (sd15 2.0 GB, sdxl 6.5 GB - already on this disk at
  `ComfyUI-Shared\models\checkpoints` - wan22 17.3 GB of which the umt5
  encoder is already here, H3 39.6 GB already here), a per-model
  workflow template (the panel ships only KREA2 and H3 i2v, so sd15/
  sdxl/wan22 have no graph to run), and a ComfyUI started by hand.
  `catalog-probe.js --no-net` prints exactly which files are already
  local, so the download list is one command away.
- `catalog-probe.js` is NOT wired into CI on purpose - it hits the
  network and HF rate-limits unauthenticated requests (3000 per 5 min
  window, per its own `ratelimit` header). The offline half of what it
  proves lives in test-model-catalog.js, which CI does run.
- The `measured` flag stays FALSE on every COMFY_CATALOG entry. It is
  about the VRAM figure, not the file size; version.js now says so.
- If the update feed ever ships a `modelCatalog`/`comfyCatalog`
  override, it inherits the MiB convention silently - nothing validates
  a hosted catalog's units. Small future guard, not built tonight.
- Machine state: AE left running with no dialog open, harness green
  behind it. llama-server and ComfyUI were never started - this pass
  needed neither. Two probe transcripts under `logs/`.
- Still open from earlier passes, unchanged and unattempted tonight: the
  `DroverLord - Window Class` popup; no panel UI for the export tools;
  no `.webm`/`.webp`; the 8 GB intermediate cap that is still a guess;
  AE's downsampler never measured against ffmpeg's on real footage;
  `get-llama.ps1`'s two latent traps (ninth flag); `release-notes.txt`
  still reads "0.10.0" while the feed now ships 0.10.11 (twentieth flag,
  remote session's release cut); `comfy_generate` still calls
  `import_file` rather than 5.8's `import_as_layer`; and 5.9 (.mogrt
  export) deferred again by its own LAST-item-of-the-night rule -
  twenty-first pass, at 03:35 local with the loop still running.

## 2026-08-30 (local) - item 5.9: the template After Effects wrote and
## then said it had not

Harness green on arrival (517/517), so item 1 was satisfied and the pass
took the top unfinished workplan item. That is 5.9, and it has been the
top unfinished item for twenty-two passes.

### First: a whole pass that happened and was never committed

Before writing any code this pass went looking for prior art and found
`logs/entry59.md` - a complete, dated, well-written entry for a **5.9
PROBE pass that ran in real AE on 2026-08-29**, with eight probe scripts
and their transcripts beside it. It is not in WORKPLAN-LOG.md. There is
no commit for it (`git log` goes straight from 0.10.8 to whisper Pass A),
and `logs/` is gitignored. So the pass ran, measured thirteen facts,
claimed to have written them into WORKPLAN.md as a build spec - and every
word of it died with the process. The next six passes each re-read the
log, saw 5.9 deferred, and deferred it again.

The lesson is small and worth acting on: **a pass's entry belongs in
`docs/WORKPLAN-LOG.md` from the first keystroke, not in `logs/`**, which
is exactly the directory git is told to forget. This entry was written
there too, then committed; the next pass should skip the middle step.

The probe's measurements are recovered and folded in below, with two of
them corrected - see "what the probe got wrong".

### The answer: yes, headless, with four conditions

`exportAsMotionGraphicsTemplate` runs from a `-r` session with no viewer
and no human: measured repeatedly today at 3.6-5.4 s, returning `true`
and leaving a real `.mogrt`, which is a ZIP (`50 4B 03 04`, confirmed by
reading the first four bytes). It needs the project **SAVED and CLEAN**,
a **FOLDER** path, a template name Windows will accept, and
`app.beginSuppressDialogs()`.

### The finding the item exists for

**A cancelled export returns `true` and writes nothing.** Any comp
holding a text layer whose font is not installed raises "The following 1
fonts were not synced from Adobe... Click OK to continue. Click Cancel to
stop the export", and answering it with anything but OK stops the export
while the call still answers `true` - four times running, with an empty
folder. The only tell is the clock: ~1.5 s against ~4.6 s.

So `true` is not evidence. `export_mogrt` stats the file, the way
`snapshot_frame` reads the PNG's own IHDR instead of repeating the comp's
dimensions, and `beginSuppressDialogs` is REQUIRED rather than defensive:
the same text comp exported whole (28 577 b) inside it.

### The bug this pass's own field run found, twice

The first field run reported `{"ok":false,"error":"Object is invalid"}`
for three exports - and all three files were sitting on the disk. An
instrumented copy of the tool pinned it: the tool ran to the last line
and died on `proj.file.fsName`. **A successful export invalidates the
held `app.project` reference as well as the CompItem.** Nobody had
measured that; entry59 had only the CompItem half.

Which is the same class of failure as the one the tool exists to
prevent - a report that disagrees with the disk - arriving from the
opposite direction. Both halves are now closed: everything the result
needs is read BEFORE the call, and a THROW is checked against the folder
too, because a template that is on the disk is on the disk whatever AE
said on the way out.

### What the 2026-08-29 probe got wrong, and how

- **"AE strips the SPACES out of the template name."** It does not. It
  writes the name verbatim: `P60 Brand Card` -> `P60 Brand Card.mogrt`,
  confirmed from outside AE with `Get-ChildItem`. Two things produced
  that conclusion. The probe's stage E set the name to
  `"AELLProbeTemplate"` - a string that never had spaces - and compared
  it against stage A's `"AELL Probe Template"`. And `File.name` is
  URI-ENCODED, so the same file reads back as
  `P60%20Brand%20Card.mogrt`; only `displayName` is a name a user can
  open. The first version of this tool believed the probe, guessed
  `name.replace(/\s+/g, "")` for the file, and its overwrite check
  therefore looked for a file that was never there - so AE threw "already
  exists" instead.
- **"Controller index 1 is the newest."** True, and it survived. But the
  first version of `AELL_mogrtFound` also had a fallback that said "if
  the folder holds exactly one .mogrt, that must be the one we wrote" -
  which handed back a file an earlier export had written, in a tool whose
  entire reason for existing is that AE reports success without writing
  anything. Removed. Only two things count as evidence now: a `.mogrt`
  that was not there before, or one whose size or modified stamp moved.

### The rest of the measured facts, all of them in the tools

**Exposing:**
- `canAddToMotionGraphicsTemplate` is false for a GROUP (Transform, a
  shape layer's Contents, and the effect row above a Slider all answer
  false), false for a Layer Control, and false once the property is
  already a controller - after which `addToMotionGraphicsTemplate`
  returns `undefined`, not `false`. Slider, Color, Checkbox, Angle, Point
  and Dropdown controls all work, as do Position, Scale, Rotation,
  Opacity, Source Text, and keyframed or expression-driven properties.
- **The default controller name is not the property's name.** It is the
  LAYER's name for a transform or text property and the EFFECT's name for
  an effect parameter - measured again today: exposing `opacity` on a
  layer called "P60 BG" produced a controller called "P60 BG Opacity",
  and exposing the Slider produced "Slider Control". Two properties of
  one layer therefore become two controllers with confusingly similar
  names unless a label is passed, so the tool reads back what AE actually
  called it and says so.
- AE accepts **duplicate** controller names in silence (two called "Wipe
  Amount", measured), so a duplicate is reported.
- Indices are **newest-first** and renumber on every add; reading out of
  range answers the string `"undefined"` and a negative index throws.
  `setMotionGraphicsTemplateControllerName` **does not exist** on AE
  2026, so there is no rename and no remove - the tool says so rather
  than letting the model try.
- `textDocument.isSubstitute` does not exist either, which matters
  because THIS ITEM'S OWN SPEC said to pre-clean with it.

**Exporting:**
- Unsaved project -> "The project needs to be saved first". Saved but
  DIRTY -> `false` in ~390 ms, silently, nothing written. A SUCCESSFUL
  export dirties the project, so a second one with no save between is a
  silent failure - which is why `{save: true}` exists and why the success
  result warns about it. The tool never saves the user's project without
  that flag.
- The path is a **FOLDER**, and AE `mkdir -p`s whatever it is handed,
  including for calls that then fail: the 08-29 probe left four empty
  directories named `probe-e1.mogrt`, `nope-does-not-exist` and so on. So
  a missing folder is refused here (naming the deepest one that does
  exist) rather than created and failed into, and a path ending `.mogrt`
  has its basename read off as the template name instead of becoming a
  directory. Verified today: `.../mogrt60/P60 Lower Third.mogrt` produced
  the FILE `P60 Lower Third.mogrt` and no directory.
- A template name holding `\ / : * ? " < > |` exports for 3.7 s, returns
  false and writes nothing - refused before the clock starts.
- Zero controllers -> false in ~340 ms.
- `overwrite=false` onto an existing file THROWS; the tool refuses first,
  quoting the existing file's byte count, so AE is never asked.
- Setting the template name to `""` resets it to "Untitled", so the
  tool falls back to the COMP's name rather than shipping a file called
  Untitled.mogrt.
- A `File` or `Folder` OBJECT throws; the path must be a string.

### Verification

- **Field, through the shipped `AELL_call` path**, three runs: six
  refusals that never reach AE, then a real export (11 669 b), a correct
  overwrite refusal, an overwrite that replaced it (11 822 b, 3.6 s,
  `replaced: true`), and the `.mogrt`-path case. First bytes of the
  output: `50-4B-03-04`.
- **`tests/test-mogrt.js`: 95 checks**, all fifteen measured facts
  encoded in the stub. Reverting the one-line `proj.file` fix makes it
  fail loudly, which is the bug the field found.
- Full stub sweep: **57/57 test files exit 0**.
- **Real-AE harness 517/517 after** (517/517 before). No suite steps were
  added - that is LOCK-IN, and it is blocked on the harness triage
  learning three progress dialogs (see the workplan).
- `docs/CAPABILITIES.md` regenerated, curated half updated.

### No version bump

Feature track: new tools ride the next MINOR, which is the remote
session's. Nothing shipped behaves differently.

### Notes for whoever runs the next pass

- **Machine state changed, deliberately.** The open project is now SAVED
  at `logs\mogrt60\P60-scratch.aep` (it was "Untitled Project.aep *").
  The export cannot be exercised any other way. It holds only agent
  debris - 262 items, the same count as before this pass, since the three
  solid sources the field runs left were swept - and the harness is green
  with it. `logs/` is gitignored, so none of it is committed.
- **5.9 LOCK-IN is a pass on its own** and it needs the harness triage
  taught first, or the suite will cancel its own exports.
- `expose_property` is registered as MUTATING (an ordinary project edit);
  `export_mogrt` is in `AELL_NO_UNDO_GROUP` for render_comp's second
  reason - it writes a file and may save the project, and a save inside
  an open undo group is the one thing it must never do.
- Still open from earlier passes, unchanged and unattempted tonight: the
  `DroverLord - Window Class` popup; item 7's VRAM half (a pass per
  model, ~36 GB of weights); the tier impersonation ladder; OOM recovery;
  no panel UI for the export tools; no `.webm`/`.webp`; the 8 GB
  intermediate cap that is still a guess; `get-llama.ps1`'s two latent
  traps (tenth flag); and `comfy_generate` still calls `import_file`
  rather than 5.8's `import_as_layer`.
- **One flag can stop being repeated.** Six entries running have said
  "`release-notes.txt` still reads 0.10.0 while the feed ships 0.10.x".
  It does not: it reads `0.10: text animators, ...` and has since
  788e799 made it MINOR-scoped precisely so patch feeds cannot age it.
  The flag was already answered when it was first re-filed. Checked, not
  copied forward.

## 2026-08-30 (local) - item 5.9 LOCK-IN: the five windows After Effects
## puts up while it works, every one of which read as a modal

Harness green on arrival (517/517), so item 1 was satisfied and the pass
took the top unfinished item. That is 5.9's LOCK-IN, whose own text named
its blocker: "the export raises three progress dialogs that are not
errors... Either the suite stays off the export path or the triage learns
those three titles first."

Both halves are now done. The triage learned them - from a capture, not
from that sentence - and the suite covers what it can safely reach.

### The measurement: watch the windows while a real export runs

`logs/mogrt-lockin/watch.ps1` lifts the harness's OWN Win32 probe out of
`run-ae-selftest.ps1` (regex over the `$win32` here-string, then
`Add-Type`) so the capture is exactly what the harness would see, and
polls `FindDialog` + `HarvestDialogText` every 150-200 ms while a `-r`
script builds a mogrt rig and exports it. Two runs, the second with the
save split out into its own timestamped step so every window could be
attributed to the call that raised it.

**Five windows, not three.** All `#32770`, all with a real TITLE and one
`OS_ViewContainer` child, none lasting a whole second:

| window | raised by | measured |
|---|---|---|
| `Save Project` | `app.project.save()` | ~550 ms, confirmed alone with a save-only script |
| `Open Project` | **the export** | ~200 ms |
| `Creating Motion Graphics Template` | the export | ~550 ms |
| `Verifying Adobe Fonts...` | the export | ~200 ms |
| `Exporting Motion Graphics Template` | the export | ~170 ms |

`Save Project` is not the export's, which matters because it belongs to
**any** tool that saves. And `Open Project` is the visible half of the bug
the BUILD pass found from the inside: **After Effects reopens the project
while exporting a template**, which is why a successful export invalidates
the held `app.project` reference and not just the CompItem. That was
inferred from a crash last time; this pass watched it happen.

**Every one of them read as `blocked`.** The watcher printed the verdict
beside each sample and it is in the transcripts. `blocked` gives up after
three consecutive polls, and the harness polls every 2 s, so five progress
windows across a five-second export is three blocked samples in a row on
a suite that is working perfectly. That is the exit 4 the item was
avoiding, and it was never about the export path alone - a save is enough.

### The fix: a verdict for "AE is working", with a clock on it

`Get-AellProgressTitles` lists the six measured titles (the five above
plus `Executing Script`), matched as a PREFIX because AE appends to them -
the script one carries the file name, the font one an ellipsis. A block is
a progress window only when EVERY word it says is one of those; a popup
that names itself `Verifying Adobe Fonts...` and then says something else
is a popup that said something else.

Two verdicts, not one, and the split is the whole design:

- `running` - AE's script window is up. Proof OUR script is alive.
  Patience 0: a run is never given up on while that is true.
- `progress` - only AE's own other work is visible. Patience **15 polls
  (~30 s)**.

The clock exists because of the one thing the probe layer cannot see. The
font ALERT an export raises ("The following 1 fonts were not synced...
Click OK to continue. Click Cancel to stop the export") is a QUESTION, and
`GetWindowText` returns EMPTY for another process's child controls - so
from the probe's side it is indistinguishable from the progress window of
the same name. Declaring these titles benign-forever would have handed an
unattended run a dialog that waits for a human who is asleep. 30 s is far
past every progress window measured here and far short of the 240 s
timeout.

The EVIDENCE layer can tell them apart, and does: it reads children with
`WM_GETTEXT`, so the alert's sentence arrives as a line of its own and
lands in `unknown` while the title is recognised. `Get-AellHarvestClass`
therefore labels a bare progress window benign and still headlines the
alert wearing the same title as UNRECOGNIZED. That asymmetry between the
two layers is deliberate and is now written down in both of them.

`running` outranking `progress` costs one thing - a run wedged INSIDE an
export reports as "still executing" at the timeout rather than stopping at
6 s - so the wait state now remembers `WorkingText` and the timeout names
the last window AE put up, with the font question called out by name.

The pre-launch answerer needed no change and gets none: `WM_CLOSE` on the
font window is CANCEL, and a cancelled export answers `true` and writes
nothing. These windows all have titles, so the wordless rail already
refused them - three new stale-plan cases pin that, and the reason string
now says `verdict is 'progress'` instead of guessing.

### The suite: 14 steps, and the one that cannot exist

`expose_property` is covered end to end (AE's default controller name is
the LAYER's, a label is verbatim, a duplicate name is reported, a GROUP is
refused with the leaf list, a second copy is refused with the roster) and
`export_mogrt` by its whole refusal wall: no folder, a relative folder, a
missing folder, a name Windows will not take, a comp with no controllers,
and an unsaved project.

**The export itself is not a step, and that is a decision.** AE exports
only from a project that is SAVED and CLEAN, and by then the suite has
created a dozen comps in whatever project the user has open - so the only
route to the export is saving the user's project, which the suite may
never do. Same shape as `clean_project` and `organize_project`: the
positive path is verified by hand in real AE (this pass: two more real
exports, 11 335 b and 11 305 b, 4.3 s and 2.5 s) and the suite holds the
wall. The wall is worth as much as the export anyway - AE answers `true`
and writes nothing for most of what is on it.

So the triage work is not made pointless by that decision: it is what
makes an export safe to run AT ALL while the harness is watching, and
`Save Project` alone would have tripped the old rules on any future step
that saves.

### Verification

- **Real-AE harness 531/531**, twice, back to back (517/517 before; +14).
  Every one of the new steps passes against real After Effects.
- `tests/test-selftest-runner.js`: the two captured export timelines
  replayed poll by poll (never stops), a progress window that never leaves
  (stops at poll 15), the font alert's harvest (UNRECOGNIZED by its
  sentence, not by its title), and each of the five windows as its own
  verdict case.
- `tests/test-self-test.js`: the canned host grew a faithful Essential
  Graphics model - the refusal chain in the real order, the layer-name
  default, duplicate names accepted in silence - and 531/531 on the happy
  path with all 75 refusal steps failing against a permissive host.
- Full stub sweep: **57/57 test files exit 0**.
- `docs/CAPABILITIES.md` regenerated. Its computed gap list now reads
  **"Host tools never exercised by the self-test suite: none"** and is
  true for the first time since the mogrt tools landed. The curated half
  also had the BUILD pass's correction to make: it still said the file
  name has "its spaces stripped", which AE does not do.

### No version bump

Feature track: 5.9's tools ride the next MINOR, which is the remote
session's. Nothing that ships behaves differently - the triage is harness
machinery, and suite steps are coverage.

### Filed for the next pass, measured tonight

**The suite leaks 34 project items per run, into the user's project.**
Counted before and after one harness run on the scratch project: 313 ->
347, all of it `Null` (162 -> 180) and `Audio Amplitude` (144 -> 160)
FOOTAGE sources. The suite's own cleanup sweeps the `ST ` namespace, and
these are named by AE, not by the suite - `audio_to_keyframes` never
uniques its null's name (measured 2026-08-28) and a null layer's source
outlives the comp that held it, which is the same class of leak the `ST `
sweep was built for. It reaches real users: anyone pressing Settings ->
"Run self-test" leaves ~34 orphan sources in their project every time.
Small, well-defined, and its own pass.

### Notes for whoever runs the next pass

- Machine state: the scratch project `logs\mogrt60\P60-scratch.aep` is
  still the open one and was SAVED twice by this pass's probes (the export
  cannot be exercised any other way). The two probe comps and their two
  solid sources were swept; the 347 items are the leak above.
- Probe scripts and transcripts are in `logs\mogrt-lockin\` (gitignored).
  `watch.ps1` is reusable for any "what does AE put on screen while X
  runs" question - it borrows the harness's own probe rather than a copy.
- Still open from earlier passes, unattempted tonight: the `DroverLord -
  Window Class` popup; item 7's VRAM half; the tier impersonation ladder;
  OOM recovery; no panel UI for the export tools; no `.webm`/`.webp`; the
  8 GB intermediate cap that is still a guess; `get-llama.ps1`'s two
  latent traps; and `comfy_generate` still calls `import_file` rather than
  5.8's `import_as_layer`.

## 2026-08-30 (local) - item 3: the 34 items every self-test run left in
## somebody else's project (0.10.12)

Harness green on arrival (531/531), so item 1 was satisfied and the pass
took the top unfinished item: the leak the PREVIOUS pass measured and
filed. It is fixed, and the field numbers are 364 items before a run and
364 after, twice.

### What was actually leaking, counted

A census of the open project (`logs\leak-probe\p1.jsx` - a plain
ExtendScript walk of `app.project`, classifying every item and its
`mainSource`) found **364 items, 357 of them orphan SOLID sources**:

| name | count | source |
|---|---|---|
| `Null 1` .. `Null 189` | 189 | every `add_null`; AE uniques the name |
| `Audio Amplitude` | 168 | every `audio_to_keyframes`; AE does NOT unique it |

Both are SolidSources. That is the whole leak: a null layer's SOURCE is a
project item, and deleting the comp that held the layer does not delete
it. The suite deletes its comps and its `ST `-named solids, and every run
walked away from ~34 items named by After Effects.

### Why eleven versions of a cleanup never saw it

The last step of the suite has always been *"nothing of the suite's
remains in the project"*, and it read:

    if (d.items[i].name.indexOf("ST ") === 0) stale.push(...)

**That assertion was TRUE on every single leaking run.** Not one of the
34 items is called `ST ` anything - they are called what AE calls them.
The sweep and the check shared one assumption, so the check could only
ever confirm the sweep's own blind spot. This is the second time in this
project a namespace sweep has been outflanked from outside the prefix.

### The fix: identity, not names

Names cannot decide this. `Null 1` is a name a real user's project will
hold, and deleting it would be far worse than leaking one. So the run now
answers a different question - *did THIS run make it?* - which needs a
before-picture:

- **New first step**, ahead of `create_comp`: `get_project_info
  {limit: 0}` into `ctx.baseIds`, a set of item IDs. It also asserts
  `items.length === numItems`, because a capped baseline would make the
  sweep delete items it never created - that is a guard on the cleanup,
  not a spare check.
- **The sweep** takes footage that is (1) absent from the baseline - this
  run's, whatever AE named it - or (2) in the `ST ` namespace, the old
  rule, kept because it still reaches leftovers from an earlier run that
  died before its own cleanup and are therefore IN the baseline.
- **Footage only, deliberately.** The one non-footage item a run can add
  is AE's own `Solids` FOLDER, which AE creates on demand and which the
  user's next solid will want.
- **The final assertion** now counts against the baseline as well as the
  prefix, and names what it found (`Null 1 (#20001), ...`). The step that
  could not fail can now fail.

### Verification

- **Real-AE harness 532/532, twice** (531/531 before; +1, the baseline
  step). Census run between them: **364 items before, 364 after, item for
  item identical** - `diff` of the two censuses is empty. Same again
  after the second run.
- **The 357 orphans already in that project were left alone**, which is
  the real-AE proof of the half that matters more than the sweep: 189
  items called `Null <n>` and 168 called `Audio Amplitude` sat in the
  baseline through two runs of a cleanup that deletes items by exactly
  those names when it made them. A name-based fix would have destroyed
  them.
- `tests/test-self-test.js`: the canned host now LEAKS the way AE does -
  every `add_null` pushes a `Null <n>` solid source, every
  `audio_to_keyframes` an `Audio Amplitude` one (not uniqued, faithfully),
  and both survive a comp delete. Reverting the sweep to the name-only
  rule fails the run with *"16 footage item(s) the run created are still
  in the project, under names the ST sweep cannot see"*. Two seeded
  USER decoys named `Null 1` and `Audio Amplitude` pin the other half:
  a sweep rewritten to match those names fails with *"the user's own
  'Null 1' survives the sweep"*. Both failure modes were run and seen.
- Full stub sweep: **57/57 test files exit 0**. `docs/CAPABILITIES.md`
  regenerated (`get_project_info` 14 -> 15 suite steps).

One stub trap paid for on the way: the leaked ids were seeded at 5000,
which is where the canned host's `nextFolderId` starts, so a leaked solid
and a folder shared an id and `delete_item` deleted the folder instead.
It surfaced as `ST ORG Nest` surviving cleanup. Leaked ids now start at
20000.

### Version: PATCH bumped to 0.10.12

This is a fix to SHIPPED behaviour, not a feature: anyone pressing
Settings -> "Run self-test" was leaving ~34 orphan sources in their own
project, every time.

### Notes for whoever runs the next pass

- Machine state: the open project is still `logs\mogrt60\P60-scratch.aep`
  with its 364 items. The 357 orphans are earlier passes' debris and are
  deliberately NOT cleaned - they are now the field's own decoy set, and
  any future pass that touches the cleanup should re-run
  `logs\leak-probe\p1.jsx` before and after and diff the two.
- Still open from earlier passes, unattempted tonight: the `DroverLord -
  Window Class` popup; item 7's VRAM half (needs ~36 GB of weights not on
  this disk), the tier impersonation ladder and OOM recovery; no panel UI
  for the mogrt export tools; no `.webm`/`.webp`; the 8 GB intermediate
  cap that is still a guess; `get-llama.ps1`'s two latent traps; and
  `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer`.

## 2026-08-30 (local) - item 7: the tier impersonation ladder, and the
## model root nobody declares (0.10.13)

Harness green on arrival (532/532), so item 1 was satisfied and the pass
took the top unfinished item: item 7's tier impersonation ladder. Items
2-6 are closed; item 7's other open bullets are the VRAM delta (still
blocked on ~36 GB of weights not on this disk) and OOM recovery.

### What was built

`scripts/tier-ladder-probe.js` walks every budget a user can type -
4/6/8/12/16/24/32, plus the card's own number - against real nvidia-smi,
a real llama-server and the weights really on this disk, and asks the
three questions the bullet asks: does the budget produce the matching
tier line, the matching catalog picks, and a handoff (or refusal)
consistent with planHandoff. Nothing in it is arithmetic the probe
supplies.

The point is that it asserts INVARIANTS rather than printing a table for
a human to read: 176 of them per run, including the ones no single-tier
spot check can see - the chat pick is the LARGEST that fits and never
shrinks as the budget grows; a demoted pick (experimental, or a
mode-change slow at this size) only wins when nothing solid fits its
kind; `never` is `auto` with the pause taken away, so it may only ever
answer what auto answered or refuse; a mandatory tier never shares the
card; and the sentence a user reads labels an impersonated budget,
because only one of its two numbers is measured.

One refactor paid for it: the decision half of `VramArbiter.ensureFor`
is now `VramArbiter.planFor`, because the other half kills llama-server
and every probe of the decision surface used to cost a model reload.

### The ladder was green. What it found was a rung's INPUT.

All 176 invariants held, on the owner's real 32B chat model and again on
the 7B - the second run is the one that reaches the `concurrent` branch
at all, and it puts the crossover exactly where the arithmetic does:
6002 + 18110 + 1024 = 25136 MB, so KREA2 runs beside the 7B at 32 GB and
hands off at 24, **560 MB short**.

What the table showed instead was a column that read `?`:

    | budget | workflow           | need MB | auto    | always  | never  |
    | any    | AE_LLAMA_H3_I2V_V1 |    ?    | handoff | handoff | refuse |

**The panel could not price the H3 i2v template on the machine that has
already rendered with it** (2026-08-27, 12 s, VRAM peak 28.4 GB). All
four of its weights are on this disk - and all four are in
`%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models`, the Desktop app's
shared auto-download store, where its downloader puts weights fetched
from a workflow's embedded URLs. `comfyModelRoots` knew four roots and
not that one, so `genNeedMBFor` returned null, and null means "the fit
cannot be verified": chat paused for every H3 generation, and pause
`never` refused the generation outright with a sentence carrying no
numbers.

This is 0.10.9's bug arriving from outside the manifest. That pass fixed
"no shipped manifest carries a sizeMB" by measuring the weights on disk;
this one fixes "the panel looks in fewer places than ComfyUI does".
COMFY_TIERS_PLAN has said since 2026-08-25 that the matcher's root list
is Documents + code install + ComfyUI-Shared + extra_model_paths roots.
Two of the four were never implemented in `tools.js`.

### The fix, and its second half

`comfyModelRoots` gained the shared store, and `configuredModelRoots` +
`parseComfyPathsYaml` gained the roots a ComfyUI CONFIG FILE declares -
`extra_model_paths.yaml` next to main.py, and the Desktop app's
`%APPDATA%\ComfyUI\extra_models_config.yaml`, which uses the same format.
A user who moved their models to another drive told ComfyUI, not this
panel, and had no reason to say it twice.

Deliberately a narrow reader, not a YAML parser: top-level sections,
`base_path`, per-kind keys, and `|` blocks. Two things measured off the
real file on this machine shaped it - the Desktop app writes `base_path`
**after** the keys it resolves, so a section's keys are held and resolved
when the section ENDS; and it names the whole tree `download_model_base`
rather than per-kind, which is a null-kind root. `custom_nodes` and
`is_default` are skipped: they are not model dirs. Anything the reader
does not understand it skips, and a root that does not exist costs
nothing, because the caller asks the filesystem.

Roots are also deduplicated now: on this machine the Desktop config
declares the same tree `comfyDir` already names, so the list held
`Documents\ComfyUI\models` twice.

### Verification

- **The ladder, twice, green**: 176/176 with the owner's configured 32B
  chat model, and 176/176 with the 7B. Transcripts in `logs/`.
- **The H3 bill is now 40503 MB**, which is exactly what
  `catalog-probe.js` measured from HuggingFace's `x-linked-size` on
  2026-08-30 for the `minimax-h3` catalog entry. Four files found through
  a new root summing to the byte count a different probe got from the
  network is as good a cross-check as this pass could ask for.
- **Real-AE harness 532/532** after the change (532/532 before; the
  arbiter is panel-side and adds no suite steps).
- `tests/test-tier-ladder.js` (NEW): the same ladder invariants over the
  shipped catalogs with the hardware stubbed, so a rung that stops making
  sense fails CI on a machine with no GPU. Includes the crossover, the
  Blackwell gate under a 32 GB budget on pre-Ada silicon, and the
  unprovable-bill rule at seven budgets.
- `tests/test-vram-arbiter.js`: five checks pin the roots. Reverting the
  fix fails two of them by name ("weights only in the Desktop app's
  shared store are found", "extra_model_paths.yaml roots resolve") - both
  failure modes were run and seen.
- Full stub sweep: **58/58 test files exit 0**. `capability-report.js`
  regenerated: no change, the pass ships no new tool.

### Version: PATCH bumped to 0.10.13

A fix to SHIPPED behaviour, not a feature. A ComfyUI Desktop user - the
install kind whose downloader puts weights in that store by default - had
every generation priced at null: chat paused when it did not need to, and
every generation refused outright if they had turned pausing off.

### Filed for a later pass, measured tonight

**The weight bill is not the VRAM footprint, and H3 is the proof.** The
panel now prices H3 i2v at 40503 MB of weights, and this machine rendered
it with a measured VRAM peak of **28.4 GB** - ComfyUI streams and
offloads, so the sum of the files overstates the card's real bill by
~12 GB. Every decision made from it is therefore conservative in the safe
direction (pause when it might not have needed to), never the unsafe one,
which is why this is a filing and not a bug. Closing the gap is what item
7's still-open VRAM-delta bullet is for: a `measured: true` number in the
catalog entry beats a file sum, and `genNeedMBFor` should prefer it once
one exists.

### Notes for whoever runs the next pass

- Machine state: llama-server was started and stopped by the probe; the
  open AE project is still `logs\mogrt60\P60-scratch.aep`. Nothing was
  generated - the ladder runs no ComfyUI job at all, by design (the
  executed handoff and refusal paths are 0.10.9's and 0.10.10's, already
  in this log).
- `scripts/tier-ladder-probe.js` is cheap to re-run (`--no-server` skips
  the model load entirely) and is the fastest way to see what the panel
  would decide on any card without owning one.
- Still open from earlier passes, unattempted tonight: the `DroverLord -
  Window Class` popup; item 7's VRAM half (needs ~36 GB of weights not on
  this disk) and OOM recovery; no panel UI for the mogrt export tools; no
  `.webm`/`.webp`; the 8 GB intermediate cap that is still a guess;
  `get-llama.ps1`'s two latent traps; and `comfy_generate` still calls
  `import_file` rather than 5.8's `import_as_layer`.

## 2026-08-30 (local) - item 7, OOM recovery: the job the panel gave up on
and left running

**Item:** WORKPLAN item 7, last bullet - "force one real OOM ... and verify
the chat model comes back afterward regardless."

Harness green before the pass (532/532), so the queue applied. Item 7's
other open bullet, the catalog VRAM delta, stays blocked exactly where the
0.10.11 entry left it: ~36 GB of weights that are not on this disk and a
per-model workflow template the panel does not ship. Nothing was
downloaded; that is the next pass's call, not this one's.

### The premise was wrong, and finding that out was most of the pass

The bullet assumes an oversized job OOMs. On this backend it does not.
Measured first, before anything was written: **KREA2 at 4096x4096 on a
32 GB card offloads its weights and GRINDS** - 33 s/it on pass one
(2 m 19 s for four steps), then 92 s/it on pass two, with no exception, no
error and no end. ComfyUI 0.32 boots here with async weight offloading and
25 140 MB of pinned memory; it will trade speed for memory almost
indefinitely rather than raise `OutOfMemoryError`.

So "a generation the card cannot do" does not reach the user as an OOM. It
reaches them as the panel's own generation TIMEOUT - and that is the WORSE
case of the two, which is why it is the one worth probing. A torch OOM
frees its allocation on the way out. An abandoned job does not: it keeps
computing and keeps the card.

### What the probe found

`scripts/oom-probe.js` (NEW) drives the real panel path - settings.js +
tiers.js + llama.js + comfy.js + tools.js -> `Tools.executeCommands([
comfy_generate])` -> a real llama-server, a real ComfyUI, real nvidia-smi.
`vramOverrideGB 6` puts it in T2, mandatory handoff, so the chat model is
genuinely stopped and the panel genuinely owes it back. The job is the
4096x4096 grind above with `comfyTimeoutSec 90`. `{import: false}`, so no
After Effects is involved and no dialog can be raised.

Before the fix, on the owner's 32B chat model:

    .. ComfyUI still generating... 90s
    .. VRAM did not visibly release within 10 s - proceeding anyway.
    .. Warming the chat model back up...
    -- at warm-up: VRAM 23673 MB, ComfyUI queue 1 running / 0 pending
    == FAIL the abandoned job is no longer running when the chat model is
            reloaded - 1 running / 0 pending in ComfyUI
    == FAIL ...and the card has room for it - VRAM at warm-up 23673 MB,
            chat model 18932 MB, card 32768 MB

The panel stopped LOOKING and called that stopping. Its error even said so
- "prompt <id> may still finish in ComfyUI" - and then, one line later, it
asked llama-server to load 18 932 MB into a 32 768 MB card of which the
job it had just abandoned held 23 673 MB. The round took 225 s and the
abandoned job went on to grind for another ten minutes on a machine whose
user had been told their generation was over.

**The chat model did come back**, which is the bullet's literal question,
and the honest answer is that Windows papered over the collision: the
driver's system-memory fallback let llama-server load spilled into host
RAM. It answered in 144 ms and the card read 32 021 MB - pegged. A card
that pegs is not a card that recovered; on any machine without sysmem
fallback that load fails outright. So the verdict the probe asserts is not
"did llama reach state running" but the four things that have to be true
for that to mean anything: the round ends once with a grounded error, the
abandoned job is gone, the card has room, and the model ANSWERS.

### The fix: a timeout cancels

`comfy.js` gained `cancelPrompt`, awaited before the timeout settles so
the arbiter's resume - which runs next and waits for the card to come back
- is waiting for something that can actually happen.

Never a blind `POST /interrupt`. **This is the USER'S ComfyUI and they may
have queued their own work in its own UI**, so the queue is READ first and
only the panel's own prompt id is ever acted on:

- still pending -> `POST /queue {delete: [id]}`, id-targeted on every
  ComfyUI version;
- still running -> `POST /interrupt {prompt_id}`. Read from this backend's
  own `server.py`: 0.32 interrupts only if that id is the running one, and
  older builds that ignore `prompt_id` do a GLOBAL interrupt - which by
  then cancels exactly the job we mean, because the queue read just proved
  ours is the one running. Correct on both, without a version check;
- neither -> nothing. It finished, or it was already dropped.

An unreadable queue cancels nothing and says so. A poll that lands while
the cancel is in flight is dropped rather than allowed to report the
panel's own interrupt back to the user as `execution_interrupted`, which
would have blamed them for cancelling their own render.

### Verification

- **The probe, re-run, green**: VRAM at warm-up 23 673 -> **10 588 MB**,
  ComfyUI queue 1 running -> **0 running / 0 pending**, round 225 s ->
  **112 s**, error now "Generation timed out after 90s (prompt ...) - it
  was still running and has been cancelled", chat back and answering in
  93 ms. Transcripts both sides in `logs/oom-probe-*.md`.
- `tests/test-comfy-timeout-cancel.js` (NEW, 18 checks) scripts a ComfyUI
  that accepts a prompt and never finishes it, and pins all four queue
  states plus "cb fires exactly once" and the message shape. **10 of the
  18 fail on the reverted file** - run and seen, not assumed. The check
  that matters most for a user's machine is the third: with only the
  user's own jobs in the queue, the panel must POST nothing at all.
- **Full stub sweep: 59/59 test files exit 0.**
- **Real-AE harness 532/532** before and after. The change is panel-side
  and adds no suite steps; the run proves it left AE alone.
- `capability-report.js` regenerated: no change, the pass ships no new tool.

### Version: PATCH bumped to 0.10.14

A fix to shipped behaviour. Any user whose generation outruns
`comfyTimeoutSec` - the default is 600 s and this machine's own oversized
job would need ten times that - had the panel walk away from a running job
and then fight it for the card.

### Filed, measured tonight, deliberately NOT fixed here

**The resume's release message is still a false alarm on a cancelled
round.** "VRAM did not visibly release within 10 s" still prints: ComfyUI
holds ~7.8 GB of cache after the cancel, and `/free` only sets FLAGS the
queue worker reads BETWEEN prompts, so the floor sampled at pause time is
not reached inside the 10 s window. The card had 22 GB free and the model
loaded and answered, so this is a sentence that misreports a healthy
round, not a failure. The honest predicate is "is there room for the chat
model", not "is the card back to the floor it was at" - a change to a
shipped path (0.10.9 wrote that wait) and worth its own small pass.

### Notes for whoever runs the next pass

- **ComfyUI must be started by hand and this pass started it**: the 0.32.0
  at `AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI`, per
  0.10.9's note. It is still running and idle; `Comfy.ensureRunning` still
  cannot start it.
- Machine state: llama-server was started and stopped by the probe. The
  open AE project is still `logs\mogrt60\P60-scratch.aep`. ComfyUI was
  interrupted and `/free`d on the way out - the probe always does this, so
  an unattended run cannot leave a 4096x4096 job grinding all night.
- `scripts/oom-probe.js` is ~2 minutes end to end and is now the cheapest
  way to ask "does a failed generation leave the panel in a state it can
  recover from". Re-run it after anything that touches the arbiter, the
  generation poller or the resume.
- Item 7 now has ONE bullet left, the catalog VRAM delta, and it is the
  expensive one: ~36 GB of weights to download, a per-model workflow
  template to write for sd15/sdxl/wan22-5b (the panel ships only KREA2 and
  H3 i2v), and a whole pass budgeted per model.
- Still open from earlier passes, unattempted tonight: the `DroverLord -
  Window Class` popup; no panel UI for the mogrt export tools; no
  `.webm`/`.webp`; the 8 GB intermediate cap that is still a guess;
  `get-llama.ps1`'s two latent traps; and `comfy_generate` still calls
  `import_file` rather than 5.8's `import_as_layer`.

## 2026-08-30 (local) - item 7 follow-up: the release the panel reported
was not the question it needed to ask

**Item:** the sub-bullet 0.10.14 filed and deliberately left - "the resume
still prints 'VRAM did not visibly release within 10 s' after a cancelled
round ... the honest predicate is 'is there room for the chat model', not
'is the card back to the floor'; that is a change to a shipped path and
wants its own pass."

Harness green before the pass (**532/532**), so the queue applied. Item 1's
`DroverLord - Window Class` popup is still unanswered and still has no new
evidence (`logs\dialogs\` holds nothing since 2026-08-30 01:04), and item
7's catalog VRAM delta is still the expensive one (~36 GB of weights not on
this disk, plus a per-model template the panel does not ship). Neither
moved tonight; this one could.

### Reproduced first, and the field named a worse number than the filing

`scripts/oom-probe.js`, unmodified, on the real path (real llama-server,
real ComfyUI 0.32, real nvidia-smi, `{import: false}` so no AE):

    .. ComfyUI still generating... 90s
    .. VRAM did not visibly release within 10 s - proceeding anyway.
    .. Warming the chat model back up...
    -- at warm-up: VRAM 2918 MB, ComfyUI queue 0 running / 0 pending

**2 918 MB used of 32 768.** The panel told a user with 29 GB free that
their VRAM had not been released. The filing guessed ComfyUI was sitting on
~7.8 GB of cache; the transcript's timeline says something simpler and
sharper - the card held **23 654 MB for the whole 10 s window** and fell to
2 918 MB **one second after the wait expired**:

    - 109.0s  23654  generate
    - 109.5s  15974  generate
    - 111.0s   6822  generate
    - 111.1s   2918  warm      <- the message had already printed

So the release was not slow in any way that mattered, and the sentence was
not merely pessimistic: it was reporting on the wrong thing. The floor the
pause left (2 916 MB) is a HARDER question than the resume needs. What
llama-server has to have is ROOM, and a card still holding a generation's
cache can have plenty of it.

### The fix: ask whether the chat model fits

`extension/js/tools.js`, `VramArbiter.resumeIfPaused` + `waitForVram`:

- The predicate is `card - used >= chatFootprint`, with the old floor kept
  as an **OR** (a card back where it started is by definition room enough)
  and as the whole answer when the card's own size is unknown. Both numbers
  are remembered at pause time (`_needMB`, `_cardMB`) beside `_floorMB`.
- The card total comes from **nvidia-smi, never `vramOverrideGB`**
  (`cardTotalMBNow`). The override impersonates a tier so any card can test
  any policy, but this wait asks a physical question about a physical
  reading, and pairing a measured `memory.used` with a fictional total is
  arithmetic about no machine at all. The 0.10.10 lesson, one layer down.
- `waitForVram` took a hard-coded sentence and a hard-coded 10 s; it now
  takes both from the caller, and the message may be a function that
  answers null to stay quiet. The timeout **reports what it measured** -
  "The card still holds 7000 MB of 8192 MB and the chat model needs about
  6236 MB - loading it anyway" - instead of asserting a release failure.
- The room wait is **30 s**, and that number is measured, not chosen: this
  backend finished handing the card back at ~10.5 s after a cancel, so a
  10 s limit was a coin flip on exactly the round the cancel created. It
  costs nothing on a free card - the predicate answers on poll one, which
  is the case every healthy round takes.

The pause side (`waitForVramDrop`) is untouched: there the panel has just
killed llama-server and a DELTA is the right question.

### Verification

- **The probe, re-run, green.** No release sentence at all; warm-up at
  **10 793 MB** with 0 running / 0 pending; round 112 s; chat back and
  answering in 90 ms. `oom-probe.js` gained the verdict that pins it - a
  release failure may only be reported when there was no room - so the
  next pass cannot regress it silently. Transcripts:
  `logs/oom-probe-2026-08-30T09-40-21.md` (before) and
  `...T09-46-28.md` (after).
- `tests/test-vram-arbiter.js` grew scenarios **7 and 8**: a 32 GB card
  where ComfyUI still holds 8 000 MB (room, nowhere near the floor - one
  poll, silence) and an 8 GB card that never gets room (waits, gives up,
  and says so with all three numbers). **4 of the new checks fail on the
  reverted file** - run and seen.
- **Full stub sweep: 59/59 test files exit 0.**
- **Real-AE harness 532/532** before and after. The change is panel-side
  and adds no suite steps.
- `capability-report.js` regenerated: no change, the pass ships no tool.

### Version: PATCH bumped to 0.10.15

A fix to shipped behaviour. Every user on an exclusive tier whose ComfyUI
had not finished dropping its cache within 10 s - which after 0.10.14's
cancel is the normal case, not the edge - was told their card had not been
released when it had, or was about to be.

### Notes for whoever runs the next pass

- **ComfyUI is still running** (the 0.32.0 at
  `AppData\Local\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI`, started
  by hand on 2026-08-30 per 0.10.9's note) and was interrupted and
  `/free`d by the probe on the way out, twice. `Comfy.ensureRunning` still
  cannot start it.
- Machine state: llama-server was started and stopped by the probe (twice).
  The open AE project is still `logs\mogrt60\P60-scratch.aep`.
- Item 7 now has ONE bullet left, the catalog VRAM delta, and it is a whole
  pass per model: ~36 GB to download, a per-model workflow template to
  write for sd15/sdxl/wan22-5b, and a ComfyUI started by hand. Somebody
  should decide whether that download is wanted before a pass spends the
  night on it.
- Still open from earlier passes, unattempted tonight: the `DroverLord -
  Window Class` popup (no new evidence); no panel UI for the mogrt export
  tools; no `.webm`/`.webp`; the 8 GB intermediate cap that is still a
  guess; `get-llama.ps1`'s two latent traps; and `comfy_generate` still
  calls `import_file` rather than 5.8's `import_as_layer`.

## 2026-08-30 (local) - `get-llama.ps1`'s two latent traps, and the
## one-click engine install that had stopped working for everybody (0.10.16)

**Item:** the flag ten passes had carried without spending a night on it -
"`get-llama.ps1` still has the two latent traps 6.1 Pass A flagged: it
greps for `CUDA Version:` and pads versions to two parts. Neither bites
today ... small remote-session job, or the next local pass that has
nothing better."

Harness green before the pass (**532/532**), so the queue applied. Item 1's
`DroverLord` popup still has no new evidence (`logs\dialogs\` holds nothing
since 2026-08-30 01:04) and item 7's catalog VRAM delta still wants ~36 GB
of downloads and a human's say-so. This was the next thing that could
actually move. It moved further than the flag did.

### The flag was right about the script and wrong about "neither bites"

The pass started by pointing the SHIPPED panel at the same question, because
`get-llama.ps1`'s own header says "the panel does all of this by itself on
first launch (auto GPU detection included) -- this script exists for
development, CI, and offline prep." If the script's detection is wrong, the
panel's copy of it is the one that reaches users. It was.

`scripts/engine-asset-probe.js` drives the real `extension/js/setup.js`
(`detectGpu` + the asset chooser) against real nvidia-smi and the real
GitHub API. Two findings, in order of how much they cost:

**1. The panel's one-click engine install was dead. For everyone.**

    /releases/latest  : v0.3.0 -> nightly-tag.txt
    walk over /latest alone : REFUSED - No Windows llama-server build in
                              the 1 newest llama.cpp release(s): v0.3.0.

`ggml-org/llama.cpp`'s `/releases/latest` answers **`v0.3.0`, whose entire
asset list is one `nightly-tag.txt`**. Every release carrying Windows
binaries is a `bNNNNN` tag and **every one of those is flagged prerelease**,
which `/releases/latest` never returns. So `bootstrapEngine` - Settings ->
"Reinstall / update engine", and the whole first-run path - ended at "No
suitable Windows build found in release v0.3.0". `get-llama.ps1` failed the
same way, run from HEAD and seen:

    Release: v0.3.0
    No Windows CPU x64 asset found in v0.3.0.

This is not a latent trap. It is the product's front door, and it had
already blown shut. Nothing in the repo could have caught it: the asset
matching is correct, the URL is the bug, and upstream changed under a
shipped release.

**2. The flagged regex, and what it actually cost.** This machine's banner
reads `CUDA UMD Version: 13.4`, so `/CUDA Version:/` matched nothing and
`detectGpu` answered `cudaVersion: null`. That is not an error path - it is
the "be conservative, take the OLDEST published line" path, so the symptom
is a **working install of the wrong build**:

    with detectGpu as it stands : CUDA 12.4 -> llama-b10690-bin-win-cuda-12.4-x64.zip
    with the driver CUDA read   : CUDA 13.3 -> llama-b10690-bin-win-cuda-13.3-x64.zip

250 MB of CUDA 12.4 on an RTX 5090 whose driver runs the 13.3 build, which
is 146 MB. The 2026-08-29 whisper pass called this one "flagged, not
touched" because whisper's asset names are `12.4`-shaped; llama.cpp's are
not, and here it decided the answer.

### The fix

- `extension/js/setup.js` `detectGpu`: the word between CUDA and Version is
  optional - `/CUDA(?:\s+\w+)?\s+Version\s*:\s*([\d.]+)/`. `Driver Version:`
  on the classic banner sits one word away and is NOT swallowed (asserted).
- `extension/js/setup.js` gains `pickReleaseAssets(releases, gpu)`: walk the
  release LIST and take the newest one that actually carries a build,
  skipping drafts, flattening a nested array, and refusing with the tags it
  looked at. `bootstrapEngine` asks for `releases?per_page=15` instead of
  `/releases/latest`. An explicit `{tag}` still fetches that one release and
  goes through the same walk. This is the rule `get-whisper.ps1` and
  `get-ffmpeg.ps1` have had since 2026-08-29/30; the engine never got it.
- `scripts/lib/gpu-detect.ps1` is new and holds the two helpers that were
  written for whisper and that get-llama had broken copies of -
  `Get-AellCudaVersionFromSmi` and `ConvertTo-AellPaddedVersion` (three
  parts, because `[version]` pads a missing one with **-1**, so `11.8` is
  LESS than `11.8.0`). `whisper-assets.ps1` and `get-llama.ps1` both
  dot-source it. Same extraction move as `gh-releases.ps1`.
- `get-llama.ps1` gains **`-ListOnly`**: the entire choice runs - driver
  read, release walk, CUDA line, cudart match - and it prints what it would
  download instead of wiping the vendor folder and pulling 500 MB. That is
  what made this verifiable in the field at all; a pass that had to actually
  download would have had to destroy the panel's working install to test it.
- `pickAssets` and the walk are exported as `pickEngineAssets` /
  `pickEngineRelease`, the way `pickComfyAsset` already was. The choice was
  unreachable from a test before this.

### Verification

- **`get-llama.ps1 -ListOnly` in the field**, real API, real nvidia-smi:
  `driver CUDA: 13.4` -> `Release: b10690` -> `CUDA toolkit line: 13.3` ->
  `llama-b10690-bin-win-cuda-13.3-x64.zip` + its cudart. Nothing downloaded,
  vendor folder untouched. The pre-fix copy of the same script, run from
  HEAD beside it, threw on `v0.3.0`.
- **`scripts/engine-asset-probe.js`** re-run green; transcript at
  `logs/engine-probe/probe-after.md`.
- **`tests/test-engine-assets.js`, 36 checks**, all real captured field data
  (this machine's two banner spellings, the real `v0.3.0` and `b10690` asset
  lists). Reverting the regex alone fails 2 of them; reverting the walk
  removes the export and the file will not run at all.
- **Full stub sweep: 60/60 test files exit 0.**
- **Real-AE harness 532/532** before and after. The change is panel-side and
  adds no suite steps.
- `capability-report.js` regenerated: no change, the pass ships no tool.

### Version: PATCH bumped to 0.10.16

The strongest case for a bump this project has had. Until this ships, a new
user's engine install cannot succeed, and Settings -> "Reinstall / update
engine" cannot repair it either - both go through the same dead URL. The
feed is the only way that reaches an installed panel.

### Notes for whoever runs the next pass

- **ComfyUI's own release query was checked and is FINE.** `bootstrapComfy`
  hits `comfyanonymous/ComfyUI/releases/latest`, which now answers **HTTP
  301** (the repo moved), but `fetchJson` follows redirects up to 5 and the
  target is `v0.34.0` with all four portable `.7z` assets present. Measured,
  not assumed - no item filed.
- The panel picks a CUDA line but **nothing here has run llama-server from a
  freshly bootstrapped install**; the owner's install predates this. A pass
  that wants to close that loop can point `-ListOnly` at a temp vendor dir
  and then actually download once.
- Machine state: AE left on the harness's own project; no llama-server was
  started or stopped by this pass. ComfyUI is still running from 0.10.9's
  hand start.
- Still open from earlier passes, unattempted tonight: the `DroverLord -
  Window Class` popup (no new evidence); item 7's catalog VRAM delta (~36 GB
  of weights and a human's decision); no panel UI for the mogrt export
  tools; no `.webm`/`.webp`; the 8 GB intermediate cap that is still a
  guess; and `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer`. The `get-llama.ps1` flag is now struck after ten
  passes carried it.
- `release-notes.txt` still reads "0.10.0" while the feed now ships 0.10.16.
  Remote session's release cut.

## 2026-08-30 (local) - the boundary every 1080p export over eleven
## seconds crosses, and that nobody had ever tested (0.10.17)

**Item:** item 6.2's longest-lived flag, carried by twelve passes and
never spent a night on - "**The 8 GB intermediate cap is a guess**, not a
measurement. Nobody has established whether AE's AVI writer survives past
the classic 2 GB / 4 GB RIFF boundaries, or whether ffmpeg reads what it
writes there. Testing it costs a multi-gigabyte render; worth one
deliberate pass rather than a surprise on someone's 30-second 1080p
export."

Harness green before the pass (**532/532**), so the queue applied.
Item 1's `DroverLord` popup still has no new evidence (`logs\dialogs\`
holds nothing since 2026-08-30 01:04, which the previous pass already
read) and item 7's remaining bullet still wants ~36 GB of weights and a
human's say-so. Everything else in items 1-6 is struck. This flag was the
next thing that could actually move, and its own text sizes it as one
deliberate pass, which is what it got.

### Why it was worth a night

The exporters render a LOSSLESS master first: rawvideo/bgr24 AVI, three
bytes a pixel, ~6.22 MB per 1080p frame. AVI is RIFF and RIFF chunk
offsets are **32 bits**, so 2 GiB and 4 GiB are exactly where a writer
classically wraps - and the failure mode is not a crash, it is a file the
reader accepts and truncates. The arithmetic says how routine that is:

    1080p30 crosses 2 GiB at ~11.5 s and 4 GiB at ~23 s

So **almost every real export is already past one boundary**, the shipped
cap lets a user go to ~46 s, and the whole span was untested.

### The method, and the one trick that makes it exact

`scripts/riff-boundary-probe.js`. It takes its bridge wrapper from
`chat-probe.js` by require rather than by copy, so it cannot drift from
the way the panel actually talks to AE.

1. A rig comp whose every frame is a different picture, both drivers pure
   functions of `time` so frame N depends on N and nothing else -
   Position a 1720 px traverse, Rotation 120 deg/s (4 deg a frame, which
   no antialiasing accident can blur between neighbours). Position gets
   TWO components, not three: the expression engine sees 2 dims on a 2D
   layer however many the scripting API pads to.
2. The whole comp through the shipped `render_comp` at "Lossless".
3. ffprobe, then a full decode under `-xerror` - a corrupt tail is
   invisible to the header read that ffprobe does.
4. `framemd5`: one MD5 per DECODED frame, and assert they are all
   DISTINCT, or step 5 would be comparing nothing.
5. **The trick.** Re-render SHORT spans of the same comp straddling each
   boundary via `render_comp`'s `startTime`/`durationSeconds`. Those
   reference files are a few MB and nowhere near any boundary. Frame for
   frame their MD5s must equal the big file's at the same comp times.
   That compares **AE against itself** - same comp, same renderer, same
   codec - so no assumption about colour management, gamma, or what the
   picture ought to look like enters the verdict.

A file that truncates, wraps, repeats a frame or garbles its tail fails
(5) even when ffprobe reports a tidy 900 frames.

### The answer: the format is not the risk

Two real renders, 11 checks each, all green.

    30 s = 900 frames   5 598 817 144 B (5.214 GiB)  17 s wall
    46 s = 1380 frames  8 584 826 232 B (7.995 GiB)  26 s wall

46 s is not an arbitrary second number: at 1080p it is **the longest
master the shipped 8 GB cap allows**, so the cap was tested at its own
edge. Both: status DONE with no warning, on disk at or above the raw
pixel floor, ffprobe 1920x1080 rawvideo at the full frame count, full
decode exit 0 with an empty stderr, 900/900 and 1380/1380 DISTINCT frame
hashes, and the reference spans at **frames 343-347 (the 2 GiB
boundary), 688-692 (the 4 GiB boundary) and the final five** matching
5/5 byte for byte inside the multi-gigabyte file. Nothing wrapped and
nothing was dropped.

So the 8 GB cap is not protecting against the container. It is a
**disk-and-time guard**, which is a legitimate thing to be and a
different thing from what the code implied.

### What that changed at the root

- `extension/js/tools.js`: the cap keeps its default (8 GiB is ~46 s of
  1080p and 26 s of rendering here; nobody has asked for more) and gains
  the measurement as the comment that explains why it is a number at all.
  The refusal now says **which kind of limit it is** - "it guards the
  DISK and the render time rather than the file format (AE's lossless AVI
  and ffmpeg were measured good to 7.99 GiB) ... or raise it with
  {maxIntermediateGB} if the disk has room - that is safe." A caller told
  only "the limit is 8 GB" reads it as "the file cannot be bigger" and
  shortens an export that never needed shortening. This project's
  grounded-error rule applied to a number.
- `extension/js/ffmpeg.js`: **the comment under `estimateIntermediate`
  was wrong.** It claimed "3 640 B/frame at 1920x1080" and generalised
  it. That figure came from the TWO-frame render it was measured on,
  where a fixed ~7 KB of AVI header and index divided by two frames looks
  like a per-frame cost. Over long files the overhead is nearly all
  fixed, so the share collapses:

        frames     file bytes        over the raw floor    per frame
            2      12 448 880               7 280            3 640
           60     373 257 600               9 600              160
          900   5 598 817 144              97 144              108
         1380   8 584 826 232             122 232               89

  The gap a caller must allow for is **~0.0015% of an export-sized
  master, not 0.06%** - which is why the disk guard's 1.1x headroom is
  not tight even at the cap. The estimate itself is unchanged and is
  still a true FLOOR; only the story about it was wrong.

### Verification

- **`tests/test-ffmpeg-export.js` 138 -> 154 checks.** Every `bytes`
  above is a real file, replayed as a fixture, and the estimate is held
  to both properties that pull opposite ways: it must never EXCEED the
  file (the disk guard would refuse exports that fit) and must stay
  within 0.3% (the guard would let the disk fill). A second block pins
  the arithmetic that put the two renders on either side of the
  boundaries, so a change to `estimateIntermediate` cannot quietly move
  the shipped cap off the span that was actually tested - had anyone
  "corrected" the estimate by the old comment's 3 640 B/frame, the
  1380-frame floor assertion would fail.
- Reverting the two source files fails **2** of the new checks (the
  refusal wording); the field-data block passes either way by design,
  because it guards the estimate going forward rather than the comment.
- **Full stub sweep: 60/60 test files exit 0.**
- **Real-AE harness 532/532** before and after. No suite steps: the
  change is panel-side, and a multi-gigabyte render has no business in a
  suite that has to finish.
- `capability-report.js` regenerated and `test-capability-doc.js` green;
  the pass ships no tool, and the curated half gained the measurement.
- The probe cleans up after itself: the master and every reference file
  are unlinked, and the project sweep removes the comp **and its two
  solid SOURCES** - a solid source outlives the comp that held it, which
  is the same leak 0.10.12 rebuilt the suite's cleanup for. Verified:
  "project cleanup removed 3 item(s)" on all three runs.

### Version: PATCH bumped to 0.10.17

A fix to shipped behaviour, not a feature: the refusal a user and the
model both read was misleading about what it was refusing, and the feed
is the only thing that reaches an installed panel.

### Notes for whoever runs the next pass

- The probe is repeatable and cheap now that it exists:
  `node scripts/riff-boundary-probe.js --seconds 46`, ~30 s of render
  plus ~40 s of decoding, `--keep` to leave the master, `--dir` to put it
  somewhere other than TEMP. It smoke-tests honestly at `--seconds 2`
  (one deliberate FAIL, the "past 4 GiB" check).
- **Not measured, and the obvious next question if anyone cares:** where
  the writer ACTUALLY breaks. This pass proved 7.995 GiB good and stopped
  there because that is the shipped cap's own edge; nothing here says a
  16 GB or 64 GB master works, so raising the DEFAULT would need its own
  render. Raising it per-call with `{maxIntermediateGB}` is what the new
  message calls safe, and within the measured range it is.
- Machine state: AE left on the harness's own project, no dialog open,
  nothing left in TEMP (checked). No llama-server or ComfyUI was started
  or stopped by this pass.
- Still open from earlier passes, unattempted tonight: the `DroverLord -
  Window Class` popup (no new evidence); item 7's catalog VRAM delta
  (~36 GB of weights and a human's decision); no panel UI for the mogrt
  export tools; no `.webm`/`.webp` (a remote-session call); and
  `comfy_generate` still calls `import_file` rather than 5.8's
  `import_as_layer` - which the workplan puts OUT OF SCOPE for the local
  session ("wiring generation into 5.8's round-trip" is remote), so it
  should probably stop being listed here as if a local pass could take
  it. The 8 GB cap flag is now struck after twelve passes carried it.
- `release-notes.txt` still reads "0.10.0" while the feed now ships
  0.10.17. Remote session's release cut.

## 2026-08-30 (local) - the popup that was never a dialog, and the two
## windows nobody had ever watched a run put on screen

Harness green on arrival, 532/532, so the pass took the only thing left
open under item 1: **what is the `DroverLord - Window Class` popup?** The
2026-08-30 pass that filed it could not make it happen again and said so.
This pass did not make it happen again either. It identified it anyway,
by photographing every window After Effects owns instead of waiting for
the one that misbehaves.

### The tool: scripts/ae-window-census.ps1

The harness's own probe looks at exactly as much as an unattended gate
needs - visible top-level popups, text read out of `#32770` and
DroverLord shells. That is the right amount of looking to decide "is AE
stuck" and the wrong amount to diagnose one. The census is the other
half: every top-level window of the AfterFX process INCLUDING the hidden
ones, with class, title, styles, owner, rect, and the whole descendant
tree read both ways - the `GetWindowTextW` that returns empty across a
process boundary and the `WM_GETTEXT` that does not. `-Seconds n` watches
and logs every change; the change poll is top-level only and the
expensive read happens once, on the sample where something appeared,
because the watch runs BESIDE a real harness run and must not perturb the
thing it is measuring.

### `DroverLord - Window Class` is not a dialog class

It is Adobe's widget class. **Every window inside After Effects is one** -
frames, tab panels, view containers, the lot. The first census made that
obvious and made the old assumption ("Adobe's own toolkit shell", i.e. a
dialog) untenable.

Three measurements name the popup:

1. **The save-changes prompt's own `#32770` contains exactly three
   DroverLord children** reporting `OS_ViewContainer`,
   `OS_ViewContainer`, `OS_EditTextContainer`, plus an `Edit` whose
   WM_GETTEXT is the save sentence. That is the field capture's
   fingerprint, container for container.
2. **Every idle After Effects on this machine has a top-level DroverLord
   popup already there**, hidden: `hwnd=8707C4`, `WS_POPUP`,
   `WS_EX_NOACTIVATE`, unowned, wordless, parked at 0,0,0,0, one
   `OS_ViewContainer` inside it. A re-usable host for whatever AE floats.
3. **During a real self-test run AE creates those same containers as
   PARENTLESS TOP-LEVEL WINDOWS** - `OS_ViewContainer`,
   `OS_EditTextContainer` and a bare top-level `Edit`, WS_CHILD-styled
   with no parent, so `EnumWindows` hands them back as top-level.
   Captured 20+ times across four watched runs, all invisible.

So the popup that stopped a field run is **After Effects' own dialog
CONTENT, caught top-level before it was parented into its shell**. It can
never take focus. It was never a question anybody could answer.

### The fix: the property, not the name list

The 2026-08-28 fix was a list of two Windows class names (`SysShadow`,
`tooltips_class32`). This pass measured what made those two safe to
ignore, and it is a Win32 declaration, not a name:

    Script Alert            #32770  ex=00010101  owner=main window
    save-changes prompt     #32770  ex=00010101  owner=main window
    tooltips_class32                ex=00080088  TOOLWINDOW
    SysShadow                       ex=000800A8  TOOLWINDOW
    DroverLord popup host           ex=08000000  NOACTIVATE

**Both real AE modals carry neither flag**, are owned by the main window,
and disable it. `WS_EX_NOACTIVATE` cannot become the active window, so it
cannot be a dialog waiting for an answer; `WS_EX_TOOLWINDOW` is what both
pieces of chrome actually are. Fixed in both layers, as the SysShadow fix
was:

- `run-ae-selftest.ps1` - a top-level window carrying either flag is
  LISTED with the flags that discounted it (`{nonmodal ex=... owner=...}`)
  and deliberately not COUNTED. The popup counter is what makes the probe
  fall through to its honest "main window is disabled but no popup text
  could be read", and a run blocked by something only chrome stands
  beside must still reach that answer.
- `ae-dialog-triage.ps1` - a WORDLESS block so marked is discounted. A
  marked window that says something is still judged on what it says; the
  annotation is stripped before the words are counted, so it cannot
  itself read as a word.

**`CloseWordlessDialogs` was not widened.** It still posts WM_CLOSE to
`#32770` alone, which is what the workplan asked. And the change is
toothless in the worst case by construction: a real modal that somehow
declared itself non-activatable would be the only thing on screen, the
popup counter would stay at zero, and the run would still stop on the
note. The only behaviour that changes is a marked window standing NEXT
to AE saying it is executing our script.

### What the watch found that nobody had filed

Four runs watched at 250 ms turned up two windows no capture in this repo
had ever recorded, and both are live problems:

- **`Auto-Save Project`.** AE's own timed auto-save fires in the MIDDLE
  of a run and disables the script-progress window behind it. In all four
  of four runs, ~2.5 s each. It has a real title, so it read as
  `blocked` - and `blocked` gives up after three consecutive polls, 6 s.
  Two and a half seconds is not six, which is the only reason this has
  never cost a run here; a project big enough to take six seconds to save
  is a red run nobody could have explained. Added to
  `Get-AellProgressTitles`. The test proves it: reverted, `autosave reads
  as progress (got blocked)`.
- **`Analyzing Audio...`, and this is the more dangerous one.** The
  suite's `audio_to_keyframes` step raises a `#32770` with an **empty
  window title** whose name lives in an `Edit` child four levels down.
  The verdict layer reads titles, so it sees three containers and no
  words: `unreadable`, which gives up after 8 polls, ~16 s. Measured up
  for **~6.5 s of every single run**. Every harness run this project
  makes is already 40% of the way to dying on a dialog that is After
  Effects working on our own script - and it is a far better candidate
  for the lost field run than anything previously filed.

The harvest layer now names it, so evidence taken during those seconds is
no longer headlined UNRECOGNIZED DIALOG. **The verdict layer still cannot
see it**, and that is left open ON PURPOSE rather than smuggled into this
pass: the test pins the current behaviour (`analyzing-audio` reads as
`unreadable`) so nobody mistakes it for solved.

### Verification

- **`tests/test-selftest-runner.js` 132 -> 165 checks.** Every fixture is
  verbatim from real AE tonight. **Reverted against the pre-fix scripts
  it fails 9 assertions**, including `popup-host-beside-progress reads as
  running (got blocked)` and `autosave reads as progress (got blocked)`.
- The pair that proves the rule is about the FACT and not the class:
  an unannotated `DroverLord` popup STILL stops the run (both existing
  cases untouched, plus a new 12-poll timeline), while one that has
  declared it cannot take focus does not. Also pinned: a `{nonmodal}`
  window that says something is still `blocked`, and the popup host alone
  still stops the run at the eighth poll.
- **Full stub sweep: 60/60 test files exit 0.**
- **Real-AE harness 532/532, three consecutive runs after the change**
  (and four before it, all green, which is what let the watch run at all).
- Both .ps1 files re-checked pure ASCII by the suite's own assertion.
- The chrome filter's own "could not reproduce" note from 2026-08-30 is
  now closed: a hover grid across AE's window raises `tooltips_class32` +
  `SysShadow` on demand, 10 of 54 points. The earlier pass looked for
  them and wrote down that it had failed; they are reproducible.

### No version bump

`extension/` is untouched - the panel ships `extension/` alone and this
is harness tooling. Same call, for the same reason, as the 2026-08-28 and
2026-08-30 dialog-triage passes.

### Notes for whoever runs the next pass

- **The next item is specified and it is a BUILD, not a probe**: give the
  verdict layer the `Analyzing Audio` discriminator. Everything it needs
  was measured tonight. That dialog is **owned by the script-progress
  window** (`owner=<the "Executing Script" #32770>`), whereas a script's
  own `alert()` is owned by the MAIN window - measured, both of them. So
  "a wordless popup owned by AE's script-progress window is our script
  working, not our script stuck" is a fact the probe can annotate exactly
  the way it now annotates `{nonmodal}`. Filed in WORKPLAN item 1.
- One more latent one, seen but NOT visible and so not fixed: a
  detached top-level `DroverLord - TabPanel Window` carries no
  `WS_EX_NOACTIVATE` and a title that is not a progress name, so if one
  were ever caught visible it would read as `blocked`. Never observed
  visible in four runs; written down rather than guarded against.
- `scripts/ae-window-census.ps1` is the tool to reach for next time
  anything about AE's windows is in question: `-IncludeHidden` for one
  census, `-Seconds n -Out <file>` to watch a run. It writes its log at
  the END, so a watch that is killed leaves nothing - worth fixing if
  anyone leans on it.
- Machine state: AE left running on `logs\mogrt60\P60-scratch.aep`, three
  green runs behind it, no dialog open. This pass deliberately raised two
  real dialogs to measure them - a Script Alert and the save-changes
  prompt - and dismissed both (the save prompt with WM_CLOSE, which is
  Cancel: the project was not closed). `%TEMP%\aell-modal-flags.jsx` and
  `%TEMP%\aell-save-prompt.jsx` can be deleted. The census log is under
  `logs\`, which is gitignored.
- Still open from earlier passes, unattempted tonight: item 7's catalog
  VRAM delta (~36 GB of weights, a per-model template and a human's
  decision); no panel UI for the mogrt export tools; no `.webm`/`.webp`
  (a remote-session call). `release-notes.txt` still reads "0.10.0" while
  the feed ships 0.10.17 - remote session's release cut.

## 2026-08-30 (local) - item 1: the dialog After Effects raises for our
## own script, and the 7.5 seconds every run spent halfway to exit 4

Harness green before the pass (532/532), so this took the single item
the previous pass filed and specified: give the VERDICT layer a way to
see `Analyzing Audio...`. That pass had named it for the evidence layer
only and deliberately left the verdict half open, with the
discriminator measured and written down. This is the build.

### The problem, restated from the run that was watched tonight

`audio_to_keyframes` raises a `#32770` whose window TITLE IS EMPTY -
the words live in an `Edit` child four levels down, reachable only by
WM_GETTEXT, which is what the evidence layer uses and the verdict layer
cannot. So the verdict layer sees three containers and no words:
`unreadable`, a verdict that gives up after 8 consecutive polls.

Watching the harness's OWN probe (the `$win32` here-string, extracted
out of run-ae-selftest.ps1 so the shipping code was what got measured)
at 200 ms through a real 532/532 run:

    24.13s verdict=unreadable    ... 31.71s
      [#32770]
        OS_ViewContainer
        OS_ViewContainer
        OS_EditTextContainer
      [#32770] Executing Script aell-selftest-run.jsx...

Seven and a half seconds of a ~35 s run, flapping `unreadable` /
`clear` as AE toggles which window is disabled. On a 2 s poll that is
close to four samples of an eight-sample clock - **every run this
harness makes has been running at about half the patience it appears
to have, on a window that is proof the suite is being executed.** The
flapping is the only reason it has never actually killed a run here,
and flapping is not a guarantee: it depends on a poll phase, a machine
speed and an audio layer's length, none of which are pinned.

### The discriminator, re-measured rather than taken on trust

`scripts/ae-window-census.ps1` at 200 ms across a real run, and then a
`Script Alert` raised on purpose through `AfterFX.exe -r` and measured
the same way:

    Analyzing Audio   #32770  ex=00090121  owner=20780896  title=''
    Executing Script  #32770  ex=00010101  owner=170224    (hwnd 20780896)
    Auto-Save Project #32770  ex=00010101  owner=170224
    Script Alert      #32770  ex=00010101  owner=170224
    AE_CApplication            ex=00000100  owner=0        (hwnd 170224)

The audio dialog is owned by **the script-progress window**. Everything
that is or could be a QUESTION - the alert, the save prompt, auto-save,
the progress window itself - is owned by the MAIN window. That holds
without reading a single word, which is the whole point: this dialog
cannot be identified by what it says from the layer that has to judge
it. Note also `ex=00090121` carries neither WS_EX_NOACTIVATE nor
WS_EX_TOOLWINDOW, so the existing `{nonmodal}` filter could never have
reached it.

### The fix, both layers

- **`run-ae-selftest.ps1`** - `OnFindProgress` locates AE's
  "Executing Script ..." window **in a pass of its own**, and this is
  the part that is easy to get wrong: `EnumWindows` walks the Z-ORDER,
  top first, so a dialog the running script raised is enumerated BEFORE
  the window that owns it. A single pass would never hold the handle at
  the moment it needed it. `OnTop` then marks any popup whose
  `GetWindow(h, GW_OWNER)` is that window:
  `[#32770] {scriptowner ex=00090121 owner=94F0B68}`.
  Unlike the chrome filter, a marked popup is still **counted** and
  still **read for its children** - it is a real dialog, and the
  annotation is a fact about it, not permission to stop looking.
- **`lib/ae-dialog-triage.ps1`** - a WORDLESS block so marked sets
  `SawProgress`, the same flag the progress window sets, because it is
  the same evidence: AE is working on our script. A marked block that
  says ANYTHING falls through to the word test and can still block.

Nothing was widened that answers dialogs: `CloseWordlessDialogs` still
posts WM_CLOSE to `#32770` alone, and `Get-AellStaleDialogPlan` is
gated on `unreadable`, so the audio dialog moving to `running` makes
the harness strictly LESS likely to close something AE is using. That
is pinned by a test rather than left as an argument.

### Verification

- **Real AE, after the fix, same watch: `unreadable` does not occur in
  a whole run.** Seven distinct `unreadable` states before, zero after;
  the run's verdicts are now 10 `clear`, 10 `running`, 1 `startup`. The
  probe emits `{scriptowner ex=00090121 owner=94F0B68}` - the same `ex`
  the census measured, a per-launch owner handle.
- **`tests/test-selftest-runner.js` 165 -> 187 checks**, fixture
  verbatim from tonight's capture. **Reverted against the pre-fix
  scripts it fails 15 assertions.**
- The rails, each its own case: the same window UNMARKED still stops
  the run at the eighth poll; a marked popup that says something is
  `blocked`; a marked popup does not vouch for a different wordless
  popup in the same sample; a marked popup beside a real modal is
  `blocked`; and the stale-dialog planner refuses to WM_CLOSE it.
- **Full stub sweep: 60/60 test files exit 0.** Harness 532/532, three
  runs tonight (one before the change, two after). Both .ps1 files
  re-checked pure ASCII by the suite's own assertion.

### Version

`node scripts/bump-version.js patch` -> 0.10.18. This is harness
tooling and `extension/` is untouched, which is the same shape as the
2026-08-28 and 2026-08-30 dialog passes that did NOT bump - but those
were called for their own reasons and the standing instruction for this
session is to bump a patch on any verified push, so it is bumped. If
the remote session would rather harness-only changes never move the
feed, say so here and the next pass will follow it.

### Notes for whoever runs the next pass

- The watcher that made this measurable is worth rebuilding when needed
  and was NOT committed (it lived in gitignored `logs/`): it reads
  `run-ae-selftest.ps1`, pulls the `$win32` here-string out with
  `(?s)\$win32 = @'\r?\n(.*?)\r?\n'@`, `Add-Type`s it, dot-sources the
  triage lib, and prints `FindDialog` + `Get-AellDialogVerdict` on every
  CHANGE. Measuring the shipping probe rather than a copy of it is what
  made the before/after comparison mean anything.
- Still latent, seen but never seen VISIBLE: a detached top-level
  `DroverLord - TabPanel Window` carries neither flag and a title that
  is not a progress name, so it would read as `blocked`. Written down,
  not guarded against.
- Machine state: AE left running on `logs\mogrt60\P60-scratch.aep`, no
  dialog open. This pass raised one Script Alert on purpose and
  dismissed it with WM_CLOSE. Scratch under `logs\audio-owner\` and
  `%TEMP%\aell-alert-owner.jsx` were deleted.
- Still open from earlier passes, unattempted tonight: item 7's catalog
  VRAM delta; no panel UI for the mogrt export tools; no `.webm`/
  `.webp`. `release-notes.txt` still reads "0.10.0" while the feed ships
  0.10.18 - remote session's release cut.

## 2026-08-30 (local) - item 7: the number the catalog had been guessing,
## and the weights the panel can see but the backend cannot (0.10.19)

Harness green before the pass (532/532), so this took the last bullet in
the whole workplan that is still open: item 7's catalog VRAM delta. The
SIZE and URL halves were settled 2026-08-30 (0.10.11); every `minVramGB`
in `COMFY_CATALOG` was still a training guess and every entry still said
`measured: false`.

That number is not decoration. `tiers.js entryFits()` gates an entry on
`vram < entry.minVramGB` and the comment above it says what the gate
means: *can this entry run on this machine at all*. A wrong one either
offers a card a model it cannot hold, or hides one it can.

### The instrument

`scripts/catalog-vram-probe.js`, built this pass. It drives the REAL
panel path - settings.js + tiers.js + setup.js + comfy.js + tools.js -
so what gets measured is `comfy_generate` and not a hand-rolled queue
post. Three decisions in it, each paid for by an earlier pass:

- **The floor is established, not glanced at.** `nvidia-smi memory.used`
  is the whole card, and a generation that ran ten minutes ago may still
  hold 19 GB. So the probe POSTs `/free` and then waits for twelve
  consecutive samples to agree within 64 MiB before it writes the idle
  number down. 0.10.15 is why: it measured this backend sitting at
  23 654 MiB for ten seconds and dropping to 2 918 one second later. A
  floor read on a timer would have been that 23 654, and every delta
  after it would have been understated by 20 GB.
- **The witness is one streaming process, not a timer.**
  `nvidia-smi --query-gpu=memory.used -lms 250` is a single child
  printing four readings a second. `comfy-probe.js` samples with
  execFile every 4 s, which is fine for "did it use the GPU" and useless
  for a peak - a VAE decode spike is shorter than one sample.
- **It never touches After Effects.** `import: false`. The catalog
  question is about the card.

`--list` answers what this machine can measure with no GPU work at all,
and that answer was itself worth having:

    skip     sd15         (no workflowTemplate - the panel ships no graph)
    skip     sdxl         (no workflowTemplate)
    RUNNABLE krea2        (AE_LLAMA_KREA2_V1, 18109 MiB on disk)
    skip     ltx-small    (no workflowTemplate)
    skip     wan22-5b     (no workflowTemplate)
    RUNNABLE minimax-h3   (AE_LLAMA_H3_I2V_V1, 40503 MiB on disk)
    skip     minimax-h3-int8 (no workflowTemplate)

The weights a template loads are read out of the GRAPH, not out of the
catalog entry - 0.10.9's lesson, that an entry's `urls`/`files` and what
the shipped template names are two different lists. The H3 total the
graph produced, 40 503 MiB, matches the entry's own `sizeMB` exactly,
which is a free cross-check on 0.10.11's work.

### krea2: the catalog was wrong by a factor of two

Three runs on the 5090 (32 607 MiB), ComfyUI 0.32.0, idle floor
2861-2867 MiB every time:

| run | size out | idle | peak | DELTA | seconds |
|---|---|---|---|---|---|
| authored, seed 12345 | 3072x1728 | 2861 | 26 897 | **24 036 MiB** | 32 |
| authored, seed 4242  | 3072x1728 | 2867 | 27 027 | **24 160 MiB** | 32 |
| `--width 1024 --height 1024` | 1640x1640 | 2867 | 23 667 | **20 800 MiB** | 18 |

The two authored runs are 124 MiB apart (0.5%), so the number
reproduces. The catalog claimed **12 GB**.

The third row is the one that settles the argument, because the obvious
objection to a measurement taken on a 32 GB card is that PyTorch
allocates greedily when there is room. Cut the frame to a third of the
pixels and the cost only falls to 20 800 MiB - because the floor is the
WEIGHTS, and this entry's own three files are 18 109 MiB. That part
needs no GPU at all: a 12 GB card cannot hold 17.7 GiB of weights, so it
must page ~6 GiB of them every step, and 0.10.14 measured what this
backend does when a job outgrows the card - it does not OOM, it GRINDS
(33 s/it on pass one, 92 s/it on pass two, no exception, no end).

So `minVramGB` 12 -> **24**, `measured: true`, and the reading rides IN
the entry rather than in a comment: `measuredVramMB: 24160`,
`measuredSeconds: 32`, `measuredAt` (the pixel size, which is half the
number), `measuredOn` (the card).

**Ripple, checked rather than assumed** - `recommendGen` across the
ladder now reads:

    8 GB -> image=sdxl   12 GB -> image=sdxl   16 GB -> image=sdxl
    24 GB -> image=krea2   32 GB -> image=krea2

which is the intended effect: a 16 GB card is no longer offered a model
whose weights alone are larger than its card.

### minimax-h3: attempted, blocked, and the blocker is a shipped defect

The probe got as far as the queue and ComfyUI refused the graph:

    node 129 (VAELoader): Value not in list - vae_name:
    'minimax_h3_video_vae_fp16.safetensors' not in [...
     'minimax_h3_video_vae_int8_convrot.safetensors', ...]

Chased with `/object_info` rather than guessed at. The running backend
sees **none** of the four H3 weights - no `minimax_h3_fl2va_*` unet, no
`qwen3vl_32b_minimax_h3_nvfp4_awq` encoder, neither H3 VAE. All four
live only in `AppData\Local\Comfy-Desktop\ComfyUI-Shared\models`, and
this instance was launched with `--base-directory` pointing at
`Documents\ComfyUI`. There is no `extra_model_paths.yaml` anywhere on
the machine.

**That is not a probe problem, it is the panel's.** `comfyModelRoots`
(0.10.13) was widened to include that shared store precisely because the
panel had priced the H3 template at null on a machine that had already
rendered with it. The fix was right for the arithmetic and it created a
second, worse failure: the panel now believes 40 503 MiB of weights are
available, prices the job, and on a 32 GB card that means **stopping the
chat model to make room** - and only then does ComfyUI say it cannot
load any of them. The user pays a full handoff for a job that was never
runnable.

The two questions are genuinely different and both sources are needed:
the DISK knows how big a weight is (`/object_info` has no sizes), and
the BACKEND knows whether it can load it (the disk cannot know the
search path). Filed in WORKPLAN as its own item with the shape of the
fix - check the chosen template's weights against `/object_info` before
the arbiter acts, and refuse early naming the missing files AND where
they are on disk, because that sentence is the one that tells a user
their backend is pointed at the wrong root.

I did NOT restart the owner's ComfyUI to unblock it. It is their
instance, 0.10.9 established `Comfy.ensureRunning` cannot start the
working 0.32.0 here, and a restart under an unattended pass could leave
the machine with no backend at all.

### Two smaller things the pass measured, filed not fixed

- **Four of seven catalog entries have no bundled template** (`sd15`,
  `sdxl`, `ltx-small`, `wan22-5b`) and `recommendGen` offers them
  anyway. Pre-existing, but the krea2 correction just made it the COMMON
  case: every card under 24 GB is now recommended `sdxl` for image, and
  `comfy_generate` cannot render it. Remote session's call.
- **The KREA2 template upscales 1.6x**, so `comfy_generate {width: 1024,
  height: 1024}` returns 1640x1640 (and the authored 1920x1080 latent is
  why the default output is 3072x1728). Deliberate in the graph - 0.9.23
  substituted `LatentUpscaleBy` for `SesquiLatentUpscale` exactly so it
  would NOT shrink - but `width`/`height` are documented to the model as
  the output size and they are not it.

### Verification

- **Three real generations on the real GPU**, numbers above; the two
  authored runs agree to 0.5%.
- **`tests/test-model-catalog.js`** carries the bug class, not the
  instance: an entry with `measured: true` must carry all four reading
  fields, `measuredAt` must name a pixel size, and `minVramGB * 1024`
  must cover `measuredVramMB`. Reverting the gate to 12 fails 3
  assertions; setting `measured: true` on an entry with no reading fails
  8. It also now fails a `workflowTemplate` naming a file the bundle does
  not contain.
- **Full stub sweep: 60/60 test files exit 0.**
- **Harness 532/532**, before and after.

### Version

`node scripts/bump-version.js patch` -> 0.10.19. This changes shipped
behaviour: `entryFits` is panel code and a 16 GB card's image
recommendation is different after it.

### Notes for whoever runs the next pass

- **Do not re-attempt minimax-h3 without reading the blocked section
  above.** It is one restart away from measurable, but the restart is
  the owner's to make - or the filed `/object_info` item lands first, in
  which case the panel will say so out loud and the probe will too.
- `logs/catalog-vram/` holds the three PNGs and the
  `logs/catalog-vram-probe-*.md` transcripts; both are gitignored.
- Machine state: AE running, no dialog open, project untouched (the
  probe never imports). ComfyUI still up on 8188, queue idle, card back
  to 2 870 MiB.
- Still open elsewhere: no panel UI for the mogrt export tools; no
  `.webm`/`.webp`. `release-notes.txt` still reads "0.10.0" while the
  feed ships 0.10.19 - remote session's release cut.

## 2026-08-30 (local) - item 7: the weights the panel could see and the
## backend could not, and the handoff paid for a job that never ran (0.10.20)

**Item:** WORKPLAN 7, the item the previous pass filed rather than fixed -
"the panel decides a model is available by looking at the DISK, and the
backend decides by its own search path. On this machine the two disagree
today."

Harness green at 532/532 before the pass and after it, so item 1 did not
claim the night. Sections 1-6 are struck; this was the highest-priority
item that could actually move (the remaining catalog VRAM entries need
~26 GB downloaded and templates the panel does not ship, and minimax-h3
is blocked on exactly the defect below).

### The disagreement, reproduced before anything was written

`/object_info` against the running ComfyUI 0.32.0, per node of each
shipped template:

    AE_LLAMA_KREA2_V1    3 weight slots, 3 present
    AE_LLAMA_H3_I2V_V1   4 weight slots, 4 MISSING

    node 129 VAELoader.vae_name  minimax_h3_video_vae_fp16.safetensors
    node 130 VAELoader.vae_name  minimax_h3_audio_vae_fp32.safetensors
    node 137 CLIPLoader.clip_name qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
    node 148 UNETLoader.unet_name minimax_h3_fl2va_pruned_int8_convrot.safetensors

and the panel prices that same template at **40 503 MiB** off the disk,
because all four files really are in `%LOCALAPPDATA%\Comfy-Desktop\
ComfyUI-Shared\models` where `comfyModelRoots` (0.10.13) looks. So on a
card that cannot hold both, the arbiter stopped the chat model, warmed
ComfyUI up, and only then heard `Value not in list`. The user paid a full
handoff for a job that was never runnable.

### The fix, and the rule that makes it safe

`Comfy.missingWeights(comfyUrl, graph, cb)` walks the API-format graph,
fetches `/object_info/<class>` once per CLASS (the H3 graph has two
VAELoaders), and compares each node's file-valued input against the combo
list the server itself declares. `comfy_generate` asks it BEFORE the
arbiter acts and refuses with the sentence that tells a user their backend
is pointed at the wrong root - every missing file, the node and input
ComfyUI would have failed at, and where the file sits ON DISK:

    ComfyUI at http://127.0.0.1:8188 cannot load 4 of this workflow's
    weights, so the generation would fail even after freeing VRAM for it.
    Missing from the backend's own model list:
    minimax_h3_video_vae_fp16.safetensors (node 129 VAELoader.vae_name, on
    disk at C:\Users\...\ComfyUI-Shared\models\vae\...); [...] Every one of
    those files IS on this machine, so the running ComfyUI is searching a
    different models tree - point it at them (extra_model_paths.yaml, or
    the --base-directory it was started with) and try again.

Both sources stay, because they answer different questions: the DISK knows
how big a weight is (`/object_info` carries no sizes, and size is what the
arithmetic runs on), the BACKEND knows whether it can open it.

**The rule that decides whether this is shippable is SILENCE.** A check
that guesses is worse than no check, so every case it cannot answer passes
over without a word: a class the server does not know, an input the class
does not declare, a LINKED input, a value that is not a weight filename,
and an unreachable backend. It can therefore only ever refuse a weight
ComfyUI would itself reject. Two of those are not hypothetical - the real
`vae_name` list carries `pixel_space`, a non-file choice, and `UNETLoader`
carries `weight_dtype`, a mode; calling either a missing weight would send
a user hunting for a file that never existed.

A near-miss is still a miss, and this machine proves it: the backend DOES
list `minimax_h3_video_vae_int8_convrot.safetensors`, a different
quantization of the same model, and the template names the fp16.

### The ordering trap this pass walked into

The check needs a RUNNING backend, so the first version hoisted
`Comfy.ensureRunning` ahead of the arbiter - and `test-vram-arbiter.js`
caught it immediately: a pause-"never" refusal that the arithmetic alone
can reach was now BOOTING a backend on its way to refusing. `planFor` was
split out precisely because it is the decision with no side effects, so
the order is now: planFor refusal (free) -> boot -> weight check ->
handoff. Pinned by a test of its own; the stub suite caught this, not the
field.

### Verification

- **`scripts/weight-availability-probe.js`, 11/11 verdicts on the real
  backend.** It drives the panel's own code (settings + tiers + comfy +
  tools) and asserts invariants rather than reading a table: a listed
  template is never refused; a blocked one is, naming every file and
  locating all 4/4 on disk; the panel still prices it at 40 503 MiB (the
  disagreement, as a number); an unreachable backend refuses nothing; and
  the refusal comes back through the REAL `comfy_generate` with
  `llama.stop` never called and the graph never queued - on a job
  `planFor` independently calls a `handoff`, so the saved churn is not a
  vacuous pass.
- **`tests/test-weight-availability.js`, 33 checks**, replaying the
  machine's real `/object_info` lists (trimmed, not invented). Mutation-
  tested: moving the weight check back after the handoff fails the
  ordering assertion with the whole trace printed (`comfy.ensure,
  llama.stop, comfy.free, llama.start`).
- **Full stub sweep: 61/61 test files exit 0.** capability-report
  `--check` and workflow-hash-history `--check` both fresh.
- **Harness 532/532**, before and after.

### Version

`node scripts/bump-version.js patch` -> 0.10.20. Shipped behaviour: a
generation the backend cannot load is now refused early instead of after
a handoff.

### Notes for whoever runs the next pass

- **minimax-h3's VRAM measurement is now one step less blocked.** The
  panel says out loud what is wrong, and so does the probe, but the
  weights are still invisible to the owner's instance - it is launched
  `--base-directory Documents\ComfyUI` and there is no
  `extra_model_paths.yaml` on the machine. Fixing that is the OWNER's
  call (restarting their ComfyUI under an unattended pass could leave the
  machine with no backend at all), so do not re-attempt the measurement
  without reading the 0.10.19 entry first.
- Machine state: AE running, no dialog open, project untouched (nothing
  this pass ran imports). ComfyUI still up on 8188, queue idle - the probe
  never queues a graph, by design.
- Still open elsewhere: sd15/sdxl/wan22-5b VRAM (needs ~26 GB downloaded
  AND templates the panel does not ship); four catalog entries with no
  `workflowTemplate` that `recommendGen` offers anyway (remote session's
  call); no panel UI for the mogrt export tools; no `.webm`/`.webp`.
  `release-notes.txt` still reads "0.10.0" while the feed ships 0.10.20 -
  remote session's release cut.


---

## 2026-08-30 — the size the panel asked for and the size it got (0.10.21)

**Item:** WORKPLAN 7, the last unstruck bullet that could move — *"one
measured oddity, logged not fixed: the KREA2 template upscales 1.6x, so
`comfy_generate {width: 1024, height: 1024}` returns a 1640x1640 image
... `width`/`height` are documented to the model as the output size and
they are not."*

Harness green at **532/532** before the pass, so item 1 did not claim the
night. Sections 1-6 are struck. Of what remains in section 7, sd15 /
sdxl / wan22-5b need ~26 GB downloaded and templates the panel does not
ship, minimax-h3 is blocked on a backend that cannot see its weights
(0.10.19 / 0.10.20 — do not re-attempt), and the four template-less
catalog entries are filed for the remote session. This was the item.

### What the defect actually was

Not the graph. The 1.6x upscale is deliberate — 0.9.23 substituted
`LatentUpscaleBy` for `SesquiLatentUpscale` precisely so a machine
without the pack would not render SMALLER — and changing it would mean
running the first pass at 640 for a 1024 request on a model authored at
1920x1080. The defect is that **nobody said so, at either end**:

- the tool told the model `width`/`height` were the output size;
- and the panel could not have corrected itself if it wanted to, because
  `import_file` returned `{name, id}` and nothing else. The panel imported
  a 1640x1640 file into the user's project and the only record of its
  size anywhere was the file.

So every decision made after a generation — a comp built to hold it, a
scale, a position — was made from the number that had been REQUESTED.

### The fix, both ends

**1. Say what the size becomes (`extension/js/comfy.js`).** `injectParams`
now records every node whose size it set, and `outputScaleFrom` walks
FORWARD from each one, through consumers, to the node that writes a file,
accumulating the factor. One line lands in `applied`:

    size 1024x1024 on node 500 is enlarged 1.6x before this template
    saves, so the file will be 1640x1640 - width/height set the size it
    GENERATES at, not the size it writes

The arithmetic is the node's own, and that detail is the whole test:
1024 x 1.6 is 1638.4, but a LATENT upscale lands on the /8 grid and
multiplies back out, so the answer is **1640**. Predicting 1638 would
have been a plausible-sounding lie.

**It is silent by the same rule the weight check ships under (0.10.20):**
an upscale whose factor lives in a `.pth` rather than in a widget, a
factor behind a link, a widget that is not a positive number, two output
branches that disagree, a chain reaching no output at all, and a caller
who set no size — every one of those produces nothing rather than a
number that might be wrong. An absolute resize downstream RESETS the
factor to 1, because `injectParams` has just written the caller's own
numbers into it and from there the request is the truth again.

**2. Measure what was imported (`extension/jsx/hostscript.jsx`).**
`import_file` returns `width`/`height` — AE has measured the file by the
time `importFile` returns — plus `duration`/`frameRate` for media that
has them. A still reports NEITHER rather than zero, so "no duration"
cannot read as "0 seconds". The reads are guarded: `importFile` does not
always answer with an AVItem (an `.aep` comes back as a FolderItem) and a
host object with no `width` must not take the tool down. `comfy_generate`
hoists the measurement to `data.outputSize`.

`import_as_layer` already reported `sourceSize`, so it needed nothing.

### Verification

- **`scripts/output-size-probe.js` on the real card, both runs green.**
  It makes the prediction from the panel's own code BEFORE it renders,
  then reads the saved PNG's own IHDR header — the file the user gets,
  not ComfyUI's opinion of it:
  - 512x512 asked -> predicted 816x816 -> **measured 816x816**, 10 s.
    Plain arithmetic would have said 819, so the /8 grid is measured here
    rather than assumed.
  - 1024x1024 asked -> predicted 1640x1640 -> **measured 1640x1640**,
    14 s. That is the exact number this bullet was filed with.
  It never touches AE (`import: false`) and never calls the arbiter, so
  no chat model was stopped for it.
- **`tests/test-comfy-output-size.js`, 23 checks** — the note, the
  substituted class, an un-set dimension scaling with the template's own,
  image-space vs latent rounding, two upscales compounding, and seven
  distinct silences. Mutation-tested: replacing the /8-grid rounding with
  plain rounding fails 5 of them. The shipped template is replayed
  against both field numbers.
- **Real-AE harness: 533/533** (was 532 — the new step is *"import_file
  reports the size AE measured, not one we asked for"*, which is what
  proves AE really answers 240x180 and really omits duration and
  frameRate for a still; no stub could have settled that).
- `tests/test-frame-roundtrip.js` +5 checks against the real hostscript:
  a measured still, an audio file reporting duration and NO 0x0 size, and
  a FolderItem-shaped item whose every property throws.
- **Full stub sweep: 62/62 test files exit 0.** capability-report
  `--check` and workflow-hash-history `--check` both fresh.

### Assumptions written down

- **Report, do not compensate.** Pre-dividing the request by 1.6 would
  make `width` mean the output size, but it would also run a model
  authored at 1920x1080 at 1200x675 and change what it draws. The bullet
  itself calls the graph's behaviour deliberate, so the contract was
  corrected instead of the graph.
- **The note fires only when the caller SET a size.** A caller who passed
  none gets the template's authored size and no note — the mismatch this
  item is about cannot arise. The real size still comes back through
  `outputSize` either way.

### Version

`node scripts/bump-version.js patch` -> **0.10.21**. Shipped behaviour: a
generation says what size it will write, and an import says what size it
got.

### Notes for whoever runs the next pass

- Machine state: AE running, no dialog open, project untouched (nothing
  this pass ran imports into it). ComfyUI still up on 8188, queue idle;
  the two probe renders are in `logs/output-size/`, which is gitignored.
  The chat model was never stopped.
- **Section 7 now has nothing left that this machine can move on its
  own.** What is open there is open on someone else: sd15 / sdxl /
  wan22-5b want ~26 GB of weights AND templates the panel does not ship;
  minimax-h3 wants the owner to repoint their ComfyUI (see 0.10.19 and
  0.10.20 before touching it); the four `workflowTemplate`-less catalog
  entries that `recommendGen` offers anyway are filed for the remote
  session. A pass that finds no new harness failure should say so and
  stop rather than manufacture work.
- Still open elsewhere: no panel UI for the mogrt export tools; no
  `.webm`/`.webp`. `release-notes.txt` still reads "0.10.0" while the feed
  ships 0.10.21 — remote session's release cut.

## 2026-08-30 (remote session) — 0.11.0 cut: gen model manager + shared-store yaml + section 7b queued

- Changed: extension/js/tools.js (`catalogModelStatus` /
  `removeCatalogWeights` + helpers — status and fenced deletion of
  catalog weights; also replaced a literal NUL byte on the
  comfyModelRoots dedupe line with the `\u0000` escape, which had made
  the file read as binary to grep/diff, and deduped the doubled
  `_vramArbiter` export), extension/js/setup.js (`downloadGenWeight` +
  `_genWeightDest`), extension/js/comfy.js (`applyExtraModelPaths` now
  writes the Comfy-Desktop shared store into the hidden backend's yaml;
  exports `MODEL_SUBS`), main.js/index.html/style.css (per-model
  Download / Remove rows in the ComfyUI settings section),
  tests/test-gen-model-manager.js (40 checks), docs/CAPABILITIES.md
  (curated half), docs/WORKPLAN.md (new section 7b),
  scripts/run-local-agent.ps1 (bump rule: extension/ untouched = no
  bump), release-notes.txt (0.11 scope), version bump to 0.11.0.
- Harness: stub suite green in the remote container (the two known
  container-only skips: test-engine-assets spawns powershell,
  test-ffmpeg-export needs Windows output paths); real-AE verification
  of the new settings rows is queued as a 7b bullet.
- Notes: owner approved the section-7 downloads and the H3 yaml fix in
  plain words — 7b carries the exact scope, one bullet per pass,
  smallest first. The 8 GB intermediate question is closed (per-call
  `maxIntermediateGB`, disk guard not format limit). Remote-side items
  still open: rollback design review, `comfy_generate ->
  import_as_layer`, bundled ComfyUI installer (#21), Phase E.

## 2026-08-30 (remote session, later) — usefulness tests + NL matrix queued + log scrubber

- Changed: docs/USEFULNESS-TESTS.md (NEW — 30 scenarios with phrasing
  variants and useful/harmless/harmful verdicts; the `probe` column is
  the automation contract), docs/WORKPLAN.md (section 8: paraphrase
  matrix in chat-probe, owner-requested; section 9: evolution proposals
  for the owner to prioritize), scripts/run-local-agent.ps1
  (`Clean-Line`: strips ANSI escapes and control chars from captured
  CLI output, transliterates UTF-8 punctuation to ASCII — the log and
  console were showing escape codes and mojibake under Windows
  PowerShell 5.1's ASCII log encoding).
- Harness: docs + one .ps1 function; no extension/ change, NO bump (the
  new rule, applied). Stub suite untouched by these files.
- Notes: Clean-Line is UNPARSED by any real PowerShell (no pwsh in the
  remote container) — section 8's first bullet includes eyeballing the
  first new log; if the loop fails to start, that function is the first
  suspect. The NUL-byte class got a second hit today: the remote
  session itself pasted a literal NUL into THIS log while documenting
  the tools.js NUL fix (scrubbed same day) — worth remembering that the
  escape sequence renders as the character it names in some paste
  paths.

## 2026-08-30 (remote session, 15-agent audit) — AUDIT-0.11 + SELF-VERIFY-PLANS + sections 8-10 rewritten

- Changed: docs/AUDIT-0.11.md (NEW — function-state audit with
  file:line evidence, 12-item ranked roadmap, harness summaries),
  docs/SELF-VERIFY-PLANS.md (NEW — adversarially-refuted harness
  plans for MOGRT / captions / inpainting; the "Requirements from
  refutation" blocks are constraints), docs/WORKPLAN.md (section 8
  rescoped per the measured probe limitations, section 9 replaced by
  the ranked roadmap, NEW section 10 harness track),
  docs/USEFULNESS-TESTS.md (row count corrected 30 -> 31).
- Harness: docs only, no extension/ change, NO bump.
- Notes for the next passes: (1) LIVE BUG queued as section 10's
  first bullet — AELL_mogrtFound (hostscript.jsx:9482) trusts a
  possibly mid-write size; remote will ship the settle fix, local
  verifies. (2) The audit found more shipped defects the roadmap's
  item 1 carries: set_keyframes/apply_keyframe_ease partial-mutation
  errors never arm rollback, executeCommands silently slices at 20
  commands, comfy_generate{image} on KREA2 uploads then silently
  ignores the image, uploadImage collides by basename, two fitResult
  byte-slice fallbacks survive. None are field-reported yet; all are
  audit-verified against the code. (3) Section 8's old wiring plan
  was WRONG in a way that mattered: variance numbers on the current
  probe harness would overstate robustness (shared history, loose
  checks) — do the prerequisites first.

## 2026-09-01 (remote session) — zero-silent-failure gate built (roadmap item 1 + MOGRT step 0), UNBUMPED

- Changed: extension/jsx/hostscript.jsx (set_keyframes /
  apply_keyframe_ease return AELL_errPartial once anything landed, with
  the applied-count clause on every branch; grounded errors for
  apply_effect / set_effect_param / rename_item / delete_item /
  move_to_folder / set_track_matte via new AELL_itemNotFound /
  AELL_itemsHere / AELL_capJoin helpers; AELL_mogrtFound requires two
  stable sizes >=250ms apart; new AELL_mogrtNameTrap refuses reserved
  Windows device names — trailing dot/space deliberately NOT trapped,
  the on-disk name is tplName + ".mogrt" so they are interior),
  extension/js/tools.js (dropped-commands error row + RESPONSE_SCHEMA
  maxItems:20; both fitResult byte-slices replaced with whole-unit
  drops — the unserializable case now an ok-less outcome-unknown note
  so a landed mutation is never re-run), extension/js/comfy.js
  (uploadImage unique per-call name prefixes; image-landed fail-fast
  reading the MUTATED GRAPH before the /prompt POST, prompt check
  hardened onto the same mechanism, both checks run BEFORE
  expandFilenameTokens so a tokened prompt is not falsely refused),
  tests: test-round-rollback +133, test-mogrt, test-property-access,
  test-project-tools, test-tool-result-budget, test-undo-groups,
  test-comfy-inject, NEW test-comfy-image-landed; CAPABILITIES
  regenerated.
- Harness: full stub sweep 62/64 green in the container (the two
  Windows-only suites as always); every new check proven to FAIL on
  reverted code (worktree/git-show reverts, per-family).
- Notes: NOT BUMPED on purpose — WORKPLAN section 1b is tonight's
  first pass: real-AE verification of the stub-blind class (rollback
  arming, matte error texts, mogrt settle, image-landed refusal +
  H3 happy path), THEN the patch bump ships it. Known polish left on
  the table (filed, small): main.js does not render the
  dropped-commands row to the USER (model-visible only); the comfy
  refusal could name an optional-node resolution as the cause when
  one removed the target node.

## 2026-09-01 (remote session) — field failure: panel self-update blocked by pass 22's dirty tree

- What happened: the owner's panel (0.10.22-alpha — pass 22 had run
  the bump before being stopped, leaving the four bump files
  UNCOMMITTED) tried to auto-update to 0.11.0; `git pull --ff-only`
  refused on the uncommitted manifest.xml, and the panel's error cut
  git's stderr at byte 300 mid-word ("extension/CSXS/manifes"), so
  neither the file list nor a fix reached the owner. Owner was given
  the manual salvage+realign block (backup branch aell-backup-pass22
  + stash "pass22-salvage" + checkout -B onto origin).
- Changed: extension/js/setup.js `gitPullProblem` — whole stderr
  lines only (never a byte cut), fetch-progress noise filtered so the
  error line + file list always fit, and the two real states answered
  with their fix (dirty tree → the overnight salvage OR
  `git stash push -u`; non-FF → salvage then re-align onto origin,
  never merge the old history). tests/test-self-update.js grew the
  dirty-tree field case against a real git rig and pins the message
  contract.
- Harness: full sweep 62/64 (the two Windows-only suites).
- Notes: UNBUMPED — rides tonight's 1b patch bump. Local session:
  after 1b, check `git stash list` and `git branch --list
  aell-backup-pass22` on this machine — if the stash/branch hold only
  the stale 0.10.22 bump (expected), drop both and log it; if pass 22
  did real work, recover it per the log's own rules.

## 2026-09-01 (remote session, correction) — pass 22 DID real work; recover it

- The owner ran the reset block; `git status --short` beforehand
  showed pass 22 left EIGHT modified files, not four: the bump quartet
  plus extension/js/llama.js, main.js, tools.js, scripts/chat-probe.js
  and tests/test-history-trim.js — a history-trim change in progress
  (the test name says what it was for). No pass-22 log entry exists;
  the pass was killed before writing one. All of it is in stash
  `pass22-salvage`; branch `aell-backup-pass22` holds whatever HEAD
  was. The previous entry's "expected: only the stale bump" was wrong
  — WORKPLAN 1b now carries the recovery bullet (apply-and-verify, or
  document-and-drop; never silent drop).

## 2026-09-01 (remote session, daytime batch) — trigger layer + missing verbs + MOGRT verifier, UNBUMPED

- Built by three domain passes with fixed file ownership, each
  adversarially reviewed, review fixes applied by the original builders
  (their context) with the integrator owning the cross-file wiring.
- Changed — trigger layer (roadmap 2): extension/js/tools.js gains a
  "Plain-English requests" rules block (group/trim/attach/smoother/
  pivot/crop/un-animate/make-it-pop/drifting/see-through/sync-to-music/
  remove-effect/delete-mask/stacking) + the project-vs-comp "clean this
  up" split (the one exception to ACT, DON'T ASK: deletions nobody
  named) + the ON-SCREEN-vs-IN-THE-STACK "under" split (the review
  caught the collision with the get_bounds rule); docs carry ONE phrase
  each, rules carry the lists; "freeze it" removed (it means Freeze
  Frame); expression-driven motion routed to set_expression "". Prompt
  54,460 → 58,726 chars no-state (+7.8%; a first cut at +12.3% was
  trimmed after the budget review — see roadmap item 13).
  scripts/chat-probe.js: 15 appended steps (15-29), richer READ_COMP
  (anchor, opacity, sourceRect, mask boxes+mode+inverted, ease flags,
  expressions, matte, isPrecomp), a `prepare` hook, and a precomp-aware
  sweep (rememberPrecomp + sweepScript) — the review found the
  precompose step would have left a "Squares" comp + nine solids in the
  owner's LIVE project every run. tests/test-chat-probe.js ≈310 checks.
- Changed — missing verbs (roadmap 4): hostscript.jsx reorder_layers
  RELATIVE mode {layer, above|below|toFront|toBack} (type-checked — the
  review found {toFront:"Logo"} would have moved silently), NEW
  remove_effect + delete_mask with grounded listings, AELL_findMask
  accepts numeric strings; selftest 533 → 556 steps; stubs model
  removal-invalidation and refuse self-moves; tests/test-for-each-layer
  classifier carries an explicit reorder_layers exemption.
- Changed — MOGRT verifier (harness plan 1, steps 1-3): NEW
  extension/js/mogrt-read.js (zero-dep zip reader, windowed fd I/O —
  never a whole-file read on the CEP thread — definitionOnly mode,
  4 MB cap, readable:false for a file that could not be opened =
  UNJUDGED, roster read with rosterVia/rosterProvisional, nested
  groups, fallback requires a type key so a fonts list is never a
  roster), scripts/lib/mogrt-read.js, index.html script tag,
  tests/test-mogrt-read.js 105 checks (hand-built zips, independent
  CRC, Python zipfile cross-check recorded). export_mogrt's receipt
  gains controllerNames (read before the export); tools.js
  callHostTool runs verifyMogrtResult on every ok export → zipValid
  (true/false/null), controllersInFileCount, templateNameInFile,
  verifyNote (count-only parity when names are unreadable or capped;
  provisional roster reads are evidence, never verdicts).
- Harness: full sweep green in the container except the two
  Windows-only suites; docs/CAPABILITIES.md regenerated (79 tools).
- Notes: UNBUMPED — WORKPLAN 1c is tonight's verification, riding the
  same patch bump as 1b. New for the real-AE pass: which value
  remove_keyframes leaves behind (1c item 8). New roadmap item 13:
  the context budget was already over the default window before this
  batch (main.js's histBudget floor is negative at these prompt
  sizes) — a remote fix, stub-testable. Left for a later pass: the
  hostscript comment about the reorder helper's placement is now
  redundant with the classifier exemption (harmless).

## 2026-09-01 (remote session, evening) — roadmap 13: context budget, compact docs, the history ledger (UNBUMPED)

- Why now: the daytime batch's prompt (58.7K chars ≈ 15K tokens) plus
  ~1.5K tokens of state is AT the 16,384 default window — tonight's
  bump would have shipped a panel that overflows on ordinary rounds.
  And the code showed the panel was already "summarizing by
  forgetting": main.js's `max(4000, …)` history floor was negative at
  real prompt sizes, so most rounds carried one turn of memory.
- Changed — tools.js: `buildSystemPrompt(state, {compact, ledger})`;
  `compactDesc` (first sentence, ≤110 chars at a word boundary; args
  lines and the rules block untouched); `promptModeFor(ctx)` (compact
  under 24K); `historyBudget(ctx, systemChars)` (two measured-side
  ratios, reply reserve, the ledger's own 1,500-char slice, a
  `starved` flag); the reply-brevity rule; `fitHistory` now returns
  `ledger` — `rollupHistory` folds every dropped entry into one line
  of FUNCTION with no model call (user: first clause; assistant: tools
  + naming args + reply clause; results: ok/error counts + created
  names; SYSTEM control turns are not memory; paths collapse to
  basenames), oldest lines folding away under the cap with the count
  in the header. main.js: prompt form by window, ledger injected in
  the prompt tail, one-time "context ledger" and "context"
  (starvation) info lines. chat-probe.js mirrors all three.
  tests/test-history-trim.js +3 sections, tests/test-context-budget.js
  pins the full-prompt CEILING (59,000) so growth without a cut fails
  CI, the compact cut (>28%), rules-block identity, and the window
  arithmetic at 16K/32K.
- Harness: stub sweep green (two Windows-only suites as always).
- Notes: UNBUMPED, rides tonight's bump; WORKPLAN 1c carries the
  measurements (real /tokenize ratios, compact-mode routing via the
  probe, the ledger drive-past-the-window). Phase 2 (a model call to
  compress the ledger) is NOT built — measure whether it is worth the
  32B's latency first. Pass 22's stash touched this same area:
  reconcile on recovery.

## 2026-09-01 (local session, real AE) — WORKPLAN 1: harness red -> green. ExtendScript parses `?:` LEFT-associatively. UNBUMPED ON PURPOSE

- Item: section 1, "make the harness green (always first)". The run
  opened at **555/556**, so 1b/1c waited.

- The failing step was `below: ST Ord 3 goes under ST Ord 7`
  (reorder_layers relative mode, shipped by the remote daytime batch).
  The MOVE was correct — the read-back step passed and the stack was
  exactly right. What failed was the tool's own landing-slot check: it
  warned "AE reports 'ST Ord 3' at slot 7, not the expected 1" on a
  perfectly good move, i.e. it told the model a correct edit had gone
  wrong.

- **Root cause, and it is a whole bug CLASS, not one line.** Measured in
  real AE 2026, ExtendScript `$.version` 4.5.6 / build 80.1060872:

      true  ? 1 : true ? 2 : 3            -> 2      (ECMA says 1)
      false ? 1 : true ? 2 : 3            -> 2      (right by luck)
      false ? 1 : true ? 2 : true ? 3 : 4 -> 3      (ECMA says 2)

  **ExtendScript's conditional operator is LEFT-associative.** It groups
  `a ? b : c ? d : e ? f : g` as `((a ? b : c) ? d : e) ? f : g`, so the
  first branch's VALUE becomes the next condition. Confirmed identical
  in assignment, `return` and string-concat context; explicit nesting
  parens fix it. Every other engine — including the Chromium that runs
  the panel's own .js and the Node that runs tests/ — is right-
  associative, which is exactly why this hid: a two-level chain whose
  first test is FALSE still returns the right answer, and that is most
  of them.

- Fixed at the root, `extension/jsx/hostscript.jsx`, both sites the
  class had actually bitten:
  1. `AELL_reorderRelative`'s `want` (the harness failure): returned 1
     for every `below` move.
  2. `get_bounds`'s empty-layer advice: the three-way `shape / text /
     other` chain told an empty SHAPE layer **"the text is empty at this
     time"** — a grounded error pointing the small model at the wrong
     fix. Not field-reported; found by the scan, then confirmed by
     hand-evaluating the left-assoc grouping.

- Stub back-fill (both directions, since Node cannot reproduce the
  miscompute — it parses the same source correctly):
  - **NEW `tests/test-es3-ternary.js`** — a SOURCE lint that refuses any
    conditional nested directly inside another at the same bracket depth
    (the depth test IS the paren test: parenthesising pushes the inner
    `?` one level down). Comment/string/regex-literal aware with offsets
    preserved for honest line numbers. Carries 7 known-bad and 15
    known-good shapes so it cannot rot into a silent no-op. Scope is
    discovered the SAME way `tests/test-es3-syntax.js` discovers it
    (every .jsx AE compiles, plus the dual-target
    `extension/js/selftest.js`), so a new ExtendScript file cannot land
    in one lint's scope and miss the other's. Proven to FAIL on
    pre-fix HEAD (3 hits) and pass after.
  - `tests/test-get-bounds.js` +3 checks: each of the three empty-layer
    branches asserted by layer TYPE, and each asserted NOT to carry the
    other branches' wording.
- `CLAUDE.md` "Hard-won AE facts" carries the associativity rule with
  the measured numbers.

- **Harness: 556/556 PASSED.** Full stub sweep green except the one
  noted below.

- **NOT BUMPED — deliberate, please read.** HEAD already carries the
  remote session's 1b + 1c batches, which the WORKPLAN explicitly gates
  behind real-AE probes (rollback arming, matte error texts, mogrt
  settle, comfy image-landed) that this pass did not run. A bump here
  would have shipped all of that unverified, against 1b's own "all green
  -> bump" instruction. My fix is a warning-text / branch-selection
  correction, not a field-stopper, so it rides **1b's single bump**, the
  way the remote batches are already doing. Next pass: 1b is still the
  top item, and its bump now ships this too.

- **Pre-existing stub failure, NOT mine, and it is ENVIRONMENTAL:**
  `tests/test-comfy-backend.js` — "blank settings remove a previously
  written mapping" fails on THIS machine and passes in CI. Cause:
  `applyExtraModelPaths` (extension/js/comfy.js) also looks for
  `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models`, and this machine
  HAS it (the owner runs Comfy Desktop) — so with settings blanked the
  function correctly writes a mapping instead of returning null. The
  SHIPPED behaviour is right; the TEST is host-dependent. Fix for a
  later pass: stub `process.env.LOCALAPPDATA` in that test. Verified
  pre-existing by stashing this pass's changes and re-running.

- **Harness gap filed (cost this pass ~20 min, will cost the next one
  too).** An AE warning dialog that HAS text — here "After Effects
  warning: Undo group mismatch, will attempt to fix." — wedges every
  subsequent run: the stale-dialog cleaner only auto-answers WORDLESS
  popups, so the triage reports UNRECOGNIZED DIALOG forever and no `-r`
  script executes. Cleared by hand with `PostMessage(hwnd, WM_CLOSE)`.
  Worth teaching the cleaner to answer AE's own `After Effects warning:`
  dialogs (they are informational, single-OK), or at least to say
  "post WM_CLOSE to this hwnd" in the failure copy.

- **Self-inflicted, written down so the next pass does not repeat it:**
  my first probe wrapped `$.global.AELL_call(...)` inside its own
  `app.beginUndoGroup`/`endUndoGroup`. The host tools open their own undo
  groups, so the nesting desynced AE's undo stack — that is where the
  "Undo group mismatch" modal came from, and the aborted run then rolled
  the self-test comps back mid-suite and left probe debris (P1..P12
  solids) in the project. **Never wrap AELL_call in an undo group.**
  Recovered with `app.project.close(DO_NOT_SAVE_CHANGES)` +
  `app.newProject()` (the project was scratch, "Untitled Project.aep",
  no owner work), after which the suite went 556/556.

- Not attempted this pass (still open, in order): 1b, 1c, and the
  pass-22 salvage — `stash@{0}` is still `pass22-salvage` and branch
  `aell-backup-pass22` still exists, untouched by me.

## 2026-09-01 (local session, real AE) — WORKPLAN 1b: the zero-silent-failure batch VERIFIED, and the one hole it did not cover (0.11.1)

- Item: section **1b**, verify the remote's 2026-09-01 zero-silent-failure
  batch in real AE and ship it. Harness opened at **556/556**, so no
  section-1 work was owed. Every 1b bullet was run; the pass found one
  real defect of exactly the class 1b exists to catch, fixed it at the
  root, and bumped.

### The defect: `set_track_matte` reported success on a camera

Probed with a temp `.jsx` per CLAUDE.md. Measured in AE 2026,
ExtendScript 4.5.6:

- A `CameraLayer` and a `LightLayer` carry **no `setTrackMatte` and no
  `removeTrackMatte` at all** — `typeof` is `"undefined"`, not a
  function. So both fell straight through to the tool's legacy-AE
  branch.
- That branch does `matte.moveBefore(layer)` and then
  `layer.trackMatteType = tmt`. **ExtendScript ACCEPTS that assignment
  on a camera.** It does not throw; the camera reads back `5015` for
  LUMA. AE shows no matte, because a camera has no pixels to cut.
- Net effect: the tool **reordered the user's layer stack** (PSHAPE
  3 -> 2, PCAM 2 -> 3), wrote a phantom property, and returned
  `{ok: true, layer: "PCAM", matte: "PSHAPE", mode: "luma"}`. The
  existing try/catch could not see any of it, because nothing threw.
- `mode: "none"` lied the same way: `{matte: "removed"}` for a matte
  that never existed.

Fixed in `extension/jsx/hostscript.jsx`: `set_track_matte` refuses by
layer TYPE before anything moves, on both sides (target and
`matteLayer`), naming the layer, its measured type, the other layer's
type, and `get_comp_details`.

### The trap inside the fix — worth more than the fix

The first cut keyed the refusal off `!(layer instanceof AVLayer)`,
which reads like "is this a visual layer". **It is not.** Measured the
same night in real AE:

    solid  instanceof AVLayer -> true
    text   instanceof AVLayer -> FALSE
    shape  instanceof AVLayer -> FALSE
    camera instanceof AVLayer -> false
    light  instanceof AVLayer -> false

So that version locked text layers and shape layers out of mattes
entirely — and **the 556-step harness stayed green through it**,
because its one matte step uses solids. Only the probe caught it. The
shipped predicate is the specific class, read through `AELL_layerType`,
so the type word in the message and the branch that produced it can
never drift apart. `CLAUDE.md` "Hard-won AE facts" carries this now.

### Everything else 1b asked for, measured

- **set_keyframes partial -> rollback.** `keys[2].value = "banana"` (and
  `[1,2,3]`): `ok:false`, **`mutated:true`**, error quotes AE's raw
  message and "2 key(s) were applied before this"; 3 keys really were on
  the layer. An armed round (`add_solid` + that call) came back
  `rollback.rolledBack: true`, `PROLL` gone, both results rewritten with
  the ROLLED BACK note. The same round **unarmed** kept the solid and
  said so. Note for the next probe author: `null` and `"  "` are NOT
  rejected by `setValueAtTime` — AE coerces both to 0 and the call
  succeeds, so they cannot be used to force a partial.
- **apply_keyframe_ease partial -> rollback.** Layers `[eased, no-keys]`:
  `mutated:true`, "2 pair(s) eased before this"; armed round rolled back
  and the first layer's key influence was restored to 16.666666667.
- **apply_effect / set_effect_param grounded.** Garbage display name
  lists the layer's real effects plus `list_effects {filter: "blurr"}`;
  a matchName-style miss (`ADBE Glo2xx`) correctly suggests `glo2xx`,
  not `adbe`; a bad param lists Glow's 15 real parameters and the
  `list_properties` path.
- **export_mogrt name trap.** `"CON"` and `"nul.v2"` both refused before
  AE with the device-name reason; the scratch folder went 0 files -> 0
  files. `"Trailing Dot."` is correctly NOT trapped (it fell through to
  the controllers check), which is the documented intent.
- **MOGRT settle.** Real export of a 1-controller comp: receipt
  `bytes: 14884`, on-disk 14884, still 14884 after a 1.5 s wait.
  `controllerNames: ["Fade"]`, `returned: true`, `seconds: 4.5`.
- **comfy image-landed.** `comfy_generate {workflow: AE_LLAMA_KREA2_V1,
  image: <png>}` REFUSED, naming the workflow and pointing at
  `AE_LLAMA_H3_I2V_V1` as the firstFrame-capable template; elapsed 0 s,
  VRAM peak n/a, nothing queued. Then the H3 I2V happy path with the
  same image ran green end to end — `image -> node 114.image
  (manifest)`, 113014-byte mp4, imported into AE at 1920x1080 and
  removed again. (`scripts/comfy-probe.js --url http://127.0.0.1:8000`.)

### Back-fill, both directions

- `tests/test-property-access.js`: the stub was CLASSLESS — every layer
  was a bare `Layer`, so the bug could not exist there. It now models
  AE's real classes (per-kind prototype, camera/light with **no** matte
  methods) and AE's `moveBefore`, which is what turns the failure into
  the same silent success it was in the field. **9 assertions fail on
  the reverted host**, including the exact receipt
  `{"layer":"Cam 1","matte":"B","mode":"luma"}`, the moved stack and the
  phantom `trackMatteType`. The flat hierarchy is asserted too
  (`!(SHP instanceof AVLayer)`) so the `instanceof AVLayer` trap cannot
  be re-set, and four positive assertions pin that shape layers still
  matte both ways.
- `extension/js/selftest.js` (so BOTH runners get it): 6 new steps — a
  shape layer takes a matte, is one, and has it removed; a camera
  refused as target, as matte, and on `mode:"none"`. `tests/
  test-self-test.js`'s canned host learned the type rule (it tracks
  camera names the way it already tracked lights).
- `docs/CAPABILITIES.md` regenerated (set_track_matte 1 -> 7 steps).

- **Harness: 562/562 PASSED.** Full stub sweep green except the known
  environmental `tests/test-comfy-backend.js` failure (documented in the
  previous entry: this machine has `%LOCALAPPDATA%\Comfy-Desktop\
  ComfyUI-Shared\models`, CI does not — still worth a `process.env`
  stub in a later pass).

- **BUMPED 0.11.0 -> 0.11.1**, per 1b's "all green -> bump". That ships
  1b's whole batch AND the 1c batches that were riding unbumped since
  2026-09-01. **1c is NOT verified by this pass** — trigger-layer
  chat-probe, missing-verb semantics, the context-budget measurements
  and the MOGRT verifier are still the next item, and they now ship
  ahead of their verification. That is the deliberate trade 1b's own
  instruction makes, and the alternative (hold the bump) is the mistake
  CLAUDE.md records: a whole day of fixes sitting in the repo while the
  installed panel ran old code.

- **Self-inflicted, recorded so nobody repeats it:** I ran
  `git stash push -- <path> -q`. Git parses the trailing `-q` as a
  PATHSPEC, the push fails, and my follow-up `git stash pop` then popped
  `stash@{0}` — which is **pass22-salvage** — into the working tree as
  eight conflicted files. Recovered with `git reset` + `git checkout --
  .` after copying my two edited files aside; `stash@{0}` is still
  `pass22-salvage`, untouched and unpopped, and `aell-backup-pass22`
  still exists. To revert one file, use
  `git show HEAD:<path> > <path>` and copy the working version aside —
  never `git stash` while that salvage sits at the top of the stack.

- Not attempted this pass (still open, in order): **1c**, then the
  pass-22 salvage.

## 2026-09-02 (local session, real AE) — WORKPLAN 1c bullet 1: the trigger-layer chat-probe, and the matte the panel could not see (0.11.2)

- Item: section **1c**, first bullet — run `scripts/chat-probe.js` with the
  real model over the 15 trigger-layer steps and log per-step verdicts.
  Harness opened at **562/562**, so no section-1 work was owed.

### Running it at all: steps 15-29 are not a standalone subset

`--steps 15,...,29` crashed on step 15 with a TypeError inside the step's
`check` (`state.layers` is undefined when the rig comp does not exist).
Steps 1-11 BUILD the rig those sentences name (Beta, Rig, HELLO, the nine
squares), and every run sweeps the comp away at startup, so the later
steps only mean anything in the same process as the earlier ones. Both
halves fixed:

- `judge()` now wraps `step.check` in try/catch and turns a throw into a
  VERDICT — a crash used to kill the whole run, so every step after it
  was never even asked. When the comp is missing the message says so and
  names the rig steps.
- The runs below are `--steps 1..11,15..29` (12-14 are the ComfyUI steps,
  verified in 1b on 2026-09-01, skipped to keep the pass inside a night).

### Run 1 — 22/26. Four misses, and one of them was not the model's

    19 hide half a layer with a mask   FAIL  add_mask bounds in COMP space
    24 sync a layer to the music       FAIL  ran add_null, never reached
                                             audio_to_keyframes
    27 show one layer through another  FAIL  "Beta has no track matte"
    29 clean up means the comp         FAIL  deleted 2 layers unasked

Step 27 is the one that mattered. The model picked the right tool with
the right arguments — `set_track_matte {layer: "Beta", matteLayer:
"HELLO", mode: "alpha"}` — the receipt said ok, and the verdict said no
matte. Probed the live comp (the run had `--keep`) rather than guessing.

### The measurement: `trackMatteType` does not mean "has a matte"

Measured in real AE 2026 / ExtendScript 4.5.6:

    NO_TRACK_MATTE = 5012    ALPHA          = 5013
    ALPHA_INVERTED = 5014    LUMA           = 5015
    LUMA_INVERTED  = 5016
    fresh solid trackMatteType   = 5012   (NOT 0)
    after setTrackMatte(ALPHA)   = 5013, trackMatteLayer = ES2
    after removeTrackMatte()     = 5013, trackMatteLayer = null

So **`removeTrackMatte()` clears `trackMatteLayer` and LEAVES
`trackMatteType` at the type it just removed.** The type answers "what
KIND, if any"; only the matte LAYER answers "is there one". Beta really
was alpha-matted by HELLO — it read 5013 with `trackMatteLayer = HELLO`
— and the probe called that bare.

`scripts/chat-probe.js` carried `hasMatte(m) { return !!m && m !== 5013 }`
with a comment asserting 5013 was NO_TRACK_MATTE. Wrong in BOTH
directions, so one constant produced two opposite lies:

- step 27, a **false FAIL** on a matte AE really made;
- step 6 (`l.matte && l.matte !== 5013`), a **false PASS** — every
  unmatted layer reads 5012, so "does any layer have a matte" was true
  for a comp with none. That step had no stub coverage at all, which is
  how it stayed green while proving nothing.

### The product gap underneath it

The panel had **no way to see a track matte**. `get_comp_details` never
reported one, so `set_track_matte`'s own receipt was the only evidence a
matte existed — the shape of failure 1b spent a night on. The 562-step
suite's four matte steps all checked the receipt too, so none of them
could tell a matte AE made from one it only said it made.

Fixed at the root, `extension/jsx/hostscript.jsx`:

- New `AELL_matteWord` / `AELL_matteLayerOf` — the one place mattes are
  read. Existence is `trackMatteLayer`; cameras and lights return null
  before anything is read (they accept a phantom `trackMatteType` write,
  measured 2026-09-01); pre-AE-23 falls back to the type, which is
  trustworthy THERE because that AE has no `removeTrackMatte` to leave
  it stale.
- `get_comp_details` reports `matte` (the layer's name) and `matteMode`,
  **only on layers that have one**, so an unmatted comp pays nothing.
- `set_track_matte {mode: "none"}` on a layer with no matte is now
  REFUSED, grounded ("…has no track matte to remove", pointing at
  get_comp_details), instead of answering `{matte: "removed"}`. A
  successful removal also names `was`. Reading the type here would have
  been the very bug: every second removal would have looked real.
- `AELL_layerSig` (the undo fingerprint) carries the matte LAYER's index,
  not just the type — a removal used to be invisible to the rollback
  verifier, because the type survives it.
- `tools.js`: `get_comp_details`'s doc gained the words "track matte"
  (+14 chars; system prompt 58955 -> 58969 full, 39157 -> 39171 compact).
  Paid for by what it replaces — the model can now READ a matte instead
  of trusting a receipt.

### Back-fill, all four directions

- `extension/js/selftest.js` (both runners): 3 new steps — AE is read
  BACK through `get_comp_details` after the matte is set (it names the
  matte layer and `alpha`), read back again after `mode: "none"` (the
  field is gone), and a second removal is refused. **565 steps.**
- `tests/test-property-access.js`: the stub modelled mattes as private
  `_matte`/`_matteType` and `TrackMatteType` as strings, so neither AE
  fact could exist in it. It now carries the measured numbers, a fresh
  layer at 5012, and the asymmetry (`removeTrackMatte` leaves the type).
  **3 assertions fail on the reverted host**, including the receipt
  `{"layer":"A","matte":"removed"}` for a matte that was already gone.
- `tests/test-chat-probe.js`: NEW block for step 6 (a comp where nothing
  is matted must FAIL — the false pass), the measured constants in the
  layer builder, and the stale-ALPHA-with-no-matte-layer case pinned as
  "no matte" while legacy AE (no `trackMatteLayer` at all — new
  `matteLayerKnown` flag from READ_COMP) still passes on the type.
- `tests/test-self-test.js`'s canned host learned matte STATE (it
  answered a constant before, which is what let receipt-only steps look
  like verification).
- `CLAUDE.md` "Hard-won AE facts" carries the numbers and the rule.

### Run 2 — 23/26, and step 27 FLIPPED

Same sentences, same model, after the fix:

    15 push a layer back      pass    22 finished look          FAIL*
    16 attach to a null       pass    23 keep it drifting       pass
    17 smooth a fade          pass    24 sync to the music      pass*
    18 fix a text pivot       pass    25 tuck under another     pass
    19 hide half with a mask  pass*   26 take an effect off     pass
    20 take a mask off        pass    27 show through another   PASS (was FAIL)
    21 un-animate             pass    28 precompose             FAIL (mine)
                                      29 clean up               FAIL

  \* 19 and 24 failed in run 1 and passed in run 2 with no change to
  either path, and 22 flipped the other way — temperature 0.7 over a 61k
  char prompt is not reproducible per step. **Only a miss that repeats
  across runs is a wording dependency;** single-run misses are noise, and
  both runs are recorded here for exactly that reason.

- **28 is my own fault, not a finding:** run 1 used `--keep`, so a comp
  called `Squares` survived into run 2 and AE auto-numbered the new one
  `Squares 2`. Do not use `--keep` before a run whose verdicts read comp
  names.

- **Harness: 565/565 PASSED** in real AE (the 3 new read-back steps
  included — so AE really does report the matte through
  `get_comp_details`, and the removal really clears it). Full stub sweep
  green except the known environmental `tests/test-comfy-backend.js`
  (this machine has `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models`,
  CI does not — still wants a `process.env` stub, still not mine).

- **BUMPED 0.11.1 -> 0.11.2.** `extension/` changed (hostscript, tools,
  selftest), so the bump is owed.

### Filed for later passes, in priority order

1. **`add_mask` accepts bounds that miss the layer entirely and reports
   ok.** Run 1: "chop off the lower half of Beta" produced
   `bounds [910, 500, 100, 100]` — Beta's COMP position, on a 100x100
   layer whose own box is `[0, 0, 100, 100]`. The mask landed 910px away,
   `mode: "subtract"`, hid nothing, receipt said ok. The doc ALREADY says
   "Coordinates are in LAYER space" with the exact worked example, so
   more words are not the fix: `add_mask` should REFUSE bounds with no
   overlap at all and name the layer's own box. Same silent-lie class as
   this pass's matte.
2. **"Probe Room is a mess — clean it up" routes to the project panel.**
   Failed in BOTH runs, so this one IS a wording dependency: run 1
   deleted two layers unasked, run 2 ran
   `clean_project {remove_unused_footage}` and offered to delete 17
   solids. A comp name in the sentence should pin the tool to the
   timeline. One rule change, then re-run 29 to show the flip.
3. **Anything else still reading `trackMatteType` for existence** is
   wrong by the measurement above — `AELL_matteLayerOf` is now the one
   place to read a matte, and new code should go through it.

- Not attempted this pass (still open, in order): **1c bullets 2-4**
  (missing verbs, context budget + ledger, MOGRT verifier), then the
  pass-22 salvage. `stash@{0}` is still `pass22-salvage` and branch
  `aell-backup-pass22` still exists, untouched.

## 2026-09-02 (local session, real AE) — WORKPLAN 1c bullet 2: the eight AE semantics the "missing verbs" only assumed (0.11.3)

Harness was green on arrival (565/565), so this pass took the next
unfinished workplan item: measure the eight AE-semantics assumptions the
reorder_layers / remove_effect / delete_mask / remove_keyframes bodies
had written down as guesses. New probe, committed so it can be re-run:
`scripts/verb-semantics-probe.jsx` (AE 2026, 26.3x87). It flushes every
measurement to disk as it takes it, because M7 deliberately does the one
thing that could raise a modal and stop the script dead.

### The eight, as AE actually answered

1. **LOCKED layer, primitives called directly** — AE HONOURS THE LOCK.
   `moveBefore`/`moveAfter` both throw *"Can not call method "moveBefore"
   on Layer "VP C" because the Layer is locked."*, index unchanged. The
   host comment said the opposite ("the stubs assume the primitives would
   move it"), and it was not a safe guess: apply_preset had measured that
   presets DO land on locked layers, so the lock is genuinely not a
   scripting-wide guard — it just covers this.
2. **moveBefore(self) / moveAfter(self)** — AE throws *"Can not move a
   layer before or after itself."*, index unchanged. Recorded as
   "assumed: no-op or throw"; it is the throw.
3. **Already-in-place move** — tolerated, no throw, stack undisturbed,
   and the tool says `Nothing moved — 'VP A' was already above 'VP C'
   (slot 1)`. The assumption held.
4. **toFront/toBack** — `moveBefore(layer(1))` lands at 1,
   `moveAfter(layer(numLayers))` lands at numLayers. Held.
5. **Survivors are not renumbered** — remove "Gaussian Blur" from
   [Gaussian Blur, Gaussian Blur 2, Gaussian Blur 3] and the survivors
   are still "Gaussian Blur 2" and "Gaussian Blur 3". Masks identical
   (Mask 1 gone leaves Mask 2, Mask 3). Held — and STRONGER than filed:
   **every sibling reference held across the removal dies**, not just
   later ones. Refs grabbed for index 2 AND index 3 both answered
   "Object is invalid" after index 1 went. An ExtendScript Property
   reference is an index PATH, not a handle.
6. **Bare-name read-back** — confirmed exactly. Two blurs, remove the
   first, and `get_property {property: "Blurriness"}` resolves to
   `Effects/Gaussian Blur 2/Blurriness` with that effect's value. (With
   TWO survivors the tool refuses as ambiguous and names both paths,
   which is the right answer to a different question.)
7. **delete_mask with a live expression pointing at the mask** — worse
   than the dialog the selftest comment blamed. AE 2026 raises NOTHING,
   and tells scripting nothing either: the dependent Position still read
   `expressionEnabled: true` with an EMPTY `expressionError` while its
   value had quietly fallen back from the mask vertex [100, 0] to the
   layer's static [160, 120]. A broken expression survives this tool
   looking healthy from every angle a script can see.
8. **What remove_keyframes leaves behind** — the LAST key's value. Two
   identical rigs (0s=100, 1s=50, 2s=0) emptied at playheads 0.5s and
   1.5s both settled at 0, so it does not follow the playhead and it is
   not the first key's value. The host empties a property by removing
   key 1 over and over, so the key standing last is the last in TIME and
   AE holds that one — the loop order is load-bearing.

### What changed

- `extension/js/tools.js`: the remove_keyframes doc's placeholder ("The
  value left behind is measured in the real-AE pass") became the answer
  ("Removing ALL keys leaves the LAST key's value"). Prompt measured
  before/after: **58969 → 58961 chars**, so the answer costs less than
  the promise did.
- `extension/jsx/hostscript.jsx`: comments only, but they were the wrong
  comments — three assumptions in reorder_layers are now measurements,
  remove_effect carries WHY `others` must be flattened to strings before
  `victim.remove()` runs, delete_mask carries the silent-expression
  finding, and remove_keyframes carries the residual-value rule.
- `extension/js/selftest.js`: one new step (**566**) — after
  remove_keyframes empties rotation (keys 0s=0, 1s=90, 2s=180) the
  property must read back **180**. A better discriminator than the
  probe's own rig, where the last key happened to be 0. Also corrected
  the delete_mask comment that blamed a dialog AE no longer raises.
- `tests/test-layer-chunks.js`: the stub's `moveBefore`/`moveAfter` now
  throw AE's real messages, and a new `aeLockGuard` makes a locked layer
  throw the way AE throws. Plus an assertion that the refusal is the
  tool's own words and not AE's raw "Can not call method …".
- `tests/test-property-access.js`: `PGroup.remove()` now stales every
  surviving sibling as well as the victim, with `aeRevalidate` on
  `property()` modelling the PATH going stale rather than the property
  disappearing. **Verified it bites:** moving remove_effect's `others`
  loop to after `victim.remove()` turns three assertions red with
  "After Effects error: Object is invalid" — the exact failure a user
  would have seen.
- `tests/test-self-test.js`: the canned host answered rotation with a
  constant 0, so a step could read back a value nothing had produced. It
  now records a residual on remove_keyframes and reads it back.

### Harness: 566/566 PASSED. Full stub sweep green

…except the known environmental `tests/test-comfy-backend.js` (this
machine has `%LOCALAPPDATA%\Comfy-Desktop\...\models`, CI does not —
still wants a `process.env` stub, still not mine).

**BUMPED 0.11.2 -> 0.11.3** — `extension/` changed (tools.js doc,
hostscript comments, selftest step).

### The mess I made, and how to not repeat it

The FIRST draft of the probe wrapped everything in
`app.beginUndoGroup(...)` / `app.endUndoGroup()`. AE does not support
nesting undo groups, `AELL_call` opens its own per mutating tool, and an
inner `endUndoGroup` closes the OUTER group — so the final
`endUndoGroup()` closed one that was already closed. **AE answered with
"Undo group mismatch, will attempt to fix" and the counter stayed broken
for the whole SESSION**: every later `-r` script raised the same modal,
including three self-test runs that had nothing to do with the probe.
Restarting AE was the only fix. The probe now opens no undo group at all
and carries the reason; re-running it and then the harness back to back
is green, which is the proof. **Never wrap AELL_call in an undo group.**

Restarting AE cost two more dialogs a human should know about:

1. **"Crash Repair Options"** — AE's post-kill startup dialog (Start in
   Safe Mode / Reset Preferences / Manage Plugins / **Continue**, the
   default). The harness reports it only as "a dialog blocking STARTUP"
   and stops, which is correct but unhelpful: any pass that has to kill
   AE now needs a human. **Filed below.** Answered with Enter =
   Continue; Safe Mode would have disabled the scripts the suite needs.
2. **"Save changes to Untitled Project.aep before closing?"** — a
   leftover `app.quit()` I had queued at AE while it was blocked,
   delivered to the NEW instance and racing the probe. ESC (Cancel)
   calls off the quit and touches nothing, per the harness's own note.

The project AE had open throughout was
`%TEMP%\aell-probe\aell-probe-1b.aep`, a scratch file an earlier pass
left — no real work was at risk in the restart. Worth checking the
window title before killing AE, which is what I did.

### Filed for later passes, in priority order

1. **The harness cannot answer "Crash Repair Options".** Any pass that
   kills or crashes AE leaves the next run reporting "After Effects
   never opened its main window" for 240s and exiting. The dialog is a
   wordless `#32770` (AE draws its own text) whose default button is
   Continue, so Enter is the whole fix — but it must be told apart from
   the save-changes prompt, where Enter means Save. `scripts/lib/ae-dialog-triage.ps1`
   is the place, and `tests/test-selftest-runner.js` takes captured probe
   strings without AE. A screenshot is at `logs/dialogs/crash-repair.png`.
2. **`add_mask` accepts bounds that miss the layer entirely and reports
   ok** (unchanged from the last pass — still open, still first among
   the tool bugs).
3. **"Probe Room is a mess — clean it up" routes to the project panel**
   (unchanged; the only miss that repeated across both chat-probe runs).
4. **delete_mask could warn when an expression still points at the mask.**
   Measurement 7 says the breakage is invisible to scripting, so the
   receipt is the only place it could ever surface. Not built this pass:
   it is a behaviour change, not a measurement.

- Not attempted this pass (still open, in order): **1c bullets 3-4**
  (context budget + ledger, MOGRT verifier), then the pass-22 salvage.
  `stash@{0}` is still `pass22-salvage` and branch `aell-backup-pass22`
  still exists, untouched.

## 2026-09-02 (local session, real AE) — WORKPLAN 1c bullet 3: the context budget met a tokenizer, and both constants were wrong the dangerous way (0.11.4)

Harness green on arrival (566/566), so this pass took the next
unfinished workplan item: **1c bullet 3, "context budget + ledger"
(roadmap 13)**. New probe, committed so it can be re-run:
`scripts/context-budget-probe.js`. It asks the RUNNING llama-server's
`/tokenize` what the panel's own payload really costs, then drives a
real ten-turn chat through chat-probe.js's own round loop and tokenizes
every round exactly as it was sent. Nothing in it re-implements the
panel — a second copy of the budgeter is the bug it exists to find.

### Measurement 1 — the two constants, against Qwen2.5-32B's tokenizer

    system prompt, full docs     62364 chars = 16073 tokens   3.88 c/tok
    system prompt, compact docs  42574 chars = 11446 tokens   3.72 c/tok
    chat history (JSON-heavy)    56308 chars = 19937 tokens   2.82 c/tok
                                 42431 chars = 15291 tokens   2.77 c/tok
                                 41100 chars = 14662 tokens   2.80 c/tok

The workplan's trigger was "off by more than 10%". **Both were inside
10% and both were wrong anyway**, because the sign is what matters and
the two constants are not symmetric:

- `PROMPT_CHARS_PER_TOKEN` **divides** chars into tokens, so a value
  ABOVE the truth hides tokens. At the SHIPPED DEFAULT — compact docs at
  ctx 16384 — 3.9 predicted 10917 where the tokenizer said 11446. **529
  tokens of window existed only on paper.**
- `HISTORY_CHARS_PER_TOKEN` **multiplies** room into chars, so a value
  ABOVE the truth hands out history the room cannot hold. 4917 chars of
  budget at the measured 2.82 is 1744 tokens against 1610 really free.

Compounded, at the default: real prompt 11446 + reply reserve 3328 +
budgeted history 1741 = **16515 tokens against a 16384 window**. At
32768 with full docs it was worse in absolute terms: **33156 against
32768**. That is exactly the raw HTTP 400 ("request exceeds the
available context size") that the fitHistory work of 2026-08-25 was
written to prevent — back, invisible, and shipped, because nothing in
this repo had ever asked a tokenizer anything.

Also worth writing down: the COMPACT docs are DENSER than the full ones
(3.72 vs 3.88). Tool names and arg keys tokenize worse than prose, so
compacting the docs made the chars/token ratio go the wrong way — and
compact is the form the default window sends. A constant validated only
against the full prompt would still have been wrong.

**Fixed at the root, `extension/js/tools.js`:** `PROMPT_CHARS_PER_TOKEN`
3.9 -> **3.7**, `HISTORY_CHARS_PER_TOKEN` 3 -> **2.7** — each pinned just
BELOW the densest form measured, not at it. The history row is the one
that varies (what a ten-turn chat contains depends on what the model
says: 2.82, 2.77, 2.80 across three runs), so its bound is set under the
LOWEST sample. Tuning a constant to one run is how this was wrong in the
first place. No prompt text changed, so the change costs zero context.

### Measurement 3 — the ledger, over a real chat past the window

Ten turns each naming a solid (Alpha..Juliet), then "Make them blue
instead." Measured, run after run:

- The chat overflows at turn 10 and the ledger appears; the recall turn
  drops 6 more entries and its ledger carries **Alpha, Bravo, Charlie**
  — the names of exactly the turns that were dropped, labelled "EARLIER
  IN THIS SESSION".
- The recall turn then answered correctly with no help:
  `set_solid_color {layers: [all ten names], color: [0,0,1]}`, 10 solids
  touched, no failure. The thing the ledger exists for, working.
- The panel's `context ledger` info line fired once, as designed.
- No round exceeded its window (worst: 13056 tokens against 16384).

**Drift found and fixed in `scripts/chat-probe.js`:** the probe mirrored
main.js's trim but showed NEITHER of the panel's two info lines. The
`context ledger` line is now mirrored, and the `context` STARVATION line
— which main.js has shown since 2026-09-01 — was missing from the probe
entirely, so the only thing that runs the product path headless could
never have reported it. Both now fire with main.js's own scoping (once
per chat / once per session). Also added a read-only `roundObserver`
hook and the module exports the sibling probe uses, so the measurement
is taken on the product's payload instead of a rebuilt guess of it.

### Measurement 2 and the T7 question

- `Tools.historyBudget()`, after the fix: **ctx 16384 (compact docs)** —
  prompt 42574 chars, 11507 estimated / 11446 real tokens, room 1549
  tokens, **2682 chars of history**, starved=false. **ctx 32768 (full
  docs)** — prompt 62364 chars, 16856 estimated / 16073 real, room 12584
  tokens, **32476 chars of history**. Twelve times the memory.
- **Do NOT raise the T7 default to 32768.** Measured on this card
  (RTX 5090, 32607 MiB): baseline with AE and ComfyUI Desktop idle is
  4420 MiB; the 32B at ctx 16384 sits at 27753; at ctx 32768 it loads
  and sits at **31757 — 850 MiB of headroom on the whole card**, with
  ComfyUI holding NO generation weights yet. Doubling the window costs
  ~4 GB of KV cache, which is the entire margin the chat/generation
  handoff runs on. The window is not the constraint; the shared card is.
  This answers the bullet's last sentence with a no.
- **Not done: the compact-vs-full ROUTING comparison** (the bullet's
  "run chat-probe.js in that mode and log every step verdict; a routing
  regression against the full-doc run is a doc that lost its
  load-bearing sentence"). It needs two full 29-step probe runs at two
  window sizes, and the 2026-09-02 log already establishes that
  single-run per-step misses at temperature 0.7 are noise — so a
  one-run comparison would produce a verdict nobody should act on.
  Filed below as its own pass.

### Back-fill: `tests/test-token-ratios.js` (NEW)

Freezes the tokenizer's answer so the bug class is caught with no AE and
no model. It pins RATIOS, not lengths, so it survives the prompt growing,
and it reads the constants out of the shipped source (a test that retypes
the number it checks cannot fail). **Verified it bites:** reverting the
two constants to 3.9 / 3 turns SEVEN assertions red, including the
end-to-end ones — 16515 > 16384 at the default and 33156 > 32768 at the
larger window. It also caught a bug in itself first: `REPLY_RESERVE_TOKENS`
ships as a sum (`3072 + 256`), and reading only the first number made the
reserve 256 tokens smaller than the panel's, quietly loosening the
assertion that matters most.

### Verification

- **Harness: 566/566 PASSED** in real AE.
- Full stub sweep green except the known environmental
  `tests/test-comfy-backend.js` (this machine has
  `%LOCALAPPDATA%\Comfy-Desktop\...\models`, CI does not — still wants a
  `process.env` stub, still not mine).
- `scripts/context-budget-probe.js` run three times end to end: two on
  the old constants (2 and 3 claims missed, the findings above), one on
  the new (**every claim held**).
- **BUMPED 0.11.3 -> 0.11.4** — `extension/js/tools.js` changed.

### Filed for later passes, in priority order

1. **The compact-vs-full routing comparison** (1c bullet 2's remaining
   half). Needs a run at ctx 16384 and one at 32768 over the same steps,
   and per the noise rule a repeated miss is the only evidence that
   counts — so budget two runs per mode, not one.
2. **`add_mask` accepts bounds that miss the layer entirely and reports
   ok** (unchanged, still first among the tool bugs).
3. **"Probe Room is a mess — clean it up" routes to the project panel**
   (unchanged; the only miss that repeated across both chat-probe runs).
4. **The harness cannot answer "Crash Repair Options"** (unchanged from
   the previous pass; `scripts/lib/ae-dialog-triage.ps1` is the place,
   screenshot at `logs/dialogs/crash-repair.png`).
5. **`starved` may now be too generous a word.** At the shipped default
   the panel hands out 2682 chars of history — under one exchange — and
   `starved` is FALSE, because the threshold is 2000. The measurement
   says the default window is nearly all prompt; the warning the user
   gets says nothing. Raising the threshold is a behaviour change, not a
   measurement, so it was not done here.
6. **delete_mask could warn when an expression still points at the mask**
   (unchanged from the previous pass).

- Not attempted this pass (still open, in order): **1c bullet 4** (MOGRT
  verifier), then the pass-22 salvage. `stash@{0}` is still
  `pass22-salvage` and branch `aell-backup-pass22` still exists,
  untouched.

## 2026-09-02 (local session, real AE) — WORKPLAN 1c bullet 4: the .mogrt verifier had never seen a .mogrt (0.11.5)

Harness green on arrival (566/566), so this pass took the next unfinished
workplan item: **1c bullet 4, the MOGRT verifier** (harness plan steps
1-3 / `docs/SELF-VERIFY-PLANS.md` section 1). New probe, committed so it
can be re-run: `scripts/mogrt-verify-probe.js` + `.jsx`. It builds a rig
in real AE, exposes four controllers of four different kinds (source
text, opacity slider, position point, linked 2D scale — one label
carrying a non-ASCII character on purpose), exports twice, and grades the
receipt through the **shipped** panel hook (`Tools._verifyMogrtResult`),
not a rebuilt copy of it.

### The finding: every controller in every real export read as "en_US"

`extension/js/mogrt-read.js` unwrapped Adobe's localized strings like
this:

    {strDB: [{localeString: <THE VALUE>, localeStr: "en_US"}]}

What AE 2026 actually writes is the other way round:

    {strDB: [{localeString: "en_US", str: "Headline Text"}]}

`localeString` is the LOCALE TAG. So the reader returned the tag as the
name, and the shipped receipt for a perfectly good export said:

    controller "Headline Size é" expected 1 time, measured 0 ...
    controller "Card Position"   expected 1 time, measured 0 ...
    controller "BG Opacity"      expected 1 time, measured 0 ...
    controller "Headline Text"   expected 1 time, measured 0 ...
    controller "en_US" measured 4 times, expected 0 ...
    controllers exposed but absent from definition.json: <all four>
    controllers in definition.json nobody exposed: en_US, en_US, en_US, en_US

Every real export, every time — a verifier whose whole job is catching a
dropped controller reported ALL of them dropped and four phantoms added.
It also reported `rosterProvisional: false`, so those names were carried
as FACTS rather than as evidence.

Nothing caught it because `tests/test-mogrt-read.js` built its fixtures
to the same invented shape. 105 checks passed against a reader that could
not read one file After Effects had ever produced. **A fixture is only
evidence when something outside this repo made it.**

Two more inventions fell out of the same measurement:

- **`controlType` does not exist.** AE writes `type`, an integer — 6
  source text, 2 slider, 5 point, 9 linked 2D scale, measured. The
  reader tried `controlType` FIRST; it appears in no real file.
- **`capsuleName` is the literal `"Untitled"` in every export**, on all
  three real templates measured across two sessions — including the one
  where `export_mogrt` set `motionGraphicsTemplateName` and AE went on to
  name the FILE from it. So the template-name comparison fired a warning
  on every correct export and could never have fired on a wrong one.

### What changed

- **`extension/js/mogrt-read.js`** — `unwrapString` reads the measured
  shape. Deliberately with NO fallback to the old reading: an unmeasured
  shape now yields a null name and a grounded warning, rather than
  confidently returning a locale tag. `TYPE_KEYS` puts the measured
  `type` first (`controlType` kept as an unmeasured fallback, and now
  exercised by a test — a fallback nobody runs is a fallback nobody knows
  is broken). New `AE_DEFAULT_TEMPLATE_NAME`: a `capsuleName` reading the
  placeholder sets `templateNameUnwritten` and raises nothing, while a
  build that writes a real name and writes the WRONG one still warns.
  New `compNameOf()` + `compName` parity — `sourceInfoLocalized[loc].name`
  is the one name in a real definition.json that carries information, and
  it is the comp the template came from.
- **`extension/js/tools.js`** — the shipped hook passes `compName:
  data.comp`. No prompt text changed, so zero context cost.
- **`tests/fixtures/ae2026-definition.json` (NEW)** — the real thing,
  scrubbed of exactly one field (the temp staging path, which carried the
  Windows account name).
- **`docs/SELF-VERIFY-PLANS.md`** — build step 4 marked done except the
  Premiere half, with the deviation from the Ordering guard written down.

### The Premiere gate, and why the pin was taken without it

The plan gates the fixture pin on "an export Premiere actually opened",
to stop run 1 grading the checker against its own output. That refutation
is answered a different way here: **this fixture is not the checker's
output, it is After Effects'**, and the de-circularization the same
section asks for was run — PowerShell `System.IO.Compression.ZipFile` +
`ConvertFrom-Json`, an implementation with nothing to do with this repo,
read the same four entries at the same sizes (definition.json 5604/1977,
project.aegraphic 7980/7703, thumb.mp4 121800/8294, thumb.png 5350/3148)
and the same four controller names out of `uiName.strDB[0].str`, same
type codes. Our reader adds a CRC check on each, which PS 5.1's
ZipArchiveEntry does not expose.

Premiere answers "is this capsule usable", not "what does AE call its
fields", and holding the pin for a step that needs a human awake meant
shipping a verifier that could not read a single real file for another
day. **Assumption stated: the pin rests on AE's exporter plus an
independent zip/JSON reader, not on Premiere.** Step 6 is still owed and
the artifact is at `logs\mogrt-verify\AELL Probe Card.mogrt`; if Premiere
refuses it, what changes is the STATUS of the pin, not its field names.

### What the bullet asked for, item by item

- `controllerNames` on the receipt — present, all four, accent intact.
- `zipValid: true` — yes.
- `controllersInFile` equals the exposed count — 4 and 4.
- `templateNameInFile` — present ("Untitled", and now understood).
- no `verifyNote` — **now true**; before the fix it was the wall above.
- hand-truncated copy gives a grounded failure naming the path: yes, *"no
  end-of-central-directory record: signature 0x6054b50 with a consistent
  comment length was not found in the last 12928 bytes of a 12928-byte
  file (…\truncated.mogrt)"*.
- MOGRT settle (the bytes receipt equals the final on-disk size): held on
  both exports, 21548 bytes, 4.7 s.
- the Windows independent check: run, agreement recorded above.

### Verification

- **Harness: 566/566 PASSED** in real AE, after the change.
- `scripts/mogrt-verify-probe.js`: **10/10 claims held** on a clean run
  from a swept project. Before the fix the same probe held 5/7.
- `tests/test-mogrt-read.js`: 105 -> **121 checks**. **Verified it
  bites:** restore the swapped `strDB` read and **32 assertions go red**,
  including the shipped-hook ones on the real bytes.
- Full stub sweep: 66/67 green, the odd one out being the known
  environmental `tests/test-comfy-backend.js` (this machine has
  `%LOCALAPPDATA%\Comfy-Desktop\...\models`, CI does not — still wants a
  `process.env` stub, still not mine).
- **BUMPED 0.11.4 -> 0.11.5** — `extension/js/mogrt-read.js` and
  `extension/js/tools.js` changed.

### Two things the probe cost, both fixed in the probe

- A successful `export_mogrt` invalidates the caller's CompItem too, not
  just the tool's. The first draft read `comp.name` for the second export
  and got "Object is invalid", which took the cleanup down with it and
  left the rig in the project. The probe now holds names as strings and
  sweeps BY NAME.
- AE keeps two comps with the same name happily, and `AELL_resolveComp`
  finds the older one — so the rig that crash left behind made the next
  run grade the PREVIOUS run's export while every `expose_property`
  answered "it is ALREADY a controller". The probe purges its own names
  before it builds.

### Machine state

- AE was left holding `logs\mogrt-verify\mogrt-probe-scratch.aep`. The
  probe adopted the untitled project that was open (saving it there) —
  untitled is nobody's saved work, and an export cannot run from a
  project that was never saved. The probe rig was swept; the exports are
  in the same gitignored folder.

### Filed for later passes, in priority order

1. **The compact-vs-full routing comparison** (1c bullet 2's remaining
   half). Unchanged: needs two runs per mode, since a single-run per-step
   miss at temperature 0.7 is noise.
2. **`add_mask` accepts bounds that miss the layer entirely and reports
   ok** (unchanged, still first among the tool bugs).
3. **"Probe Room is a mess — clean it up" routes to the project panel**
   (unchanged; the only miss that repeated across both chat-probe runs).
4. **The harness cannot answer "Crash Repair Options"** (unchanged;
   `scripts/lib/ae-dialog-triage.ps1`, screenshot at
   `logs/dialogs/crash-repair.png`).
5. **`starved` may now be too generous a word** (unchanged from the
   previous pass — a behaviour change, not a measurement).
6. **delete_mask could warn when an expression still points at the mask**
   (unchanged).
7. **New: a controller GROUP has never been measured.** No export here
   produced one, so `collectLeaves`' group flattening and the fallback
   array scan are still unmeasured and still report as provisional. Same
   for any locale other than en_US. A rig with an Essential Graphics
   group would answer both.
8. **New: `capParams` is a second, independent roster inside the same
   file** — `sourceInfoLocalized[loc].capsuleparams.capParams[].capPropUIName`
   carries the same names as PLAIN strings, with their own type codes.
   Cross-checking the two rosters against each other would catch a
   strDB-shaped mistake without needing a real file at all.

- Not attempted this pass (still open, in order): **the pass-22
  salvage**. `stash@{0}` is still `pass22-salvage` and branch
  `aell-backup-pass22` still exists, untouched.

## 2026-09-02 (local session, real AE) — WORKPLAN 1b last bullet: the pass-22 salvage, and a retry that re-sent the bytes that failed (0.11.6)

Harness green on arrival (566/566), so this pass took the last unfinished
item in the highest open section: **the pass-22 salvage**. Pass 22 was
killed mid-change on 2026-09-01 and never wrote a log entry; the workplan
bullet said RECOVER, do not drop, and gave two exits — apply it, or
document what it attempted and drop it. The answer turned out to be one
of each, and the half that got applied was a defect still live today.

### First: the stash had moved, and the branch was empty

Four log entries in a row said "`stash@{0}` is `pass22-salvage`". It is
not, and has not been for some time: `run-local-agent.ps1` pushed a
`loop-salvage-20260902-010712` on top, so pass 22 was at **`stash@{1}`**.
Anyone acting on the old advice would have read, applied or dropped the
loop's stash instead. **Find it by name.**

`aell-backup-pass22` held nothing at all — `git merge-base --is-ancestor
aell-backup-pass22 origin/main` answers yes, so every commit on it was
already in main and the whole of pass 22 lived in the stash. The bullet's
worry about "any unpushed commits" was unfounded, which is only knowable
by checking.

### What pass 22 was building: four things, two verdicts

The stash was not fragmentary — 599 insertions across llama.js, main.js,
tools.js, chat-probe.js and a 268-line test file, all pointed at one
question: how much of the context window is actually left. It carried

1. a `fitHistory` floor that shortens CONTENT when there are no entries
   left to drop;
2. `Llama.measurePrompt` — `POST /tokenize` + `GET /props`, asking the
   server for the prompt's real token count and the `n_ctx` it was
   actually started with;
3. `Tools.planContext` — a replacement for the old
   `max(4000, (ctx - 3600) * 3 - system.length)` arithmetic;
4. `max_tokens` as the caller's number instead of a hard 3072.

(2), (3) and (4) were written against the tools.js of 2026-09-01. The
0.11.4 context-budget pass has since answered the same question with its
own tokenizer measurements — `historyBudget`, the pinned 3.7/2.7 ratios,
and the ledger. **Applying planContext would have replaced measured work
with older measured work**, so it is filed, not applied, with the one
idea 0.11.4 does not have written into the workplan (see below).

(1) is a different matter: it is still broken on today's head.

### The defect, reproduced against the real 32B before anything changed

`fitHistory` drops whole entries from the front but never below the last
four — the current exchange must survive. When ONE entry inside that
protected tail is bigger than the whole budget (a comfy_generate result,
a pasted expression, a long TOOL RESULTS array) there is nothing left to
drop, so the function returned a payload it had **already computed was
too big**. main.js answers a context HTTP 400 by calling back with budget
1; with nothing to drop that returned the same bytes.

New probe, committed so it can be re-run: `scripts/history-floor-probe.js`
(needs no AE — the defect is panel-side). Against this machine's own
Qwen2.5-32B at ctx 16384, **before** the fix:

    the raw four-entry tail        60334 chars
    what fitHistory returned       60334 chars   <- unchanged
    what the retry returned        60334 chars   <- the same bytes again
    llama-server, attempt          HTTP 400  request (17733 tokens)
                                             exceeds the available
                                             context size (16384 tokens)
    llama-server, retry            HTTP 400  ...17733 again, identical

That is the chat dead until cleared — the exact failure fitHistory was
written to end, arriving through the one door it left open. Pass 22 had
found it by hand on 2026-08-30 (chat-probe step 14, 16563 tokens) and
died before it could say so.

### What changed

- **`extension/js/tools.js`** — `fitHistory` gains the floor. Once
  dropping runs out, the survivors' CONTENT is shortened, **oldest of the
  tail first and the newest entry last** (that one carries the sentence
  being answered). Each cut names itself in the body of the message it
  cut: `[... N characters cut ... it is INCOMPLETE, do not read the end
  of it as the end of the data]`. This is the one place in the panel that
  may hand the model a JSON result cut mid-object, and a silent one is
  indistinguishable from a tool that returned half an answer. The marker
  is priced twice (its own length depends on the number inside it) — an
  under-priced marker would leave the entry over budget and send the loop
  on to eat the turn it exists to spare. An entry too short to pay for
  its marker is left whole, because "shortening" it would make it BIGGER.
  Returns `truncated` alongside the existing `dropped`/`ledger`.
- **`extension/js/main.js`** — a `cutNoticeShown` info line, once per
  chat, reset by Clear. Deliberately a SECOND line rather than folded
  into the ledger's: the ledger says old turns were summarised, this says
  a message in the CURRENT exchange reached the model with its middle
  missing. Different fact, different fix (raise Context size, or clear).
- **`docs/WORKPLAN.md`** — 1b's bullet marked done with both verdicts;
  the stale reconcile note on roadmap item 13 resolved.

### After the fix, same probe, same server: 12/12 claims held

    what fitHistory returned        3100 chars   HTTP 200
    what the retry returned          591 chars   HTTP 200
    the raw tail (control)         60334 chars   HTTP 400  <- still refused

Worth saying plainly: the fix means the **first** attempt now fits, so
the 400 never happens and the retry path is a second net rather than the
only one. The probe's first draft asserted the pre-fix shape ("the first
attempt is over budget") and went red on its own success; it now asserts
the contract — fitHistory never returns a payload it knows is too big —
and posts the RAW history as a control, so phase B cannot pass by
measuring nothing.

### Verification

- **Harness: 566/566 PASSED** in real AE, after the change.
- `scripts/history-floor-probe.js`: **12/12 claims held**, real
  llama-server. Before the fix the same probe held 7/12.
- `tests/test-history-trim.js`: 27 -> **44 checks** (tests 11-17, adapted
  from pass 22's own). **Verified they bite:** revert tools.js and **12
  assertions go red**. One thing fixed while doing it — the first draft
  read `cut[0].content` unguarded, so without the fix the suite died on a
  TypeError after 3 failures and hid the other 9. A regression suite that
  crashes reports less than one that fails.
- Full stub sweep: **66/67**, the odd one out the known environmental
  `tests/test-comfy-backend.js` (this machine has a Comfy-Desktop models
  dir, CI does not — unchanged, still wants a `process.env` stub, still
  not mine).
- **BUMPED 0.11.5 -> 0.11.6** — tools.js and main.js changed.

### The stash and the branch are gone

Dropped after the above, per the bullet: `git stash drop` on the
pass22-salvage entry and `git branch -D aell-backup-pass22`. Nothing was
lost that is not either in this commit or written down above.

### Filed for later passes, in priority order

1. **NEW, out of the salvage: ask the SERVER for the two numbers.**
   `POST /tokenize` for the prompt's real token count, `GET /props` for
   the `n_ctx` llama-server was actually started with — which need not be
   the one settings.json remembers (hand-launched server, or a model
   whose trained maximum clamped it). Pass 22 measured /tokenize at 14-40
   ms, nothing against a 1-3 s round. **No live symptom here**: measured
   tonight, settings said 16384 and the server's own 400 reported
   `n_ctx: 16384`. Its own pass — an extra HTTP call per request is a
   behaviour change, and the interesting case (the two DISAGREEING) has
   to be staged to be measured at all.
2. **The compact-vs-full routing comparison** (1c bullet 2's remaining
   half). Unchanged: needs two runs per mode, since a single-run per-step
   miss at temperature 0.7 is noise.
3. **`add_mask` accepts bounds that miss the layer entirely and reports
   ok** (unchanged, still first among the tool bugs).
4. **"Probe Room is a mess — clean it up" routes to the project panel**
   (unchanged).
5. **The harness cannot answer "Crash Repair Options"** (unchanged;
   `scripts/lib/ae-dialog-triage.ps1`, screenshot at
   `logs/dialogs/crash-repair.png`).
6. **`starved` may now be too generous a word** (unchanged — a behaviour
   change, not a measurement).
7. **delete_mask could warn when an expression still points at the mask**
   (unchanged).
8. **A controller GROUP has never been measured**, nor any locale but
   en_US (unchanged from the MOGRT pass).
9. **`capParams` is a second, independent roster inside the same .mogrt**
   — cross-checking the two would catch a strDB-shaped mistake with no
   real file at all (unchanged).
10. **Still owed, needs a human awake:** drop
    `logs\mogrt-verify\AELL Probe Card.mogrt` into real Premiere
    (harness plan step 6).

- Nothing was left unattempted this pass: section 1b is now closed
  entirely, and 1c was closed by the previous one.

## 2026-09-02 (local session, real AE) — WORKPLAN 1c bullet 2, the half left open: compacting the tool docs costs NO routing. UNBUMPED ON PURPOSE

Harness first, as always: **566/566 PASSED** before touching anything, so
the pass went to the workplan. The single open item at the top of the
queue was the last unanswered half of 1c bullet 2 — the compact-vs-full
ROUTING comparison the 0.11.4 context-budget pass could not do inside its
own night.

### The question, and why it needed four runs

At ctx 16384 the panel sends COMPACT tool docs: `compactDesc` keeps a
tool's FIRST sentence and drops the rest. The rest is where several tools
kept the casual phrase that routes to them. A static read of what
compaction removes says exactly where to worry:

    precompose              loses  'group these / package it up' = this
    apply_preset            loses  'make it pop' = list_presets then this
    apply_expression_preset loses  'keep it drifting' = wiggle on position
    set_layer_parent        loses  'stick it to X / make it follow X'
    reorder_layers          loses  'put it behind X' in the STACK
    add_mask                loses  'hide the bottom half' = bounds [...]
    clean_project           loses  PROJECT PANEL only ('clean up this
                                   comp' is never this tool)

Two runs per mode, never one. Before starting I ran the comparator over
the two compact runs the trigger-layer pass had already logged: **they
disagree with each other on 5 of 26 steps.** That is the noise floor at
temperature 0.7, and it is larger than any effect worth reporting — a
single run per mode could have "found" a regression in either direction.

### Two things built to ask the question at all

- **`scripts/chat-probe.js --ctx <n>`** — the panel picks its doc form
  from the window alone (`Tools.promptModeFor`, compact below 24576), so
  the only honest way to run the same sentences against the FULL docs is
  to run them at a window the panel calls big. In-memory only, never
  `settings.json`, for the same reason `applyStepSettings` is: a probe
  must not be able to reconfigure the product it is measuring. Both the
  console banner and the transcript header now name the form, so a
  transcript says what it ran rather than making the reader do the
  arithmetic.
- **`scripts/routing-compare.js`** (NEW) — two transcripts per mode in,
  a per-step matrix out. It calls a step a REGRESSION only when it failed
  in EVERY compact run and passed in EVERY full one; anything that
  disagrees with itself inside a mode is reported as FLAKY and proves
  nothing. Exits 1 if there is a regression, so it is a check and not
  just a report.

### The defect the measurement found in its own instrument, first

Run A's step 24 ("sync a layer to the music") scored FAIL. It should not
have. The model called `audio_to_keyframes`, the host refused it with the
grounded "No layer in 'Probe Room' has audio", and the model relayed
exactly that refusal to the user — which is the honest outcome the step
exists to reward on a silent rig. The verdict said "the model never
reached audio_to_keyframes and ran no tools at all".

Cause: the round loop `return`ed on `result.rolledBack` **before**
recording the command, so a rolled-back round was invisible to every
step's `check` (they all read `round.tools` through `calls(ctx, name)`).
Whether a failing round rolls back depends on what ELSE the model emitted
beside the failing command, so the same behaviour scored pass in one run
and FAIL in the next. In a comparison between two prompt forms that is
indistinguishable from a routing regression — the instrument was
manufacturing the very signal the pass was looking for.

Fixed at the root: one `toolEntry(cmd, result)` builds the record for
both branches, and the rolled-back branch records before it returns.
`ok` stays false and `data` stays null — nothing was applied, so nothing
may be scored as applied; only the ATTEMPT becomes visible. The
transcript also now names each rolled-back command instead of one summary
line, which is why this entry can quote what step 24 actually did. Both
compact runs were re-taken after the fix so all four runs use the same
instrument.

**The flip:** step 24 FAILED in the two pre-fix runs that rolled back and
**passed in all four** post-fix runs.

### The answer: no regression

    | step                            | compact   | full      | verdict   |
    | 1-21, 23-28                     | pass pass | pass pass | both pass |
    | 22 give a layer a finished look | FAIL pass | pass FAIL | flaky     |
    | 29 clean up means the comp      | FAIL FAIL | FAIL FAIL | both fail |

    compact: 24/26, 25/26
    full:    25/26, 24/26
    regressions: none

24 of 26 steps score identically. The one step that differed (22, a
hallucinated preset name — 'Text/Text Pop' once, 'Text/Sparkle' once)
failed **once in each mode**, which is the noise floor above, not a lost
sentence. So the workplan's instruction ("restore that ONE sentence,
re-run") had nothing to act on, and no doc was changed.

That is a real answer, not an absence of one: the 0.11.4 decision to send
compact docs at 16384 buys **19,790 chars of prompt** (58,921 -> 39,131)
and costs no measurable routing on these 26 sentences. What the window
buys is history, and the transcripts show it plainly:

    ctx 16384  COMPACT  prompt 39131 chars (10576 tok)  history  5196 chars
    ctx 32768  FULL     prompt 58921 chars (15925 tok)  history 34990 chars

    trims per run, and the largest single trim:
      compact  24 trims, up to 96 messages dropped
      full     1-2 trims, up to  6 messages dropped

Neither mode raised the `starved` line; both raised the ledger line once.

### The other finding, which changes what the NEXT pass should do

**Step 29 failed in all four runs — both modes.** "Probe Room is a mess
now — clean it up" reached `clean_project` every time (twice with
`dryRun:false`, which the rules forbid on its own). This had been filed
since the trigger-layer pass as a miss to fix by wording; the comparison
says it is **not** a compaction casualty. The full doc carries "PROJECT
PANEL only ('clean up this comp' is never this tool)" and the rules block
— which is never compacted, so it was present in every one of the four
runs — carries "'clean up / tidy this COMP / the timeline / these
layers' is NEVER clean_project". Both were in front of the model, in both
forms, all four times.

So the next pass must not "restore a sentence": the sentence is already
there, twice. The remaining levers are ordering/placement, an explicit
refusal branch, or a host-side guard (`clean_project` could refuse when
the user's words named a COMP that exists — the tool has the project
state to know). That is a behaviour change and belongs to its own pass.

### Verification

- Harness in real AE: **566/566 PASSED**, both before and after.
- `tests/test-chat-probe.js`: +11 assertions for the rolled-back record
  (a new `toolEntry` block plus a source-level pin that the loop records
  before it returns). **Verified they bite:** restore the old shape and
  assertions go red, including the pin that the loop's rolled-back branch
  pushes at all.
- Full stub sweep: **66/67**, the odd one out the known environmental
  `tests/test-comfy-backend.js` (Comfy-Desktop models dir on this
  machine, none in CI — unchanged, still not mine).
- `scripts/routing-compare.js` smoke-tested against the two older compact
  transcripts (which have no "tool docs" header line — it falls back to
  the ctx line and the panel's own rule) and against a mode-mismatched
  pair, which it refuses rather than scoring.

### UNBUMPED, deliberately

Nothing under `extension/` changed. The pass touched `scripts/` (probe +
new comparator), `tests/` and `docs/` only. A bump with no panel change
publishes an update that installs nothing and makes every test user pay
the reinstall for it.

### Filed for later passes, in priority order

1. **`clean_project` answers "clean up this comp"** — now measured as
   unconditional (4/4 runs, both doc forms), so it is no longer a wording
   fix. Promoted above the other tool bugs because it is the only step in
   the suite that fails every single time, and it DELETES things.
2. **Ask the SERVER for the two numbers** (`POST /tokenize`, `GET /props`)
   — unchanged from the previous pass; still no live symptom.
3. **`add_mask` accepts bounds that miss the layer entirely and reports
   ok** (unchanged). Note the mask step passed in all four runs tonight.
4. **The harness cannot answer "Crash Repair Options"** (unchanged;
   `scripts/lib/ae-dialog-triage.ps1`).
5. **`starved` may now be too generous a word** (unchanged — and tonight
   neither window tripped it, at either doc form).
6. **delete_mask could warn when an expression still points at the mask**
   (unchanged).
7. **A controller GROUP has never been measured**, nor any locale but
   en_US (unchanged).
8. **`capParams` is a second, independent roster inside the same .mogrt**
   (unchanged).
9. **Still owed, needs a human awake:** drop
   `logs\mogrt-verify\AELL Probe Card.mogrt` into real Premiere
   (harness plan step 6).

Nothing was left unattempted this pass: 1c is now closed entirely.
