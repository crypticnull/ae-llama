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
