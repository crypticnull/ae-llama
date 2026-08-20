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
