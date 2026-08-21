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
