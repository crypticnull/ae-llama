# TODO

## Now

- [ ] **Verify `aa8a636` in real AE, then `node scripts/bump-version.js patch`.**
  Matt, 2026-09-23: *"Yeah, write the patch. We can verify tonight."* It was
  committed deliberately UNBUMPED that night — and **never bumped since**.
  Eight commits have landed on top of it (checked 2026-11-06) and none is a
  version bump, so the fix has been in the repo and in no panel for six weeks.
  What it does: the panel's `stopManaged()` no longer `taskkill /T /F`s a pid
  it cannot prove is its own ComfyUI (localStorage records outlive an AE force
  kill, and Windows recycles pids, so the next clean quit could take an
  unrelated process TREE), and the `unload` budget went ~50 s -> 11 s.
  Stub-verified only. Needs AE: (1) start the managed backend, quit AE
  normally, confirm the backend dies and AE exits without a pause; (2) start
  it, force-kill AE, relaunch, confirm `reapOrphan()` collects the orphan at
  init rather than the record being dropped; (3) with a backend up, confirm
  unload adds no visible delay to quit. Full item: `docs/WORKPLAN.md` NEXT UP
  V1.

- [ ] **Measure `saveFrameToPng()` from an `AfterFX.exe -r` script, both ways,
  before writing it down as a fact.** Reported by the sales-preso pipeline
  2026-09-23: it returns normally and writes nothing from `-r`, while working
  from the panel. If it reproduces, it belongs in `render_comp`'s comment block
  and in CLAUDE.md's hard-won facts. Do not record it as a fact on the report's
  word alone. Full item: `docs/WORKPLAN.md` NEXT UP V2.

## Matt's, not mine

- [ ] **Remove the duplicate CEP extension.**
  `%APPDATA%\Adobe\CEP\extensions\com.cptk.aellama.bak-2026-08-26` declares the
  same `ExtensionBundleId` *and* `Extension Id="com.cptk.aellama.panel"` as the
  live symlinked panel, at 0.9.20. Two folders claiming one extension identity.
  Flagged 2026-09-23 with the move command; unknown whether it was run. Any
  bisect of "AE Llama present vs absent" is untrustworthy until it is gone.

- [ ] **Decide on the `no-foreground-waits` hook false positive.** It matches on
  command TEXT, not behaviour — on 2026-10-06 it blocked a patch that only
  *wrote* a polling loop to a file, and a commit message that *quoted*
  `Start-Sleep`. Practically it blocks any commit whose message mentions a
  sleep, which in this repo recurs. Also worth reconciling its wording
  ("never another wait loop") with the standing wait rule ("read the signal
  every 2 to 5 seconds"), which is a loop with a sleep in it. Resolved here as:
  the hook governs Claude's foreground commands, the rule governs script
  internals.
