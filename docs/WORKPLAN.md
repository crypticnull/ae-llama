# Work queue — local (real-AE) session

Ordered priorities for the agent running on the AE machine. Work top to
bottom; commit small, tested fixes to the dev branch
(`claude/ae-plugin-llama-cpp-f13g3x`) with clear messages. Big features
and releases stay with the remote session — flag them instead of
building them.

**Before picking anything, read `docs/MEMORY.md`** — the generated index
over `docs/WORKPLAN-LOG.md`. Unattended passes are fresh sessions with no
memory of each other, so that history is the only thing carrying state —
but do NOT read the log itself: it is ~262k tokens against a 16,384
context, so "read the log" has meant "read an arbitrary part of an
append-only file", which is how a pass acts on a claim that was corrected
200 entries later. The index carries the corrections table, the recent
entries and a subsystem map with LINE RANGES; pull what you need with
`sed -n 'START,ENDp' docs/WORKPLAN-LOG.md`. Append your entry before you
stop, then run `node scripts/memory-index.js`.

Unattended runs are driven by `scripts/run-local-agent.ps1` (pull -> one
item -> commit -> repeat). One item per pass, then stop.

## NEXT UP — read this first, take the first item that is not blocked

Maintained 2026-09-09 (local session). **This exists because the brief tells a pass NOT
to read the whole workplan** (it is ~46k tokens) — so without an ordered
list at the top, a fresh unattended session has to guess which of
nineteen sections holds live work, and the live work is in the LAST
three. Sections 1-16 are almost entirely struck.

**The rule stays: the harness comes first.** If
`scripts/run-ae-selftest.ps1` is red, fixing it IS the pass. Only when
it is green does this list apply.

Take the FIRST item whose "needs" are satisfied. If an item fails for an
environmental reason (no disk, no network, a download that will not
finish), say so in the log and **move to the next one** — do not spend
the night retrying it.

**Landed overnight 2026-09-09 — do NOT redo any of it.** Items 1 through
8 of the previous queue are all done: the managed backend installed
(§17c), KREA2's sampler chosen by rendering (§17f), enum-value preflight
(§17g), four dead probe branches (§17n), one backend-resolution rule
across six scripts (§17m/h/o), the test suite no longer killing the live
backend (§17p), and basic templates SHIPPED and MEASURED for sd15, sdxl,
wan22-5b, krea2, H3 and h3-int8 (§18 P3, P5-P10). `ALLOW_UNMEASURED` is
empty and `ALLOW_NO_TEMPLATE` is down to `[ltx-small]`. Version 0.12.4 to
0.12.16. Every completion note is in `docs/WORKPLAN-LOG.md` under
2026-09-09; they are not repeated here, because this block is read by
every pass and finished work costs the same context as live work.

| # | item | where | needs | bumps |
|---|---|---|---|---|
| 1 | **Confirm the backend did not outlive the loop.** The teardown added 2026-09-09 calls `comfy-install.js --stop` at loop exit. Check this morning's log for a `Backend:` line and that the card was released. If it is missing or the card is still held, that is the item. | §17q | nothing | no |
| 2 | **fp8 Wan 2.2 5B as a second entry, then MEASURE it.** The §18 P10 pattern: the shipped Wan graph with the diffusion filename swapped and nothing else. Cheapest route to a video option under 32 GB. | §18 P7c step 1 | backend, disk | yes |
| 3 | **Settle what `ltx-small` is, then measure it.** The vendor's LTX is 2.3-**22B** — larger than Wan, not smaller. Ask a RUNNING backend's `/object_info` whether LTXV 2B nodes exist; the repo fixture says zero and is wrong (§17l). | §18 P7c step 2 | backend, disk | yes |
| 4 | The panel can quote an ETA LONGER than `comfyTimeoutSec` and then cancel the job at 600 s, having promised a finish. Warn when the estimate passes the timeout, and put the estimate into the timeout message. | §18 P3c | nothing | yes |
| 5 | Pin the invariant the whole install plan rests on: refuse a BUNDLED manifest that names a non-core node pack. True today, guaranteed by nothing. | §22a | nothing | no |
| 6 | Tee the harness's stdout into the loop log. `Running self-test via` and `Crash flag:` appear ZERO times across the whole 2026-09-09 night, so a killed pass leaves no record of whether its self-test was green. | §20e | nothing | no |
| 7 | A guard test for the pass invocation, so a future brief edit cannot re-inject a bare `--` and silently drop the bypass flag again. | §20d | nothing | no |
| 8 | §21 leftovers: the watchdog rule keys on the word "recover" and can never match the real dialog; `Test-AellAeRunning` is version-blind; stale `CrashOccurred = 1` still sits on 26.2. | §21 | nothing | no |
| 9 | The managed backend dies silently within the half hour — measure the cause before fixing it. | §17k | backend | maybe |
| 10 | **No shipped template can take a reference image any more** — i2v left the bundle with the authored H3 graph. | §18 P9a | nothing | yes |
| 11 | `download-gen-weight` re-downloads a weight already present in another `comfyModelRoots` root (6.4 GB wasted, measured; the next one is 26 GB). | §18 P7b | nothing | yes |
| 12 | Decide llama-server's lifetime: give it the same detach seam, or delete the reap that can never fire. | §17i | nothing | yes |
| 13 | The vendor-enum fixture is a hand-taken snapshot with nothing forcing a refresh when the vendor build moves. | §17l | nothing | no |
| 14 | krea2 and ltx-small are the only entries EXEMPT from "a gate must hold its biggest weight file", because their files carry no sizes. | §18 P8a | nothing | yes |
| 15 | `weight-availability-probe.js` defaults to `comfyUrl`, so it cannot see the managed backend without `--url`. | §17h | nothing | no |

**§18 P7a is now HALF ANSWERED.** The owner approved options 1 AND 2 on
2026-09-09 — "give even the lowest end cards an option here if they're
able to have one" — so the MEASUREMENT is queue items 2 and 3 (§18 P7c).
The ship/don't-ship decision is still his. Read on for the gap itself:

**OWNER, READ THIS ONE FIRST: §18 P7a.** Measuring wan22-5b (item 5)
moved its gate 8 -> 32, which leaves **every card under 32 GB with no
runnable video graph** — the recommendation falls to `ltx-small`, which
is experimental and ships no template. Four ways out are laid out in
§18 P7a with what each costs; picking one is yours, not a pass's. The
gap is pinned in two tests so it cannot widen quietly in the meantime.

**If items 1-8 are blocked** (no backend, no disk, no AE), these need
NOTHING but the repo and are always takeable:

| item | where | bumps |
|---|---|---|
| `download-gen-weight` re-downloads a weight that is already in another `comfyModelRoots` root and already listed by the backend (6.4 GB wasted, measured; the next one is 26 GB) | §18 P7b | yes |
| `Setup.scanForModelRoots()` — probe a named shortlist, never scan drives | §19a | yes |
| "Scan for models" button + validate typed roots | §19b | yes |
| The four Option A prompt deletions, one per pass, each gated on `chat-probe --variants` | §15 | yes |
| `test-context-budget.js` starve row | §15 | no |
| `--store-root` on `chat-probe.js` | §15 | no |
| Persist `_floorMB`; launch-time `memory.used` read | §16f 1-2 | yes |
| Mid-render VRAM reading in the scratch comp | §16f 3 | no |
| The 7B at ctx 16,384 and 20,480, fp16 vs `q8_0` KV, via a standalone launcher | §16f 4 | no |

**State of the loop, 2026-09-09 (read this instead of re-diagnosing it).**
The loop WORKS. Night of 2026-09-09: 18 passes, **16 commits**, one
timeout, zero usage-limit waits, 03:15 to 10:15. Do not spend a pass
re-investigating any of it. The week that produced nothing was two
causes, both fixed: the bypass flag eaten by a bare `--` shredded out of
the brief by PS 5.1 (broken 09-05, fixed 09-08 — §20 ROOT CAUSE FOUND),
and AE's crash-recovery dialog, which cannot be clicked by automation and
is now PREVENTED at the registry (§21).

What the log now tells you, per pass: a heartbeat every 30s carrying
elapsed time, the live pid and the dirty-file count; `Pass committed
<sha>` or `Pass produced no commit`; `Pass TIMED OUT` if it ran past
`-PassTimeoutMin` (45); and `Backend:` at loop exit. §20b fired on its
first night at 45:48 and the loop took the next pass 20 seconds later,
which is the only reason the last two passes ran at all.

What it does NOT tell you is §20e: the harness's own stdout goes to the
pass, not the loop, so `Running self-test via` and `Crash flag:` appear
zero times. A pass killed mid-harness leaves no verdict behind. That is
queue item 3.

**Gate 0 for every pass that touches settings or downloads:** print
`Settings.origin()` and refuse when `appdata` is empty. The detached loop
carries APPDATA now (2026-09-06), but a pass that finds it missing is
reading someone else's defaults and must say so rather than proceed.

## 1. Make the harness green (always first)

Run `scripts/run-ae-selftest.ps1`. Fix any failure at its root (host
tool, not the test), then update the stubbed Node test in `tests/` so
the same bug class is caught WITHOUT AE — that is the whole loop:
field truth -> fix -> stub faithfulness.

- ~~`Comp not found` truncated the list at the comp the caller meant~~
  DONE 2026-09-02 (0.11.14). Harness went RED at 588/589: the self-test's
  own project grew past fifteen comps, and the grounded roster was flat
  project order capped at 15 with NOTHING saying it had been cut, so
  "ST HYG Nope" listed fourteen unrelated comps and stopped one row short
  of `ST HYG Keep`. A complete-LOOKING roster that does not contain the
  answer is worse than no roster: it reads as "that comp does not exist".
  New `AELL_compsHere(wanted, cap)` ranks near misses first (comps sharing
  a word with the name that missed, bucketed — ES3 sort is not stable),
  discloses the cap and names `get_project_info {limit: "all"}` when it
  truncates. `AELL_resolveComp` and reduce_project's "which comps matter"
  refusal both use it. Harness 589/589; stub back-fill in
  tests/test-project-hygiene.js (11b) proves the class without AE.

- ~~`add_mask` is told to get layer sizes from a tool that has none~~
  DONE 2026-09-02 (0.11.9). `layer.width` reports the COMP's dimensions
  on a text or shape layer and nothing at all on a camera or light
  (measured, `scripts/layer-size-probe.jsx`), and a text layer's origin
  is its BASELINE — so `get_comp_details` rows now carry the layer's own
  `width`/`height` (only when it differs from the comp) plus `left`/`top`
  (only when the origin is not 0,0), and `add_mask` refuses a mask that
  misses its layer completely OR swallows it whole, naming the real size.
  Zero prompt cost: the doc already said "sizes from get_comp_details"
  and is now true. The bigger rows are paid for by a byte cap on the row
  list (5000, so the state's project half survives). Step 19's paraphrase
  matrix flipped 4 HARM -> 3 pass / 1 miss / **0 HARM**. Harness 570 ->
  576. En route: `tests/test-es3-ternary.js` now also lints the
  ExtendScript that `.js` files BUILD as strings — chat-probe's mask-mode
  reader had the left-associative `?:` bug and scored two correct model
  answers as HARM.

- ~~`organize_project` has clean_project's preview advice and no gate~~
  DONE 2026-09-02 (0.11.8). A first `dryRun:false` filed every loose
  root item and created up to five folders with nothing shown. Same
  three-branch gate as clean_project, on its own `AELL_orgShown`; an
  empty plan is deliberately not gated. Harness 567 -> 570; prompt
  budget paid in full (full -13 chars, compact unchanged).

- ~~The triage calls AE's "Executing Script *" progress window an
  UNRECOGNIZED DIALOG and fails the run~~ DONE 2026-08-30, and the
  filed symptom was not the defect. What actually stopped those runs
  was **Windows' own chrome**: `SysShadow` (a tooltip's drop shadow)
  and `tooltips_class32` are visible, wordless, top-level windows of
  the AfterFX process, and a wordless popup outranks a running script —
  so AE's drop shadow outvoted AE's own progress window and a suite
  that went on to pass 514/514 exited 4. Filtered in both layers, with
  the real-AE capture replayed as a stub test (8 assertions fail
  without the fix). The harvest learned the progress window too.
- ~~**STILL OPEN, filed by that pass: what is the `DroverLord - Window
  Class` popup?**~~ IDENTIFIED 2026-08-30, by census rather than by
  luck. `DroverLord - Window Class` is not a dialog class at all — it is
  Adobe's widget class, and EVERY window inside After Effects is one.
  Three measurements name the popup: (1) the save-changes prompt's own
  `#32770` contains exactly three DroverLord children reporting
  `OS_ViewContainer / OS_ViewContainer / OS_EditTextContainer` plus an
  `Edit` — the field capture's fingerprint, container for container;
  (2) every idle AE has a top-level DroverLord popup host parked hidden
  at 0,0,0,0, `WS_POPUP | WS_EX_NOACTIVATE`, unowned and wordless; and
  (3) during a real self-test run AE creates those same containers as
  PARENTLESS top-level windows (`OS_ViewContainer`,
  `OS_EditTextContainer`, a bare `Edit`) before parenting them into a
  dialog shell — captured 20+ times across four watched runs. So the
  popup is AE's own dialog CONTENT, caught top-level, and it can never
  take focus. `CloseWordlessDialogs` was NOT widened: it still posts to
  `#32770` alone. What changed is what may BLOCK — a wordless popup
  carrying `WS_EX_NOACTIVATE` or `WS_EX_TOOLWINDOW` is discounted, which
  is the property the SysShadow/tooltips class list turned out to be an
  instance of. Both real AE modals measured that night (a Script Alert
  and the save prompt) carry neither flag and are owned by the main
  window. `scripts/ae-window-census.ps1` is the tool that answered it.
  See WORKPLAN-LOG 2026-08-30.

- ~~**`Analyzing Audio...` is up for ~6.5 s of EVERY harness run and
  reads as `unreadable`**~~ DONE 2026-08-30. Built as filed, from the
  discriminator the census had already measured: the probe now finds
  AE's "Executing Script ..." window in a pass of its own (EnumWindows
  walks the Z-order, so a dialog the script raised is enumerated BEFORE
  its owner) and annotates any popup that window OWNS as
  `{scriptowner ex=... owner=...}`; the verdict layer reads a WORDLESS
  block so marked as evidence the script is running, exactly as it
  reads the progress window itself. Re-measured first, on this machine:
  the audio dialog is `ex=00090121 owner=<progress hwnd>`, while the
  progress window, `Auto-Save Project` and a deliberately-raised
  `Script Alert` are all `owner=<main hwnd>`. A marked popup is still
  COUNTED and still read for its children (unlike the chrome filter) —
  one that says anything still blocks. Field result: `unreadable`
  disappeared from a whole run (7 distinct states before, 0 after);
  stub test 165 -> 187 checks, 15 of which fail if the fix is reverted.

## 1b. ~~VERIFY the zero-silent-failure batch~~ DONE 2026-09-01 (0.11.1)

Every bullet below was run in real AE and the batch SHIPPED (patch bump
0.11.0 -> 0.11.1). It found one real defect of its own class:
`set_track_matte` reported ok on a CAMERA — a camera carries no
`setTrackMatte` at all, and `camera.trackMatteType = LUMA` is accepted
silently, so the tool reordered the stack with moveBefore and returned a
receipt for a matte AE never made. Fixed by refusing on layer TYPE, with
6 new selftest steps and 9 stub assertions. Watch out for the trap the
first cut fell into: `instanceof AVLayer` is FALSE for text and shape
layers too. See WORKPLAN-LOG 2026-09-01. The pass-22 salvage bullet at
the end was its own pass and is DONE 2026-09-02 (0.11.6) — the stash and
the backup branch are gone; what was applied, what was filed and why is
in that bullet.

<details><summary>original bullets (kept for the measurements they name)</summary>

The remote session built roadmap item 1 + MOGRT step 0 (see
docs/AUDIT-0.11.md part 2 item 1) with the full stub suite green.
None of it reaches a panel until this machine verifies it in real AE
and patch-bumps. One pass, in this order:

- Run `scripts/run-ae-selftest.ps1` to green (533+ steps; the changed
  error texts were grepped against existing steps — none pin the old
  bare forms — but real AE is the judge).
- Probe the stub-blind class directly (temp .jsx via AELL_call, per
  CLAUDE.md): (a) a set_keyframes batch where key 3 of 5 is invalid →
  the result must be mutated:true and a BATCH round must roll back
  (fingerprint restore); same for apply_keyframe_ease; (b)
  set_track_matte against a shape/text layer → the wrapped error
  names both layers' types and the valid modes; (c) apply_effect with
  a garbage name → refusal lists the layer's effects and the
  list_effects pointer; (d) export_mogrt name "CON" → refused before
  AE (no debris folder created).
- MOGRT settle: export a real (small) mogrt to a scratch folder and
  confirm the bytes receipt equals the final on-disk size (the fix
  polls for two stable sizes ≥250ms apart — a mid-write number was
  the live bug).
- comfy image-landed: with ComfyUI up, comfy_generate {workflow:
  AE_LLAMA_KREA2_V1, image: <any png>} must REFUSE naming the
  workflow and the firstFrame-capable templates — nothing queued, no
  GPU spend. Then the H3 I2V happy path with an image still works.
- Also riding this same bump (no separate verification needed —
  stub-tested against real git repos): the dev-install updater's
  failure copy (`gitPullProblem` in setup.js) — a stopped pass's
  uncommitted bump files blocked the owner's panel update 2026-09-01
  and the old message cut git's stderr mid-word, hiding the file list
  and the fix.
- All green → `node scripts/bump-version.js patch`, push, log. Any
  failure → fix at the root, keep the stubs faithful, then bump.
- **Pass-22 salvage — DONE 2026-09-02 (0.11.6).** Read, measured,
  half-applied, half-filed, stash and branch dropped. `aell-backup-pass22`
  turned out to hold nothing: it was an ancestor of `origin/main`, so the
  whole of pass 22 was in the stash. Note for anyone reading the older
  log entries: the stash had MOVED to `stash@{1}` by the time this ran —
  `run-local-agent.ps1` pushed a `loop-salvage-*` on top of it, so
  "stash@{0} is pass22-salvage" was stale advice. **Always find it by
  name.**
  - **APPLIED: the `fitHistory` floor.** Pass 22's load-bearing find was
    still a live defect on today's head, and it was not a guess:
    reproduced end to end against this machine's real 32B
    (`scripts/history-floor-probe.js`, new). When one entry inside the
    protected four-entry tail is bigger than the whole budget,
    fitHistory returned a payload it had already computed was too big;
    main.js's reactive retry called back with budget 1, got the SAME
    BYTES, and llama-server refused both with the identical "request
    (17733 tokens) exceeds the available context size (16384)". The chat
    was dead until cleared. Now the survivors' CONTENT is shortened,
    oldest of the tail first, each cut naming itself in words.
  - **FILED, not applied — pass 22's other half** (`Llama.measurePrompt`
    + `Tools.planContext` + a caller-supplied `max_tokens`). It was
    written against the tools.js of 2026-09-01 and the 0.11.4
    context-budget pass has since answered the same question differently
    and with its own tokenizer measurements (`historyBudget`, the pinned
    3.7/2.7 ratios, the ledger). Applying planContext would have
    replaced measured work with older measured work. What is worth
    keeping is the ONE idea 0.11.4 does not have — see roadmap item
    below.
- **NEW, from the salvage: ask the SERVER for the two numbers.** The
  panel budgets the window from `settings.ctxSize` and an estimated
  chars/token ratio. llama-server will answer both exactly:
  `POST /tokenize` gives the prompt's real token count, and `GET /props`
  gives the `n_ctx` the server was actually STARTED with — which is not
  necessarily the one settings.json remembers (a hand-launched server,
  or a model whose trained maximum clamped it). Pass 22 measured
  /tokenize at 14-40 ms on a 54611-char prompt, nothing against a 1-3 s
  round. **No live symptom on this machine** — measured 2026-09-02,
  settings said 16384 and the server's own 400 reported `n_ctx: 16384`,
  so they agreed — which is why this is filed rather than built. Needs
  its own pass: an extra HTTP call per request is a behaviour change,
  and the interesting case (the two numbers DISAGREEING) has to be
  staged deliberately to be measured at all.
- **Pass-22 salvage — RECOVER, do not drop.** (original instruction,
  kept for the rules it names.) The owner's reset on
  2026-09-01 parked pass 22's uncommitted work in stash
  `pass22-salvage` (and any unpushed commits on branch
  `aell-backup-pass22`). It was NOT just the 0.10.22 bump: `git
  status` showed extension/js/llama.js, main.js, tools.js,
  scripts/chat-probe.js and tests/test-history-trim.js modified — a
  coherent history-trim change the pass was killed in the middle of,
  with no log entry (it never got that far). Own pass, after the
  verification above: `git stash show -p stash@{0}` (or the named
  stash) and `git log aell-backup-pass22 --not origin/main`; read
  what it was building; then EITHER apply it onto the current head
  (`git stash apply`, resolve conflicts against today's tools.js /
  main.js changes with the audit's rules — tools.js changed a lot
  2026-09-01), run the full stub sweep + real AE, commit under the
  pass-22 intent, bump, push — OR, if it is fragmentary, write a log
  entry naming exactly what it attempted and which files, so the
  intent is not lost, then `git stash drop` + `git branch -D
  aell-backup-pass22`. The four bump files in the stash are noise
  either way (0.11.x supersedes them).

</details>

## 1c. VERIFY the daytime batch of 2026-09-01 (trigger layer + missing verbs + MOGRT verifier; UNBUMPED)

Built remote by three passes + adversarial review, full stub suite
green. Rides the SAME patch bump as 1b when both verify — one bump,
one push. One pass per bullet:

- **Trigger layer (roadmap 2) — DONE 2026-09-02 (0.11.2).** Both runs'
  per-step verdicts are in `docs/WORKPLAN-LOG.md`. It found a real
  defect of its own class: `trackMatteType` is not an existence test
  (removeTrackMatte leaves it stale, NO_TRACK_MATTE is 5012), the panel
  could not SEE a track matte at all, and step 27 flipped to pass after
  the fix. Two misses filed for later passes: `add_mask` accepts bounds
  that miss the layer, and "clean up this comp" routes to the project
  panel (the only miss that repeated across both runs). The original
  instruction, for reference:
- **Trigger layer (roadmap 2).** Run `scripts/chat-probe.js` with the
  real model — 15 new steps (indexes 15-29) each say a casual sentence
  ("delay it", "tag along", "chop off the lower half", "dress HELLO
  up", "tuck it in underneath", "strip it off", "bundle") and assert
  the RIGHT tool's fingerprint. Log per-step verdicts to WORKPLAN-LOG.
  A miss is a WORDING dependency: one tool-doc/rule change per pass,
  re-run to show the flip (section 8 rules). The "sync to the music"
  step judges the honest refusal on the silent rig — add an audio
  layer to the rig if you want its success branch measured. Also
  measure: the prompt grew ~12% (54.5k → 61.1k chars); confirm a
  full round at ctx 16384 still leaves room for results + 4 turns of
  history (a context-400 hard-trim on an ordinary ask = trim rules).
- **Missing verbs (roadmap 4) — DONE 2026-09-02 (0.11.3).** All eight
  measured in AE 2026 by the new `scripts/verb-semantics-probe.jsx`;
  per-assumption verdicts are in `docs/WORKPLAN-LOG.md`. Two of the
  three guesses the host code had written down as guesses turned out
  RIGHT for a reason nobody had checked (AE honours the lock and
  refuses a self-move at the SCRIPTING layer, throwing both times), (6)
  was confirmed exactly, and (8) got its answer: emptying a property
  leaves the LAST key's value — now in the remove_keyframes doc and
  held by a new real-AE step (566/566). The original instruction, for
  reference:
- **Missing verbs (roadmap 4).** Selftest is 555 steps now; run it to
  green. Then probe the seven flagged AE-semantics assumptions
  directly (temp .jsx via AELL_call): (1) moveBefore/moveAfter on a
  LOCKED layer — the tool refuses first; does AE honour the lock if
  called?; (2) moveBefore(self); (3) already-in-place move reports
  "Nothing moved"; (4) toFront/toBack via moveBefore(layer(1)) /
  moveAfter(last) land at index 1 / last; (5) after remove_effect and
  delete_mask, survivors are NOT renumbered ("Glow 2" stays) and
  later-sibling references invalidate; (6) bare-name read-back
  "Blurriness" after removing one of two blurs resolves to
  Effects/Gaussian Blur 2/Blurriness; (7) the delete_mask step's
  expression clear avoids a modal. Fix stubs to what AE MEASURED
  wherever an assumption was wrong. Plus one the trigger-layer review
  raised: (8) after remove_keyframes removes every key (the host
  removes key 1 repeatedly), WHICH value remains — the last key's, or
  the value at the current time? The probe's "un-animate" step records
  the residual opacity without failing on it; measure it, then pin the
  answer in the remove_keyframes doc (the unmeasured claim was removed).
- **Context budget + ledger (roadmap 13) — MOSTLY DONE 2026-09-02
  (0.11.4).** New re-runnable probe `scripts/context-budget-probe.js`
  asked the running llama-server's `/tokenize` what the panel's own
  payload costs. BOTH constants were inside the 10% trigger and BOTH
  were wrong in the direction that kills a chat: at the shipped default
  (compact docs, ctx 16384) the arithmetic promised 16515 tokens against
  a 16384 window. Pinned to the measurement (3.9 -> 3.7, 3 -> 2.7), with
  `tests/test-token-ratios.js` freezing the tokenizer's answer — seven
  assertions go red on the old values. The ledger measurement passed end
  to end (ten naming turns, then "make them blue instead" answered with
  all ten names). T7 answered NO: at ctx 32768 the 32B leaves 850 MiB on
  a 32607 MiB card with ComfyUI holding nothing. Per step verdicts and
  numbers in `docs/WORKPLAN-LOG.md`. **The compact-vs-full ROUTING
  comparison is now DONE 2026-09-02 (UNBUMPED — nothing in extension/
  changed): compacting the tool docs costs NO routing. Four runs (two
  per mode, `scripts/chat-probe.js --ctx 32768` for the full form)
  scored 24 of 26 steps identically; compact 24/26 and 25/26, full
  25/26 and 24/26. The one step that differed failed once in EACH mode,
  so it is temperature noise, not a lost sentence — no doc change was
  owed and none was made. New re-runnable comparator:
  `scripts/routing-compare.js`. It also settled the standing "clean up
  this comp" miss: that step failed in ALL FOUR runs, so it is
  unconditional, NOT a compaction casualty — the full doc's "PROJECT
  PANEL only" sentence and the never-compacted rule both say it and the
  model does it anyway.** The original instruction, for reference:
- **Context budget + ledger (roadmap 13, shipped remote 2026-09-01
  evening, UNBUMPED, rides the same bump).** Three measurements, then
  the probe: (1) ask the running llama-server `/tokenize` for the REAL
  token count of `Tools.buildSystemPrompt(state, {compact:true})` and
  of the full form — the panel's estimate assumes ~3.9 chars/token for
  the prompt and ~3 for history; pin the measured ratios into
  `PROMPT_CHARS_PER_TOKEN` / `HISTORY_CHARS_PER_TOKEN` in tools.js if
  they are off by more than 10%; (2) at ctx 16384 the panel now sends
  COMPACT tool docs (one sentence each; the rules block is unchanged)
  — run `scripts/chat-probe.js` in that mode (it follows the same
  promptModeFor) and log every step verdict: a routing regression
  against the full-doc run is a doc that lost its load-bearing
  sentence — restore that ONE sentence, re-run; (3) drive a chat past
  the window (ten turns naming things, then "make them blue instead")
  and confirm the ledger carries the names — the "context ledger"
  info line appears once, the "context" starvation line appears at
  16384 with the full prompt and NOT with the compact one. Record the
  measured room (`Tools.historyBudget(ctx, system.length)`) at 16384
  and at 32768 in the log; if 32768 fits the card with the 32B (the
  arbiter's numbers say), propose raising the T7 default.
- **MOGRT verifier (harness plan 1, steps 1-3) — DONE 2026-09-02
  (0.11.5).** Everything in the bullet was run in real AE by the new
  `scripts/mogrt-verify-probe.js` + `.jsx`, per-claim verdicts in
  `docs/WORKPLAN-LOG.md`. It found a defect of exactly its own class:
  the verifier had never opened a file AE wrote, and could not read one
  — Adobe's `strDB` rows are `{localeString: <locale>, str: <value>}`
  and the reader had those swapped, so EVERY controller in EVERY real
  export read back as the string `"en_US"` and the receipt claimed all
  of them dropped. The hand-built fixtures shared the invented shape, so
  105 checks agreed with a reader that could not read anything real.
  Also measured and pinned: the type key is `type` (never the invented
  `controlType`), and `capsuleName` is always the literal `"Untitled"`
  — a permanent false warning, replaced by comp-name parity. Fixture
  committed at `tests/fixtures/ae2026-definition.json`; the independent
  PowerShell zip check agreed entry for entry. STILL OWED: the ONE
  manual step, dropping `logs\mogrt-verify\AELL Probe Card.mogrt` into
  real Premiere (harness plan step 6) — the pin was taken without it on
  purpose, see the log for why. Also still unmeasured: a controller
  GROUP, and any locale but en_US. The original instruction, for
  reference:
- **MOGRT verifier (harness plan 1, steps 1-3).** Export a small real
  mogrt through the panel: the receipt must now carry
  `controllerNames`, `zipValid: true`, `controllersInFile` equal to
  the exposed count, `templateNameInFile`, and no `verifyNote`.
  Hand-truncate a copy and re-run `MogrtRead.verifyExport` on it →
  grounded failure naming the path. THEN the measure pass the plan
  gates everything on: drop one export into real Premiere Pro (the
  ONE manual step), and if it opens, commit its definition.json
  (scrubbed) as the pinned fixture and correct `PROVISIONAL_KEYS` in
  extension/js/mogrt-read.js to the field names Adobe actually uses —
  until then the roster parity is best-effort and its mismatches are
  WARN-class evidence, not verdicts. Also run the Windows independent
  check: `AELL_MOGRT_FIXTURE_OUT=<path> node tests/test-mogrt-read.js`
  emits the all-forms fixture; open it with
  System.IO.Compression (Expand-Archive) and record agreement.

## FAST-TRACK: comp-rename audit tools — DONE 2026-08-25 (0.9.15)

The owner has a real work assignment: bring an old roofing-presentation
project's comp names onto the org convention. The panel cannot do it
safely today, and the missing pieces are two tools. Probe-first as
always; this outranks the feature track because a human deadline hangs
on it.

**Probe pass** (facts before code):
- `item.usedIn` — does it return what training says (array of comps
  containing this comp as a layer)? Cost on a large project?
- Project-wide expression scan — walk every comp/layer/property,
  collect `prop.expression`; wall time on a big real project.
- THE assumption behind rule 3: does renaming a comp actually BREAK
  `comp("Old Name")` string references in AE 2026, or does modern AE
  rewrite them? Build a two-comp rig, rename, check expressionError.
  If AE rewrites, the skip rule relaxes and the log says so.

**Build pass** — two tools:
- `audit_comp_usage`: per comp — usedIn list, render-queue membership,
  and every comp whose NAME appears inside any expression string
  project-wide. Facts only, no judgments.
- `rename_comps`: takes the FULL rename map in one call (sidesteps the
  8-commands-per-reply cap), `dryRun: true` is the DEFAULT and returns
  the preview table; `dryRun: false` executes in one undo group.

**Naming rules (owner-confirmed):**
- Year present in the OLD NAME -> prefix `REVyy_` (two-digit: 2026 ->
  `REV26_`), prepended, old name kept: `REV19_Roof_Shingle_2019_v2`.
- Year detection is CONSERVATIVE: 4-digit 19xx/20xx only. A bare "26"
  or "v26" is a version number, not a year.
- No year -> prefix `REV_NO-YEAR_`, old name verbatim.
- Already `REV\d\d_` or `REV_NO-YEAR_` prefixed -> skip (idempotent;
  running it twice must change nothing).
- Two DIFFERENT years in one name -> no guess; flagged in the preview
  for the human.
- Expression-referenced comps (per audit) -> HARD skip with reason.
- Likely-utility comps (nested in others, never render-queued) ->
  marked in the preview and skipped BY DEFAULT, human can override —
  the audit supplies facts, the human owns the judgment.

**Suite/stub:** stub the project walk (usedIn, expressions, queue) and
assert: year extraction table incl. the v26 trap, idempotency, hard
skip on expression reference, preview-before-execute. Selftest: a
3-comp scratch rig (one nested, one expression-linked, one plain) —
audit facts correct, dry run correct, execute renames ONLY the plain
one.

Patch-bump when verified: it fixes no shipped behavior but the owner
needs it ON the panel — call it the exception that ships as a patch,
noted here so nobody relitigates it.

## 2. Real-AE verification debt (things stubs cannot prove)

Verify each by scripting AE directly (temp .jsx + AELL_call, see
CLAUDE.md). Where behavior is wrong, fix + extend selftest.js.

DONE — do not re-verify (see WORKPLAN-LOG.md): grid rig under both
expression engines, center_anchor_point on rotated/scaled/parented and
animated layers, scale_comp with cameras/keyframes, text styling and
font validation, cameras in the suite (old item 2b).

ALL FIVE remaining bullets are now DONE. The four below were finished
2026-08-21 and the text simply never got struck, which cost a later
pass a re-read of the log to work out what was left — so they are
struck now:

- ~~split_layer_into_chunks on real FOOTAGE~~ DONE 2026-08-21.
- ~~distribute_property step mode; reorder_layers stack order~~ DONE
  2026-08-21 (found three real bugs; see the log).
- ~~set_mask_path keyframes actually ANIMATE~~ DONE 2026-08-21.
- ~~for_each_layer across 50+ layers, and 200-layer timings~~ DONE
  2026-08-21 (timings in the log; nothing over ~1s).
- ~~add_light~~ DONE 2026-08-26. Built, documented, stub-tested and
  covered by 19 real-AE suite steps (harness 187 -> 206). All five AE
  2026 types incl. ENVIRONMENT, per-type grounded refusals from a
  matrix measured in the field, validate-before-create. NOT bumped:
  a new tool rides the next MINOR, which is the remote session's.

Item 2 is CLOSED. The next pass should start at 2d (H3 i2v workflow,
parts 1-3) or item 3/4, not here.

Two things this item surfaced that are NOT done, each worth its own
small pass rather than being smuggled in:

- ~~`scale_comp` still does not scale a LIGHT's pixel-valued options
  (falloff distance, shadow diffusion)~~ DONE 2026-08-28 (0.9.26).
  Radius, Falloff Distance and Shadow Diffusion now scale with the comp,
  keyframes included, parented or not, gated by the type+falloff matrix
  measured in the field; angles and percentages are left alone. The probe
  also found two AE lies the tool was believing — an ambient light was
  reported as a FAILED layer because AE hides its Position, and a point
  light reports autoOrient 4214 like a two-node spot and then refuses its
  Point of Interest. Harness 262 -> 277.
- ~~`get_property` cannot reach `Radius` or `Falloff Distance` by bare
  name~~ DONE 2026-08-28 (0.9.27). The probe found the gap was never
  about lights: AE's layer-level shortcut is a fixed list with an
  arbitrary edge (a light answers Intensity and Cone Angle but not
  Radius; a solid answers Opacity but not its own effect's Blurriness; a
  shape layer answers Contents but not Size), so any bare name AE refuses
  is now searched down the real tree, roots in a measured order with
  Layer Styles LAST - AE ships all eleven on every layer whether or not
  one was applied, and they would otherwise outrank the property the user
  meant. Ties are refused with both real paths; the result names the path
  it found. Harness 277 -> 289.

**Item 2 has nothing left. The next pass starts at item 3, 4 or 5.**

## 2c. Inventory the owner's real ComfyUI install — DONE 2026-08-25

The remote session cannot see this machine's disk. Scan
`C:\Users\mr\Documents\ComfyUI` and write
`docs/COMFY_LOCAL_INVENTORY.md` with:

- Every model file under `models/` (all subdirs): relative path, size
  in MB, and which kind-folder it lives in. Flag the files the Krea
  manifest needs (`extension/workflows/AE_LLAMA_KREA2_V1.manifest.json`)
  and the MiniMax H3 / Wan 2.2 weights specifically.
- Every folder under `custom_nodes/`: name + (from its git config or
  pyproject) the repo it came from. This must ATTRIBUTE the manifest's
  UNKNOWN nodes: Krea2Control*, DepthAnythingV2Preprocessor,
  ArcaneBloomFX, easy cleanGpuUsed.
- The ComfyUI version (its own version file / git tag) — the bundled
  installer must match or exceed 0.3.76 (subgraphs).
- Any extra_model_paths.yaml already present (models may live on other
  drives — list those roots too).

Pure filesystem reading — no AE, no generation runs, do NOT launch
ComfyUI. This unblocks tier-plan P5 (catalog file lists + sizes) and
the register-existing matcher. Commit the inventory; no version bump.

## 2d. Small local passes queued by the probe findings — CLOSED
2026-08-28 (0.9.23). Everything in this section is done: the H3 i2v
workflow through part 4, the portability pass part 4 filed, and — last —
KREA2, which now ships adapted, seeded, rule-complete and rendered end to
end through the panel into AE (17s authored / 10s bare, both 1232x1232).
Nothing below needs doing; the text is kept because the reasoning in it
is what the next template will be built against. **The next pass starts
at item 3, 4 or 5.**

- ~~Locate the H3 base weight~~ FOUND by the owner (2026-08-25):
  `AppData\Local\Comfy-Desktop\ComfyUI-Shared\models\diffusion_models\`
  — a THIRD root, the Desktop app's shared auto-download store. Remaining
  5-min task: list that whole ComfyUI-Shared\models tree (two files
  matched the H3 filter — record exact names + sizes) and append it to
  docs/COMFY_LOCAL_INVENTORY.md; the register matcher's root list is
  now Documents + code install + ComfyUI-Shared + node ckpts dirs.
- ~~**Verify the history trim**~~ DONE 2026-08-25 (0.9.17), re-confirmed
  2026-08-26. Original text: (probe steps 9–10) the remote session
  bounded what the model is sent (Tools.fitHistory + a hard-trim retry
  on context 400s). Re-run the full chat probe — steps 9 and 10 died on
  context overflow before; they should now complete, with the "context
  trimmed" notice appearing once. Green -> patch bump, this fix plus
  the set_property->for_each_layer redirect ship together.
- **H3 i2v workflow RECEIVED** (AE_LLAMA_H3_I2V_V1 + manifest): the
  fl2va weight covers BOTH t2v (no image) and i2v, superseding r2v as
  the first H3 target. Local pass, in order:
  - ~~(1) template adaptation~~ DONE 2026-08-26. It was bigger than the
    manifest thought: EVERY bundled workflow is UI-format and
    `loadWorkflow` refuses UI-format, and `extension/workflows/` is not
    the seed dir either. So the pass built the conversion instead —
    `scripts/harvest-comfy-node-defs.py` (+ the checked-in defs) and
    `scripts/adapt-workflow.js`, handling positional widget decoding,
    control_after_generate, V3 dynamic combos, autogrow groups and
    bypass rewiring. Output is seeded at
    `extension/comfy-workflows/AE_LLAMA_H3_I2V_V1.json` and passes
    ComfyUI 0.32.0's own `validate_prompt` (`valid: true`). See the log.
  - ~~(2) wire the manifest `procedural` injection points into comfy.js
    injectParams~~ DONE 2026-08-26. injectParams takes the manifest as a
    third argument and honours `procedural` (prompt, durationSeconds,
    resolution, firstFrame) with grounded refusals; `comfy_generate`
    gained `durationSeconds` (a `frames` arg on a seconds template is
    REFUSED, not converted) and `image` (uploaded to ComfyUI's input dir
    via the new `Comfy.uploadImage`). With no image the reference
    LoadImage is DETACHED and the graph runs t2v, so the template no
    longer names a one-machine PNG. Both paths return `valid: True` from
    ComfyUI 0.32.0's own validate_prompt. See the log.
  - ~~(3) ONE real generation end-to-end through the panel to verify~~
    DONE 2026-08-27 (0.9.21). It ran: prompt -> ComfyUI -> mp4 -> AE, 12s,
    VRAM peak 28.4 GB. Built `scripts/comfy-probe.js` (the ComfyUI half of
    chat-probe) and it immediately found what three validate_prompt passes
    could not: ComfyUI's `%date:...%` filename tokens are expanded by the
    FRONTEND, never the server, so the panel's own posted graph died at
    SaveVideo on a colon Windows will not accept. Fixed in comfy.js and
    covered by tests/test-comfy-filename-tokens.js. See the log.
  - ~~(4) attribute the manifest's UNKNOWN nodes~~ DONE 2026-08-27. Done
    for ALL THREE bundled workflows, from the running loader's own
    `/object_info` rather than by grepping pack sources. It found more
    than a placeholder: the i2v manifest that already said "attribution
    scanned" was missing two packs the SHIPPED template loads
    (ComfyUI-sol-attn, ComfyLiterals) and named three classes wrongly.
    `scripts/attribute-workflow-nodes.js` regenerates it;
    `tests/test-workflow-manifests.js` fails CI if a manifest and its
    graph ever disagree again. See the log.
  - ~~**NEW, from part 4:** the shipped H3 i2v template hard-requires SIX
    custom packs and only RTXVideoSuperResolution is declared bypassable~~
    DONE 2026-08-28 (0.9.22). All seven undeclared classes are removable:
    four MODEL patches bypass through `model` and collapse the chain to
    `148 -> 163 -> 139`, two are incidental, and ComfyLiterals' `Float`
    could not be bypassed at all (a literal source has nothing to rewire
    to), so `optionalNodes` gained `substitute` and it becomes core
    `PrimitiveFloat`. Measured on a freed GPU: bare 18s / 31349 MB vs
    authored 20s / 31285 MB, and the bare graph imported into real AE at
    544x288 with audio. `comfy-probe.js --bare` renders the fallback
    graph on demand; test-workflow-manifests now FAILS any shipped
    template with a non-core class that has no removal rule. See the log.
  - ~~Also surfaced, its own small pass: the KREA2 template contains a
    SUBGRAPH the converter refuses to flatten~~ CONVERTER DONE
    2026-08-28. It did not need the /history route after all:
    `adapt-workflow.js` now flattens subgraphs inline as
    `<instance>:<inner>` (ComfyUI's own id scheme), drops rgthree's two
    frontend-only nodes, and — the part nobody had noticed — emulates
    cg-use-everywhere's `Anything Everywhere`, which draws NO wire and
    carries MODEL/CLIP/VAE/LATENT to nine sockets in this graph. The
    converted KREA2 returns `valid: True` from ComfyUI 0.32.0's own
    `validate_prompt`. See the log. Original text: Route that works — queue
    it once in ComfyUI and pull the executed prompt from `/history`
    (the owner's `get-api-workflow.ps1` already does this). H3 r2v is
    still unconverted too. Two facts for that pass, measured 2026-08-27:
    the subgraph is "Initial Loader" and holds only UNETLoader/VAELoader/
    CLIPLoader (all core), and `adapt-workflow.js` FRONTEND_ONLY knows
    about Note/MarkdownNote but not rgthree's `Label (rgthree)` or
    `Fast Groups Bypasser (rgthree)`, which KREA2 uses and which are
    provably absent from the server.
  - ~~**KREA2, what is LEFT before it can ship**~~ DONE 2026-08-28
    (0.9.23). All five rules written and measured, `procedural` block
    written (prompt only — resolution and seed are already covered by
    injectParams' generic walk, and the manifest says so), and TWO real
    generations run: the authored graph and the `--bare` one, both
    landing 1232x1232 in real AE. Three things the pass found that the
    item did not anticipate: `Power Lora Loader` emits MODEL **and**
    CLIP, so `passthrough` had to grow a per-output-slot map or the text
    encoders would have been handed a MODEL; `SesquiLatentUpscale` had
    to be SUBSTITUTED (core `LatentUpscaleBy`) rather than bypassed,
    since dropping it silently shrinks the output 1.6x; and the
    authored SaveImage prefix was an ABSOLUTE one-machine path that
    ComfyUI refuses anywhere else, now corrected through the new
    `panelAdaptation.setInputs`. See the log.
  - H3 r2v is still unconverted — deferred until 5.8 lands, since it
    needs image+audio inputs the panel cannot feed yet.
- ~~**Pin H3 t2v/i2v files**~~ DONE 2026-08-25, in the log entry "item
  2d: shared root, history trim, H3 pins, set_solid_color" — all 30
  files are recorded in `docs/COMFY_TIERS_PLAN.md`. Re-listed from the
  HF API on 2026-08-28: unchanged, nothing new in the repo. The text
  simply never got struck, which is the second time that has cost a
  pass a re-read of the log.
- ~~**clearExpressions in real AE**~~ DONE 2026-08-26 (0.9.18). Verified
  in the field: refuse-then-recall-with-flag is what the model does, and
  the nine squares land on even gaps. Two defects found on the way and
  fixed at their roots — hostscript now publishes `$.global.AELLJSON`
  (chat-probe's verdict reads had been failing silently AND wedging AE on
  a modal), and the overriddenByExpression note now asks for the SAME
  layers list on the re-call, because handing back only the blocked ones
  re-spaces those and strands the layers that already landed. See the
  log entry. Original text:
  the step-7 policy question is settled — distribute_property takes
  `clearExpressions: true` (clears ONLY expressions that swallowed the
  write, on an explicit re-call; see the log entry). Local pass: run the
  187-step suite (4 new steps in the order comp), re-run chat-probe
  step 7 — expected shape is now refuse-then-recall-with-flag, and the
  existing even-gaps verdict measures exactly that end state — then
  patch bump together with whatever else is verified.
- ~~**set_solid_color**~~ DONE 2026-08-25 (0.9.17) — built, and it
  closed chat-probe step 9. Original text: no tool can change a solid's color
  (probe step 9's real blocker — the model tried four approaches; none
  exist). The color lives on the SOLID SOURCE, so changing it changes
  EVERY layer sharing that source — duplicate_layer and
  split_layer_into_chunks share sources, so this trap is the panel's
  normal case, not an edge. Probe: is solidSource.color writable; what
  does AE do when the source is shared; can a layer be given its OWN
  copy first (the Solid Settings "New" checkbox, from script). Build:
  set_solid_color {layer(s), color, makeUnique?: bool} with the shared-
  source consequence stated in the result either way.

## 3. Extend selftest.js coverage — FIRST SWEEP DONE 2026-08-28 (0.9.24)

Every verified behavior from (2) becomes a permanent step in
`extension/js/selftest.js` (both the panel button and the harness pick
it up automatically). Keep results compact; steps must clean up after
themselves inside the scratch comp.

The sweep against the computed gap list in `docs/CAPABILITIES.md` ran on
2026-08-28: 214 steps -> 260. Light keyframes closed the gap that shipped
with `add_light`, and a coverage rig gave `add_control`, `add_keyframe`,
`remove_keyframes`, `set_layer_3d`, `apply_expression_preset`,
`list_properties`, `list_effects`, `set_comp_setting`, `duplicate_comp`,
`rename_item` and `move_to_folder` their first real-AE steps.

FOUR tools are still uncovered and each is deliberate, not pending:

- ~~`add_marker`, `precompose`~~ COVERED 2026-08-28 (0.9.30) by item
  5.4 — 18 steps, after a probe found five silent losses in them.
- ~~`add_to_render_queue`~~ COVERED 2026-08-28 by item 5.5 (14 steps).
- ~~`import_file`~~ COVERED 2026-08-29 by item 5.8 — it only ever needed
  a file on disk, and `snapshot_frame` is that file.
- ~~`organize_project` — **cannot be suite-tested at all.**~~ COVERED
  2026-08-28 (0.10.2) once it grew the `dryRun` argument this bullet
  asked for: six steps, PREVIEWS only. The preview must count the suite's
  own new comp, name the nested folder it refuses to file into, and leave
  the project panel byte-for-byte alone — that last step is the one the
  group exists for.

As of 2026-08-30 the computed gap list reads **"Host tools never
exercised by the self-test suite: none"** — every host tool has now been
run against real After Effects.

~~**NEW, measured 2026-08-30, and its own small pass: the suite LEAKS 34
project items every run, into whatever project the user has open.**~~
DONE 2026-08-30 (0.10.12), exactly as specified: the run now photographs
the project by ITEM ID before it creates anything, and the cleanup sweeps
the footage that photograph does not contain — plus the `ST ` namespace
as before, which still reaches an earlier run's leftovers. Measured in
the field: 364 items before, 364 after, item for item, twice; and the
357 `Null <n>` / `Audio Amplitude` orphans the earlier passes had already
left were untouched, which is the real-AE proof of the half that matters
more (a user's own "Null 1" must survive). The assertion that let this
run for eleven versions is fixed too — "nothing named `ST ` remains" was
TRUE on every leaking run, so the step now counts against the baseline as
well. Harness 531 -> 532. Original text: Counted before and after one
harness run: 313 -> 347, all of it `Null`
(162 -> 180) and `Audio Amplitude` (144 -> 160) FOOTAGE sources. The
suite's cleanup sweeps the `ST ` namespace and these are named by AE, not
by the suite — `audio_to_keyframes` never uniques its null's name
(measured 2026-08-28) and a null layer's SOURCE outlives the comp that
held it. Same class of leak the `ST ` sweep was built for, arriving from
outside the prefix. It reaches real users: pressing Settings -> "Run
self-test" leaves ~34 orphan sources behind each time. Fix at the
cleanup, by ID and scoped to what the run itself created — never by name
alone, because "Null" is a name a user's own project will hold.

## 4. Field-quality passes

- Run the panel like a user: `node scripts/chat-probe.js` drives the
  whole product path headless (real settings -> real llama-server ->
  real tools.js -> real AE) through an 8-step checklist and writes a
  transcript to `logs/`. DONE 2026-08-21 (7/8, one real bug fixed).
  Re-run it after any change to tools.js, the system prompt, or a
  batch tool — it is the only thing that tests the MODEL's half.
  Open follow-ups it filed, each its own pass:
  - ~~`stagger_layers` `spread` is a TOTAL, but users say "4 frames
    apart"~~ DONE 2026-08-21: the tool takes `step` (seconds) and
    `stepFrames`, refuses spread+step together, and flags a spread
    that works out to under a frame per layer. Probe re-run: the model
    now sends `stepFrames: 4`.
  - ~~`add_text_layer` inherits AE's last-used character panel style~~
    DONE 2026-08-21: it does normalize. A new layer starts from a
    documented baseline (white, 72px, tracking 0, auto leading, left,
    no faux/stroke, a verified-installed plain sans) and the caller's
    args override it; `inheritStyle: true` keeps AE's Character panel.
    `set_text_style` still never normalizes — it edits a layer the
    user owns. AE 2026 makes allCaps/smallCaps/superscript/subscript
    READ-ONLY, so an inherited one is reported instead of swallowed.
  - ~~the checklist never touches ComfyUI, undo across a mixed round, or
    a second chat turn that refers back ("make them blue instead").~~
    DONE. The undo and second-turn halves landed 2026-08-25 as steps
    9-11; the ComfyUI half landed 2026-08-28 (0.9.28) as steps 12-13 —
    "is the picture generator ready" and a real generation through the
    model into AE, judged on ctx.tools (a panel-side tool leaves nothing
    in the comp to read back). It found three defects on its first run,
    all fixed at the root: the probe never loaded comfy.js/setup.js at
    all, a dead comfyUrl told the user to install a backend they already
    had running on another port, and the shipped `example-txt2img`
    placeholder was offered to the model as a real workflow. See the log.
  - a round that fails PART WAY leaves its debris behind: when
    `duplicate_layer` errored before `add_solid` had a layer to copy,
    the model retried the whole round and the comp ended with TEN red
    squares, nine spread and one orphan parked at the centre. The tools
    each behaved correctly (grounded error, successful retry); what is
    missing is any notion of rolling a failed round back.
- ~~Undo hygiene: one Ctrl+Z per chat command~~ DONE 2026-08-21 via
  AELL_callBatch.
- ~~ROLLBACK for a round that fails part way~~ DONE 2026-08-25 (0.9.14).
  A round where one mutating command failed and another succeeded is
  undone whole, so the model's retry starts from the real state: the
  nine-squares sentence now yields nine, not ten. One Undo, issued
  inside the same AELL_callBatch execution that made the changes (AE
  blocks its UI throughout, so nothing of the user's can be on top of
  the undo stack), armed only when a net-zero sentinel proves the group
  is not empty, and verified by a before/after fingerprint — a mismatch
  gets ONE Redo and an honest "not rolled back", never a second Undo.
  Budget: one rollback per user request. A failing READ-ONLY tool does
  not trigger it. Four AE measurements gated the design; they and the
  answer to "what if it overshoots" are in WORKPLAN-LOG 2026-08-25.
  - ~~Rollback's reach over PROJECT ITEMS is unmeasured~~ MEASURED
    2026-08-29 (0.10.7). It reaches: comp creation, duplication,
    deletion, folder moves and renames all revert on the one Undo, and
    the shipped AELL_callBatch path was driven through each. The real
    finding was AELL_fingerprint - the check that proves the Undo landed
    where it started, and the only guard against it overshooting into
    the user's own last edit. Of 25 dimensions a mutating tool can
    write, AE reverted all 25 and the fingerprint saw 4; the blind 21
    (every comp setting, every layer switch, markers, the 3D-only
    rotations, a solid SOURCE's colour, a text layer's style) are
    recorded now. Harness 482 -> 490. Two limits stated in the log and
    left open on purpose: arbitrary property values beyond the transform
    basics, and folders that share a name.
  - ~~Whether `.parent =` compensation survives a child that is 3D under
    a 2D parent, or a parent with a keyframed transform~~ MEASURED
    2026-08-29 (0.10.8). Mixed dimensions survive: a 2D parent leaves a
    3D child's Z alone and a 3D parent's Z never reaches a 2D child (the
    compensation is a pure X/Y translation, measured). An ANIMATED
    parent does not - AE works the compensation out ONCE, at the
    playhead, so "nothing moved" is true at exactly one frame and the
    layer is 400 px away two seconds later; a keyframed child's MOTION
    changes, not just its numbers; and an expression-driven parent does
    it with ZERO keyframes. set_layer_parent now reports
    `parentAnimated` and `compensatedAt`, and takes `atTime`/`atFrame`
    to pin the frame that must not move. Harness 490 -> 498.
- ~~Performance: 200-layer comps — measure grid_layout and batch
  keyframe wall time~~ DONE 2026-08-28 (0.9.29). The batch-keyframe half
  is measured and fine: at 200 layers set_keyframes (600 keys) 167 ms,
  apply_keyframe_ease 291 ms, remove_keyframes 517 ms, grid_layout
  872 ms, stagger_layers 53 ms, distribute_property 69 ms, scale_comp
  352 ms, for_each_layer apply_effect 313 ms. Nothing near the ~5s flag,
  as in 2026-08-21. What the same probe found is the follow-up this
  bullet had been carrying since then, and it is now fixed: **eleven
  tools serialize past the panel's per-result cap and every one of them
  reached the model as JSON cut mid-object.** compactToolResults now
  drops WHOLE ROWS with a count, the way budgetState already did for the
  state block, and the per-result cap is a fair share of the round's
  6000 rather than a fixed 1200. See the log.
- ~~**organize_project gets clean_project's dry-run shape**~~ DONE
  2026-08-28 (0.10.2). Built to the spec: `dryRun` defaults to true, the
  preview names each move (item -> folder) with capped lists and full
  counts, execute reports moved/notMoved after checking where each item
  actually landed, and six suite steps cover the PREVIEW (an execute step
  would file the user's own project). The probe that opened the pass
  found a shipped bug the spec could not have known: the destination
  folder was looked up by name ANYWHERE in the tree, so two root comps
  were filed into a user's nested `PR Archive/Comps`. Destinations are
  now root-only and a nested homonym is named in the result instead.

- ~~**Harness dialog triage learns to READ before it answers**~~ DONE
  2026-08-28. Built to the spec, with the one line the spec implied and
  this pass had to make explicit: the harvest is EVIDENCE and is
  deliberately NOT fed to `Get-AellDialogVerdict`. That verdict is what
  gates the pre-launch answer, and it fires on `unreadable` — so making
  the save-changes prompt readable would have flipped it to `blocked`
  and stopped the harness answering the one dialog the mechanism exists
  for. Same answer set as before, now with the words and a picture.
  Measured: the text lives in an `Edit` child whose `GetWindowTextW` is
  empty and whose `WM_GETTEXT` is the whole sentence, in CURLY quotes;
  AE draws its dialog frame offset from the rect Win32 reports, so the
  screenshot is of the whole virtual screen and the dialog is moved to
  the corner and raised first. Verified in real AE on all three paths
  (a deliberate addComp error alert → UNRECOGNIZED + readable PNG, the
  save prompt → named, no PNG, no marker, and two clean back-to-back
  runs), 391/391 each time. No version bump: the panel ships
  `extension/` alone. Original spec:
  before CloseWordlessDialogs answers a `#32770`,
  (1) collect WM_GETTEXT from every child control and log it;
  (2) if that yields nothing, move the window on-screen and save a
  screenshot to `logs\dialogs\<timestamp>.png` (measured readable on
  2026-08-28);
  (3) auto-answer as today either way — unattended must proceed — but
  when the harvested text matches nothing known-benign (the
  save-changes prompt, empty), mark the pass log UNRECOGNIZED DIALOG
  with the PNG path so the morning review sees it. Never a new refusal
  path: the change is evidence, not behaviour.

- **NEW, filed by the ComfyUI probe steps 2026-08-28, each its own small
  pass:**
  - ~~**A generation that fails does not get retried.**~~ ALREADY FIXED,
    and the evidence is in the entry that filed it: 0.9.28's own field
    run has the model invent `simple_image`, take the grounded
    "Available: AE_LLAMA_H3_I2V_V1, AE_LLAMA_KREA2_V1" error, re-plan
    onto KREA2 and render. A rejected workflow is no longer a rejected
    request, so no prompt rule is needed. Struck 2026-08-28 without
    spending a pass on it. Original text: ComfyUI rejected the workflow
    the model chose; the model had four rounds left, said "let's try a
    different approach or workflow", and stopped.
  - ~~**A bundled workflow template never reaches an existing install
    once it has been seeded.**~~ DONE 2026-08-28 (0.10.1). Built to the
    spec below, with one thing the spec could not have known: hashes are
    taken over CRLF-NORMALIZED bytes. Git checks these templates out with
    the platform's line endings, so on this machine the installed H3
    template and the bundled one differed in raw bytes and in nothing
    else - a raw-byte hash would have called an identical file a user
    edit. Verified in the field: seeding against the real
    %APPDATA%\AE-Llama refreshed the one genuinely stale file (the H3
    i2v manifest, five releases behind), reported the other five as
    current, overwrote nothing, and the second run was a no-op. Also
    measured: `git log -- path` lists one commit for the H3 template
    where `--all --full-history` lists three, so the seeder walks the
    full history. Original spec:
    (1) `scripts/workflow-hash-history.js` maintains
    `extension/comfy-workflows/.hash-history.json`: for every bundled
    template/manifest, an APPEND-ONLY list of the sha1 of every version
    ever shipped. Run mode appends the current files' hashes if new;
    `--check` mode fails when a bundled file's current hash is missing
    (CI-enforce it next to capability-report). Seed the history by
    hashing every version of each file in `git log` so EXISTING stale
    installs are covered.
    (2) `ensureDataDirs` seeding rule per file: absent -> copy. Present
    and its hash appears in the history -> it is an UNEDITED shipped
    copy (possibly stale) -> overwrite with the current bundle. Present
    and hash unknown -> the USER edited it -> never touch it.
    (3) Stub tests: fresh seed, stale-unedited overwrite, user-edited
    preserved, history --check catches an unrecorded bundle change.
    No version bump gate: bump patch once verified (it fixes shipped
    behaviour — this machine still lacks templates shipped 5 versions
    ago).
- ~~**`get-llama.ps1`'s two latent traps**~~ DONE 2026-08-30 (0.10.16),
  and the pass found the traps were not confined to a dev script: the
  SHIPPED panel had one of them and a worse one beside it. Measured
  through `extension/js/setup.js`'s own code with
  `scripts/engine-asset-probe.js`: (1) llama.cpp's `/releases/latest` is
  `v0.3.0`, whose entire asset list is one `nightly-tag.txt`, and every
  release carrying Windows binaries is a `bNNNNN` PRERELEASE that
  `/releases/latest` never returns - so **the panel's one-click engine
  install ended at "No suitable Windows build found in release v0.3.0"
  for every user**, and `get-llama.ps1` threw the same way (run and seen);
  (2) this machine's nvidia-smi says `CUDA UMD Version: 13.4`, which the
  `/CUDA Version:/` regex misses, so `cudaVersion` was null and the
  chooser took its conservative "oldest published line" branch - CUDA
  12.4 (250 MB) on a driver that runs the 13.3 build (146 MB). Both fixed
  at the root: a release WALK (the one the whisper and ffmpeg acquirers
  already do) and the widened banner regex. `get-llama.ps1` now
  dot-sources the shared helpers instead of carrying its own broken
  copies, and gained `-ListOnly` so the whole choice can be verified
  without a 500 MB download. 36 checks in `tests/test-engine-assets.js`.

- ~~**`set_layer_3d` loses the Z in silence.**~~ DONE 2026-08-28 (0.9.25).
  A second probe measured the FULL loss (Scale Z resets to 100 rather
  than zeroing, Orientation and X/Y Rotation clear, keyframe values are
  flattened in place, and turning 3D back on restores nothing), and the
  tool now reads those values before the write and returns them in
  `discarded`. It still does not refuse and does not restore. Three suite
  steps and the stubbed tests cover it, including the ordering trap real
  AE caught: keyframes are read BEFORE an expression, or a wiggled
  Position reports its own noise instead of the Z on the next key.
  Original text below.

- **`set_layer_3d` loses the Z in silence.** Measured 2026-08-28: turning
  a 3D layer back to 2D zeroes the Z component of Position and Anchor
  Point (and the 3D-only rotations go with it), and the tool reports a
  plain `{threeD: false}`. A suite step pins the loss. This project's
  rule is that nothing disappears quietly, so the tool should report what
  the switch discarded — the same shape as `scale_comp`'s
  `layersSkipped`. Small: read the 3D-only values before the write,
  compare, and name the non-zero ones in the result. Do NOT refuse and do
  NOT restore them — the user asked for 2D.

## 5. Feature track — probe, build, lock in (NO version bumps here)

New capabilities, queued AFTER items 1–4. Rules for every 5.x/6.x item,
learned the hard way:

- **Three passes max per feature, one per loop pass.** (a) PROBE: temp
  .jsx against real AE, write the verified facts (exact matchNames,
  return shapes, what throws) to WORKPLAN-LOG.md. Every API name below
  is from training and UNVERIFIED — the probe is the point. (b) BUILD:
  the tool(s) in hostscript.jsx + docs in tools.js (undocumented tools
  are unreachable by the model) + a stubbed test whose stub encodes what
  the probe measured. (c) LOCK IN: positive-path selftest.js steps, with
  cleanup, in their own scratch comp where side effects are possible.
- **NO version bump on feature passes.** Patch bumps are for fixes to
  shipped behavior. New tools ride the next MINOR (0.10.0), which the
  remote session cuts after reviewing the batch. Push without bumping —
  the feed publishing an equal version is correct here.
- If a pass ends with AE stuck on a modal (harness exit 4), dismiss it
  with the Win32 method already documented in the log, record exactly
  what raised it, and log the pass. Never leave AE blocked for the next
  pass.
- A probe that DISPROVES the sketch below is a success: log it, adjust
  or strike the item, stop the pass.
- BEFORE building any tool, check docs/CAPABILITIES.md — 5.4 nearly
  built three duplicates of tools that already existed. After a BUILD
  pass, `node scripts/capability-report.js` regenerates the inventory
  (tests/test-capability-doc.js fails CI if you forget). Its computed
  coverage-gap lists are also the ready-made queue for item 3.

### 5.1 Text animators — DONE 2026-08-28
Probed, built and covered in one pass. `add_text_animator` adds the
animator, activates every property named and configures the selector
(range/wiggly/expression/none), then reports the exact paths so the
EXISTING set_keyframes drives the selector — measured first, which is why
no keyframing was built into the tool. Eight AE facts made the design,
all in the log: an animator ships with all 103 properties present and
HIDDEN (addProperty un-hides), `canSetExpression` is the only flag that
tells added from dormant, adding a sibling animator invalidates every
reference into the earlier ones, AE lets two animators share a name and
answers a lookup with the first, percent selectors run -100..100, both
the percent and index triples exist at once and a name lookup always
finds percent, per-character 3D is a LAYER switch that drags threeDLayer
on and never gives it back, and "ADBE Text Rotation" IS the Z rotation.
The dormant-slot discovery also fixed shipped behavior: set_property /
set_keyframes / get_property / list_properties no longer leak AE's raw
"property or a parent property is hidden" for the hundred slots the
0.9.27 deep search can reach. 63 stub checks, 24 suite steps, harness
307 -> 331. Macros ("typewriter"/"cascade") stay PROMPT recipes as
planned; no version bump (feature track).

Original text: Probe: the property tree under "ADBE Text Animators" — add
an animator, an "ADBE Text Selectors" range selector, and animator
properties (position/opacity/rotation/scale at least); verify
Start/End/Offset percent paths and per-character-3D requirements. Build:
`add_text_animator` (generic, grounded errors listing available animator
properties) — macros like "typewriter"/"cascade" belong in the PROMPT as
recipes, not as separate tools. Highest value per line of code here.

### 5.2 Shape repeaters — DONE 2026-08-28 (0.9.31)
No `add_repeater` was built: `add_shape_content {kind: "repeater"}` had
shipped all along and the probe proved it works end to end. What did not
work was reaching it. A shape GROUP hides its items in a nested
"Contents" group AE's timeline never draws, so
`contents/<Group>/<Item>/<Param>` — the path this panel's own tool notes,
tool docs and system-prompt trim-paths recipe all handed the model —
resolved to nothing, and every "animate the repeater / wipe it on"
request failed on the panel's own instructions. The resolver now hops
that segment (a real child of the same name still wins), and
add_shape_content warns when a filter lands with no shape ABOVE it —
measured: a repeater appended after the rect renders 500px wide, the same
one moved to index 1 renders 100px. Copies floors at 0 with no max,
Composite is `ADBE Vector Repeater Order` 1..2. Ring/burst stays a PROMPT
recipe. Harness 331 -> 345. Original text below.

Probe: "ADBE Vector Filter - Repeater" under a shape group — copies,
offset, and the repeater transform block. Build: `add_repeater` {layer,
copies, position/rotation/scale/anchor offsets}. Verify the radial-burst
recipe (rotation 360/copies) renders as expected.

### 5.3 Animation preset library - DONE 2026-08-28
Probed, built and covered in one pass. `list_presets` indexes AE's 679
shipped .ffx files plus the user's own (679 walked in 117 ms, cached per
session); `apply_preset` applies one to layer(s). The probe answered the
item's own question with a worse fact than it expected: **applyPreset
acts on the comp's SELECTION, not on the layer it is called on** - two
layers selected, one call, BOTH changed - and with an EMPTY selection it
does not touch the receiver either, it invents a comp-sized solid and
applies the preset there. So the tool selects exactly its target and puts
the user's selection back. Six more measured facts made the design and
are in the log; the one that cost a suite iteration is that "a preset for
the wrong layer type does nothing" is only HALF true: a Text preset that
carries expression controls installs its six sliders on a solid and none
of the animation (census 2 vs 15 on a text layer), while one that carries
none does nothing at all. That partial landing is now reported. 63 stub
checks in `tests/test-presets.js`, 13 suite steps, harness 345 -> 358. No
version bump (feature track). Original text below.

### 5.3 Animation preset library
Probe: `layer.applyPreset(File)` on a stock .ffx — does it need the
layer selected, what does it do to selection (AELL_keepSelection?), and
enumerate what ships: Support Files\Presets\**\*.ffx + the user's
Documents\Adobe\After Effects*\User Presets. Build: `list_presets`
(cached, filterable) + `apply_preset` with the font-style grounded error
(near-matches by name). Hundreds of behaviors for the price of two tools.

### 5.4 Precompose + markers — DONE 2026-08-28 (0.9.30)
Probed, fixed and covered. Five silent losses were measured and are now
reported instead: precompose counted a REPEATED layer reference twice,
dropped a moved layer's parent when the parent stayed behind, left an
expression on a layer behind it pointing at a layer that is no longer
there (AE rewrites those only when moveAttributes is FALSE, and
expressionError stays EMPTY either way), let a SECOND project item take
the requested name — which makes the later one unreachable by name — and
threw away the user's selection. add_marker silently REPLACED any marker
already at that time, refused a quoted `time` the project's own rule says
to accept, and swallowed an unusable `duration`. Marker times turned out
to be COMPOSITION time on a layer as well, so nothing had to be
converted. 56 stub checks in `tests/test-precompose-markers.js`, 18 suite
steps, harness 289 -> 307. See the log. Original text below.

docs/CAPABILITIES.md's computed gaps caught this item about to build
duplicates: `precompose` and `add_marker` are in TOOL_DEFS today, with
zero stub tests and zero suite steps. So this item is (a) probe their
real behavior (precompose selection side effects, marker duration
handling), (b) fix what's wrong, (c) stub test + suite steps. Do NOT
build new tools here.

### 5.5 Render queue — DONE 2026-08-28
Probed, built and covered in one pass. `render_comp` renders a comp to a
file and waits; `list_render_templates` names this machine's templates
(and hands back a real writable folder, because "where do I put it" was
otherwise a guess). `add_to_render_queue` was fixed rather than
duplicated.

**The aerender question is settled: renderQueue.render() DOES work
headless from a `-r` session** — one frame in 181 ms, status DONE. So
aerender.exe is not used, and it would be the wrong tool anyway: it
launches a second AE against a SAVED .aep, while this panel drives a
live, usually-unsaved project.

Seven probes; three findings drove the whole design. (1) `render()`
renders the WHOLE QUEUE, not the item you added — so the user's queued
items are held back with `render = false` and put back. (2) An output
path that ALREADY EXISTS raises a MODAL, which wedged AE mid-probe and
then swallowed every later -r script while the process still looked
healthy; it is refused unless `{overwrite: true}`, and only then
rendered under `beginSuppressDialogs` (measured to genuinely overwrite,
64840 -> 698880 bytes, not silently skip). (3) The output module forces
its OWN extension on the `file` SETTER, both directions, so the path
reported is the one AE settled on. Also: a missing output directory
THROWS rather than prompting, `status` is readOnly, deleting a queued
comp silently drops its queue item (no dialog), and a fresh output
module inherits the LAST RENDER'S folder — which on the probe machine
was a ComfyUI directory unrelated to the project, so an outputPath-less
add now says where the bytes would land.

For 5.8: **`comp.saveFrameToPng(time, File)` EXISTS and works** — 407
bytes for 160x120, honours resolutionFactor, no viewer needed, comp.time
untouched, overwrites with no dialog. Its three silent failures are
measured and waiting to be handled: a bad folder is a SILENT no-op, an
out-of-range time CLAMPS and writes a blank frame, and a String path
throws (it demands a File). It also writes LAZILY — `File.exists` reads
false for ~300 ms afterwards, so output must be polled, not glanced at.

**AE cannot render inside an undo group.** Registering render_comp as
mutating earned a modal "Undo group mismatch" that wedges an unattended
AE, so it is exempt via the new `AELL_NO_UNDO_GROUP`, and a batch
containing one opens no group at all (closing and reopening the group
around just the render was tried first; AE rejects that too).

82 stub checks in `tests/test-render-queue.js`, 14 suite steps, harness
358 -> 372, green on three CONSECUTIVE runs. No version bump (feature
track). Original text below.

`add_to_render_queue` ALREADY EXISTS (uncovered — same trap as 5.4).
Probe what it does today, then extend rather than duplicate: actually
RENDERING headless — renderQueue.render() from a -r session vs the
aerender.exe alternative (decide which is stable unattended, log why),
output-module templates (enumerate + log; version-sensitive), grounded
template errors. Also probe single-frame paths here: saveFrameToPng if
it exists, else a one-frame render — needed by 5.8.

### 5.6 Project hygiene — DONE 2026-08-28
Probed, built and covered in one pass. `clean_project {action, keepComps,
dryRun}` runs exactly one of AE's three cleanup calls, previewing by
default. Five probes; the facts that shaped it are all losses AE does not
mention: `removeUnusedFootage()` also deletes EMPTY FOLDERS (recursively,
and it counts them in its return value), `reduceProject()` deletes a comp
that only an EXPRESSION names and leaves `expressionError` EMPTY, it
silently drops the render-queue items of the comps it removes, and it
ACCEPTS a footage item in the keep array and then deletes every comp in
the project (refused here). Also measured: footage used only by an UNUSED
comp is kept, `reduceProject([])` throws "Array is empty", and — unlike a
render — all three are ordinary edits that close an undo group cleanly
and are undone whole by one Ctrl+Z. So the preview NAMES what would go
and the execute path diffs AE's actual removals against that promise (the
two agreed exactly on every rig, in real AE and in the stub). 48 stub
checks in `tests/test-project-hygiene.js`, 13 suite steps, harness
372 -> 385. The suite covers PREVIEWS and REFUSALS only: every action is
project-wide, so executing one inside the user's open project would
delete the user's own items. No version bump (feature track).

Original text: Probe: removeUnusedFootage(), consolidateFootage(),
reduceProject() return values. Build: `clean_project` {action} —
reduceProject DELETES, so it requires an explicit comp argument and
reports counts; everything in one undo group. Refuse vague asks with a
grounded list of actions.

### 5.7 Audio to keyframes — DONE 2026-08-28
Probed, built and covered in one pass. The id exists (4218, and ONLY for
the exact string "Convert Audio to Keyframes"), but the sketch's `{layer}`
was disproven: the command ignores the selection and converts the whole
comp MIX of whatever comp is ACTIVE. Per-layer isolation is built on the
next measurement instead — a muted layer contributes an all-zero curve —
so `audio_to_keyframes {comp?, layer?, name?, range?}` mutes the other
audible layers for the conversion and un-mutes them again. Four more
measurements shaped it: the command is bounded by the WORK AREA (0.5..1.5
on a 4s/24fps comp gave 25 keys, not 97), it never uniques the null's
name (two runs, two layers called "Audio Amplitude"), it leaves nothing
selected, and with no audio-capable layer it creates nothing and says
nothing at all — no throw, no dialog — which is why the tool refuses
first and lists what IS in the comp. Suite coverage needed no audio file:
Tone on a solid flips `layer.hasAudio` to true and the converter hears it
(73 keys, peak 34.33 on 3s/24fps; two tones 36.02, which is what the
isolate/un-mute steps read). 66 stub checks, 13 suite steps, harness
391 -> 404. No version bump (feature track).

Original text: Probe: `app.findMenuCommandId("Convert Audio to
Keyframes")` — does the id exist, what selection/active-comp state it
needs, exact name of the created null and its slider paths. Build:
`audio_to_keyframes` {layer} returning the null + slider path ready for
link_property. Grounded error lists audio-capable layers. This plus
link_property = beat-driven anything.

### 5.8 Frame round-trip — DONE 2026-08-29
Probed, built and covered in one pass. `snapshot_frame {comp?, time?,
path, resolution?, overwrite?}` and `import_as_layer {path, comp?, fit?,
name?, position?}` are both almost entirely made of what AE does
SILENTLY, all measured: a missing folder is a no-op with no error, an
out-of-range time CLAMPS and writes a blank frame, an existing file is
replaced with no dialog and no undo, a comp at Half resolution writes a
half-size frame, PNG bytes go into whatever name is handed over (a
frame saved as .jpg is a PNG called .jpg), and a path the project
already holds is imported a SECOND time without a word. Two findings
shaped the design rather than a report: AE's "Fit to Comp" menu commands
do NOTHING with no comp viewer open, so the fit arithmetic is the
panel's own — reproducing their numbers exactly, pixel-aspect correction
on X included (320x240 par-1 into 720x480 par-1.2121 = 272.727 x 200,
not 225 x 200) — and `saveFrameToPng` is SAFE inside an undo group
(measured across three nested groups plus three more cycles), unlike
`renderQueue.render()`, so snapshot_frame is in `AELL_NO_UNDO_GROUP`
only to keep an un-undoable file write from arming a rollback. Reported
dimensions are read back out of the PNG's own header. `import_file`
finally got suite coverage too — it only ever needed a file on disk —
which closes the last "never exercised in real AE" gap. 100 stub checks
in `tests/test-frame-roundtrip.js`, 17 suite steps, harness 404 -> 421.
No version bump (feature track). Original text below.

Build on 5.5's probe: `snapshot_frame` {comp, time, path} writes a PNG
of the comp at a time; `import_as_layer` {path, comp, fit} imports a
file and places it as a layer scaled fit/fill/center to the comp. Verify
the full loop: snapshot -> import -> pixel dimensions match the comp.
Generation wiring stays remote — this is the comp<->file bridge it will
stand on.

### 5.9 .mogrt export — DONE 2026-08-30 (probe, build AND lock-in)
`expose_property` and `export_mogrt` are built, documented and covered by
95 stub checks in `tests/test-mogrt.js`, and driven end to end in real AE:
a comp with three controllers went out as a genuine ZIP (`PK\x03\x04`,
11 822 b) in 3.6 s. The export DOES run headless, with four conditions —
project SAVED and CLEAN, a FOLDER path, a legal template name, and
`beginSuppressDialogs()`.

The item's own **LAST-item-of-the-night rule is struck**: it deferred the
item 22 times, and the machinery it was written against (the harness's
dialog triage, 2026-08-28) did not exist when it was written.

Two things the pass found that no probe had: **a successful export
invalidates the held `app.project` reference as well as the CompItem**,
which made a tool that had already written the file report "Object is
invalid"; and AE writes the template name **verbatim** — the 2026-08-29
probe's "AE strips the spaces" was that probe reading back a name that
never had spaces in it, compounded by `File.name` being URI-ENCODED.

~~**LOCK-IN (pass c) is what is LEFT, and it is not free:**~~ DONE
2026-08-30, and the capture found **five** windows where this text
predicted three. `Save Project` (raised by any tool that saves, not just
this one) and `Open Project` (raised by the EXPORT — After Effects
reopens the project while writing a template, which is the visible half
of "a successful export invalidates app.project") stand beside the three
named below, and every one of them read as `blocked` — three of those in
a row on a 2 s poll is exit 4 on a healthy run, so a SAVE alone was
enough to trip it. The triage now has a `progress` verdict with a 30 s
clock on it, because the font ALERT is a question the probe layer cannot
tell from the progress window of the same name (the evidence layer can,
and does). 14 suite steps: `expose_property` end to end and
`export_mogrt`'s whole refusal wall. **The export itself cannot be a
suite step** — AE exports only from a saved, CLEAN project and the suite
has created a dozen comps in the user's own project by then — so it is
covered the way `clean_project` and `organize_project` are: verified by
hand in real AE, with the suite holding the wall. Harness 517 -> 531,
green twice. Original text: the export
raises three progress dialogs that are not errors — "Creating Motion
Graphics Template", "Exporting Motion Graphics Template", "Verifying
Adobe Fonts...". They are `#32770`s, so the harness triage will see them,
and WM_CLOSE on the font one is CANCEL — which is how a cancelled export
answers `true` and writes nothing. Either the suite stays off the export
path (expose_property alone is safe) or the triage learns those three
titles first. A suite step must also not save the user's project.

Original text: Probe with everything pre-cleaned (project saved, text
using a font verified via isSubstitute===false): set
comp.motionGraphicsTemplateName, property.canAddToMotionGraphicsTemplate,
addToMotionGraphicsTemplateAs, then
exportAsMotionGraphicsTemplate(true, path). Log which steps raise
dialogs and whether they are dismissable. Build ONLY if the probe shows
a clean headless path: `expose_property` {layer, property, label} +
`export_mogrt` {comp, path}. If it cannot run headless, log that and
leave it panel-interactive-only for the remote session to design.

## 6. Binary track (multi-night; same lifecycle pattern as llama-server)

### 6.1 Local captions via whisper.cpp
~~Pass A: acquire~~ DONE 2026-08-29. `scripts/get-whisper.ps1` +
`scripts/lib/whisper-assets.ps1` (the choice, testable without a
network) + `tests/test-whisper-acquire.js`. Acquires into
`vendor\whisper.cpp\{bin,models}` — split so a binary update does not
re-download the 141 MB model — and verifies by synthesizing a WAV and
transcribing it: measured 818 ms for a 3 s clip, base.en, CPU. Facts the
probe paid for, all now pinned by tests: the newest tag can be an
asset-less prerelease; the archive nests under `Release\` and `main.exe`
is a deprecation shim (`whisper-cli.exe` is the transcriber); the models
are on HuggingFace under `ggerganov`, not `ggml-org` (which answers 401);
`Invoke-RestMethod` hands a JSON array back as ONE object, so `@()`
around it pools every release's assets together; and this machine's
nvidia-smi says "CUDA **UMD** Version", which the usual regex misses.
~~Pass B: verification harness~~ DONE 2026-08-29.
`scripts/lib/whisper-verify.ps1` (the round-trip, one implementation for
the acquirer, the standalone runner and the test),
`scripts/verify-whisper.ps1` (SKIP + exit 0 with no install, `-Require`
to make that a failure) and `tests/test-whisper-verify.js`, which runs
49 of its 52 checks with NO install present (verified by pointing
APPDATA at an empty folder). Field
facts this paid for: 2 s of SILENCE transcribes as " You", so "a
transcript came back" is not a check at all; whisper-cli writes nothing
to stdout on failure and ~6 KB to stderr, so draining stdout before
waiting on the process deadlocks (measured: a five-minute hang);
base.en writes numbers as DIGITS and the synthesizer's "pack" comes back
as "hack", so a verification phrase is a fixture that has to be
measured; and 44.1 kHz audio transcribes fine - the old "whisper refuses
anything but 16 kHz" note was wrong, which matters for Pass C's comp
audio.
~~Pass C: AE wiring~~ DONE 2026-08-29. Three tools, split so the two
ends can be tested where the middle cannot: `render_comp_audio` and
`add_captions` are HOST tools the self-test drives in real AE with no
speech model present, and `transcribe_to_captions` is the PANEL tool
that joins them (ExtendScript cannot spawn a child process).
`extension/js/whisper.js` finds the install and parses the segments.
Verified end to end in real AE: a 20 s comp of synthesized speech
rendered in 0.1 s, transcribed in 1053 ms, and became five caption
layers each trimmed to its own span. Field facts this paid for: a comp
with NO audio layer STILL renders a full, valid, audio-only AIFF (DONE,
772 674 bytes, no warning) and silence transcribes as the word "You" —
so the refusal has to come before the render or the feature's failure
mode is a confident wrong answer; `layer.inPoint` is a SLIDE that DRAGS
outPoint and preserves duration (in=2 in a 5 s comp reads back out=7),
so in is always set before out; AE accepts inverted and zero-length
spans in silence; in/out QUANTIZE to AE's own time base (0.3333 ->
0.33329264322917), so every comparison needs a tolerance; whisper.cpp
decodes AE's AIFF directly through miniaudio, so no WAV conversion and
no ffmpeg; and `om.getSettings()` throws while `setSettings({Format})`
answers "Property is read-only", so the audio format comes from the
output-module TEMPLATE, matched by name. 115 stub checks in
`tests/test-captions.js`, 16 suite steps, harness 498 -> 514. No version
bump (feature track).

### 6.2 ffmpeg post-renders
~~Pass A: acquire a static ffmpeg build the same way; verify with
ffprobe.~~ DONE 2026-08-30. `scripts/get-ffmpeg.ps1` +
`scripts/lib/ffmpeg-assets.ps1` (the choice, testable without a network)
+ `scripts/lib/ffmpeg-verify.ps1` (the round trip) +
`scripts/verify-ffmpeg.ps1` (SKIP + exit 0 with no install, `-Require`
to make that a failure) + `tests/test-ffmpeg-acquire.js` (55 checks).
Source is BtbN/FFmpeg-Builds; installs to `vendor\ffmpeg\bin`; verified
in the field at n9.0.1-11-ge47273f4d9. `Expand-AellReleaseList` moved to
the new `scripts/lib/gh-releases.ps1`, shared with get-whisper.

Field facts this paid for, all in the log: **ffmpeg exits 0 when it
refuses to overwrite an existing output**, writing nothing at all (real
errors return -22/-2, which is what makes the 0 believable) — so an
exporter that trusts the exit code hands the user last week's render;
without `-nostdin` that same case is an interactive prompt and it HANGS
FOREVER; `ffmpeg -t 0` writes a 262-byte MP4 with ZERO streams that
ffprobe then accepts with exit 0, valid JSON, empty stderr and
probe_score 100, so the only real check is reading width/height/frame
count back; matroska containers (.webm, .mkv) report NEITHER `nb_frames`
NOR `duration` on the stream, which made the first checker reject a good
VP9 file; the asset names are TWO schemes, not one, and matching
`-latest-` literally disables the dated-release fallback while every
positive test still passes; and `-encoders` is a COMPILE-time list —
h264_amf and h264_qsv are named by this build and both fail at encode
time here for want of a device.

**The licence question is settled by measurement, and the answer is
LGPL.** The LGPL build has no libx264/libx265, but it does have
**libopenh264** (software H.264, works: exit 0, real h264, 37 ms) plus
h264_nvenc and h264_mf. So Pass B needs no GPL binary in a commercial
product — default to libopenh264 and treat hardware encoders as an
opt-in that must be tried, not trusted.

~~Pass B: `export_gif` / `export_social` {comp, path, size, fps} =
lossless render via 5.5 piped through ffmpeg, temp files cleaned.~~ DONE
2026-08-30. `extension/js/ffmpeg.js` (the panel's find/plan/build/VERIFY,
mirroring whisper.js) + the two PANEL tools in `tools.js` +
`tests/test-ffmpeg-export.js` (122 checks, no binary and no AE — the
child process is scripted with captured field output). Verified end to
end in real AE: a 3 s 1080p30 comp exported to a 480x270 GIF and to
1080x1920 H.264 in ~2.8 s each, master cleaned every time.

Field facts this paid for, all in the log: AE's "Lossless" module writes
**rawvideo/bgr24 AVI that ffmpeg reads natively** — and it costs
width*height*3 PER FRAME (6 224 440 B/f at 1080p, 1.87 GB for ten
seconds), so the master is estimated and REFUSED before the render
rather than discovered when the disk fills; that same AVI **carries the
comp's audio** as pcm_s16le, so one intermediate serves both streams;
**a trimmed WORK AREA silently shortens the render** (a 3 s comp trimmed
to its middle second renders ONE second and reports DONE), which is now
reported rather than discovered; the bottom-up-BGR upside-down trap does
NOT apply to AE's AVI (measured, (0,0) stays red — do not add a vflip);
and **h264_nvenc refuses a frame under about 145x49**, so the encoder
trial that Pass A demanded had to run at the export's REAL size — the
first version used a fixed 64x64 and a working NVIDIA card fell through
to h264_mf in silence, caught only because the field run disagreed with
the hardware in the box.

Not built, deliberately: `.webm`/VP9 and animated `.webp`, both refused
by name with the list of what IS written. A GIF/MP4 pair is the ask;
the third format is a remote-session call about whether libvpx's speed
is acceptable.

~~Pass B follow-up: the intermediate is always the FULL comp size, then
scaled by ffmpeg — a `resolution` argument on `render_comp` would make
this much cheaper.~~ DONE 2026-08-30. `render_comp` takes
`{resolution}` and both exporters take `{masterResolution}` (plus
`"auto"`, the largest reduction that still covers the output; a
reduction that would land UNDER the requested size is refused rather
than upscaled). The probe paid for the fact that decides its shape: the
render-queue ITEM answers `getSettings()` where the OUTPUT MODULE
throws (6.1 Pass C measured that throw), Resolution is written by NAME
and nothing else, `getSetting` answers the pair and `getSettings` the
name — and `applyTemplate` RESETS Resolution to Full, so it is set
AFTER both templates or the argument silently does nothing. The
rendered frame is `ceil(dim/factor)` per axis, not floor: 641x361 at
half is 321x181. Measured payoff on a 10 s 1080p comp to 480x270: the
master went 1.74 GB -> 116 MB, the wall clock 6.6 s -> 6.0 s. So it
buys HEADROOM — an export the intermediate cap refused now runs — not
speed. Opt-in on the export side, because nobody has measured AE's own
downsampler against ffmpeg's on real footage. Harness 514 -> 517.

~~Pass B follow-up: **the 8 GB intermediate cap is a guess, not a
measurement.** Nobody has established whether AE's AVI writer survives
past the classic 2 GB / 4 GB RIFF boundaries, or whether ffmpeg reads
what it writes there. Testing it costs a multi-gigabyte render; worth
one deliberate pass rather than a surprise on someone's 30-second 1080p
export.~~ MEASURED 2026-08-30 (0.10.17), and the format is not the risk.
`scripts/riff-boundary-probe.js` rendered real 1080p30 masters of
**5.214 GiB** and **7.995 GiB** — the largest the shipped cap allows —
through the shipped `render_comp`, and both came back DONE with no
warning, at full frame count, decoding end to end under `-xerror` with
an empty stderr. The check that settles it compares AE against ITSELF:
short reference spans re-rendered across frames 343-347, 688-692 and the
final five are byte-identical (framemd5) to those frames inside the
multi-gigabyte file, so no assumption about colour management or what
the picture should look like enters the answer. Nothing wrapped, nothing
was dropped. The cap therefore stays 8 GB as a DISK-AND-TIME guard and
the refusal now says so, because a caller told only "the limit is 8 GB"
shortens an export that never needed shortening. The pass also found the
"3 640 B/frame at 1080p" note in `estimateIntermediate` was an artefact
of the two-frame render it was taken from — the overhead is a fixed
~9.6 KB header, 89 B/frame by 1380 frames. 16 new checks in
`tests/test-ffmpeg-export.js` carry the field bytes. See the log.

## 7. Tier P4 — real-GPU measurement (local; P1–P3 landed 2026-08-25)

The remote half of docs/COMFY_TIERS_PLAN.md is in: tiers.js (T0–T7 +
planHandoff), the VRAM arbiter in tools.js (pause once per round,
verified release via Setup.queryVramUsedMB polling, ComfyUI /free
before the chat model returns, grounded refusal under pause "never"),
comfyPauseLlm tri-state, vramOverrideGB, comfyModelRoots, the combined
recommendSetup line, and COMFY_CATALOG (all PROVISIONAL). Stub suites:
test-tiers, test-vram-arbiter, test-settings-migrate, extended
test-model-catalog / test-comfy-backend. NONE of it has touched a real
GPU. This item is that touch, one pass per bullet, smallest first:

- ~~**Handoff smoke on the 5090, no override**~~ DONE 2026-08-30 (0.10.9),
  and it found that the concurrent path had never been reachable.
  `scripts/handoff-probe.js` drives the real panel path (settings + tiers
  + llama.js + comfy.js + tools.js) against a real llama-server, a real
  ComfyUI and real nvidia-smi, in two rounds. **Every shipped manifest
  carries `file`+`dir` and NO `sizeMB`**, so `genNeedMB` was null for
  every template ever shipped: the arbiter answered "the fit cannot be
  verified" and a 32 GB card paused chat for every generation it could
  have run beside it — while T6/T7's own copy promises "per-job
  arithmetic". The weights are now MEASURED on disk across the panel's
  model roots. Numbers: 7B chat 6002 MB + KREA2 18110 MB on a 32 607 MB
  card -> CONCURRENT, peak **29 064 MB**, 10 s, chat holding the card
  throughout; vramOverrideGB 8 -> handoff, 9736 -> 4004 MB, 14 s, chat
  warmed back up. See WORKPLAN-LOG 2026-08-30.
- ~~**Probe /free support**~~ ANSWERED 2026-08-30. ComfyUI 0.32.0 answers
  **HTTP 200** with an empty body to POST /free {unload_models:true,
  free_memory:true} in ~65 ms. The observed VRAM delta is **0 MB**, and
  that is not a failure: this backend drops a finished generation's
  ~19.5 GB *on its own*, about ten seconds before the round ends, so
  /free routinely has nothing left to release. No fallback build item.
  What it DID cost was a bug — the resume waited for a further drop from
  a baseline sampled after that release, which can never come, so every
  paused round paid a 10 s timeout and said "VRAM did not visibly
  release". Fixed: the resume aims at the absolute floor the pause left.
- ~~**pause "never" refusal in the field**~~ DONE 2026-08-30 (0.10.10),
  and it holds: it is now `chat-probe.js` **step 14**, permanent. Asked
  for a picture on an impersonated 8 GB card with pausing off, the model
  invented a workflow name, took the grounded "Available:" error,
  re-planned onto KREA2, got the refusal and relayed it — "The
  generation requires more VRAM than is currently available. Please
  pause the chat during generation or stop the chat server and try
  again." Two defects paid for the run: the refusal quoted an
  IMPERSONATED card size as if it were real ("the chat model holds
  ~20 GB of the card's 8 GB" — a measured 32B against a fictional
  budget), now annotated "(VRAM override)"; and `.hash-history.json`
  was being listed as a workflow, sorting FIRST, so a generation that
  named no workflow ran the seeder's hash record as a graph. Steps get
  a `settings:` block that patches the cached settings object and
  restores it — never `Settings.set`, which mirrors to the owner's real
  settings.json. See WORKPLAN-LOG 2026-08-30.
- **Measure the catalog** — the SIZE and URL halves are DONE 2026-08-30
  (0.10.11); the VRAM half is still open.
  - ~~whether the fixed sizes in version.js COMFY_CATALOG are honest~~ and
    ~~correct any dead download URL~~ DONE. `scripts/catalog-probe.js`
    HEADs every URL (HuggingFace's redirect carries `x-linked-size`, the
    exact byte count) and cross-checks the copies already on this disk.
    **No URL is dead — all twelve answered.** Every size was wrong: the
    catalog counted in DECIMAL MB while the whole panel counts in MiB
    (nvidia-smi, modelFileMB, planHandoff's `vramGB*1024`), so each file
    was overstated ~5% — and `main.js` divided by 1000 where `setup.js`
    divided by 1024, quoting one file two sizes. Two entry totals also
    disagreed with their own url lists (Wan 2.2 17000 vs 17500, H3 40543
    vs 40503). All measured, unit documented, 12 stub assertions.
  - **The VRAM delta — FIRST ENTRY MEASURED 2026-08-30 (0.10.19), the
    rest still open.** `scripts/catalog-vram-probe.js` is the instrument:
    it runs a catalog entry's SHIPPED template through the panel's own
    `comfy_generate` with `nvidia-smi -lms 250` streaming throughout, and
    it establishes the idle floor by waiting for the card to STOP MOVING
    rather than glancing at it once. `--list` says what this machine can
    measure without touching the GPU.

    **krea2 is done and the catalog was wrong by a factor of two**: 24 160
    MiB measured (two runs, 24 036 / 24 160, 32 s each, at the template's
    authored 3072x1728) against a claimed 12 GB floor. Its three weights
    alone are 18 109 MiB, so no arrangement of offload makes 12 GB hold
    it. `minVramGB` 12 → 24, `measured: true`, and the reading now rides
    IN the entry (`measuredVramMB` / `measuredSeconds` / `measuredAt` /
    `measuredOn`). Ripple, checked: cards under 24 GB now get `sdxl` for
    image instead of a model they cannot hold.

    **minimax-h3 was ATTEMPTED and is blocked — do not re-attempt without
    reading the log entry first.** All four of its weights are on this
    disk and the panel finds them, but the RUNNING ComfyUI cannot load
    any of them: it was launched `--base-directory Documents\ComfyUI` and
    the weights live only in the Comfy-Desktop shared store, which that
    instance does not search and which no `extra_model_paths.yaml`
    declares. See the new item below — that disagreement is a shipped
    defect, not a probe problem.

    Still open, each its own pass: **sd15, sdxl, wan22-5b** need ~26 GB
    downloaded AND a per-model workflow template the panel does not ship
    (`--list` reports exactly this), and **minimax-h3** needs a backend
    that can see its weights. **Both blockers cleared 2026-08-30 —
    see section 7b below; the downloads and the yaml write are
    owner-approved, do them.**

- ~~**NEW, filed 2026-08-30 by the probe above: the panel decides a model
  is available by looking at the DISK, and the backend decides by its own
  search path. On this machine the two disagree today.**~~ DONE
  2026-08-30 (0.10.20), built as filed. `Comfy.missingWeights` asks the
  RUNNING backend's `/object_info` which of the chosen graph's weights it
  can actually load, and `comfy_generate` refuses on that answer BEFORE
  the arbiter stops the chat model, naming every missing file and where
  it sits on disk. Field-verified on the real backend, 11/11 verdicts
  (`scripts/weight-availability-probe.js`): H3 refused with all four
  weights located in the Desktop shared store, KREA2 untouched, the chat
  model never stopped, the graph never queued — on a job `planFor` says
  is a `handoff`, so the saved churn is real. The rule that makes it safe
  to ship is SILENCE: an unknown class, a non-combo input, a linked
  input, a non-file combo value (the field list really does carry
  `pixel_space` inside `vae_name`) and an unreachable backend all refuse
  NOTHING, so this can only ever refuse what ComfyUI would refuse itself.
  One ordering trap the first version walked into and the tests now pin:
  the boot moved ahead of the arbiter, which made a pause-"never" refusal
  start a backend it was about to refuse on — so `planFor` (side-effect
  free by design) answers first and only then is anything booted.
  `tests/test-weight-availability.js`, 33 checks. Original text: `comfyModelRoots`
  (0.10.13) includes the Comfy-Desktop shared store, so the arbiter prices
  the H3 template at 40 503 MiB and will stop the chat model to make room
  for it — and then ComfyUI answers `Value not in list — vae_name:
  'minimax_h3_video_vae_fp16.safetensors' not in [...]`. The user pays a
  handoff for a job that was never runnable. The ground truth for "can
  this graph load" is the backend's own `/object_info`, which lists
  exactly what it can see (it has no sizes, so the DISK is still the right
  source for the arithmetic — the two answer different questions and both
  are needed). Shape of the fix: before the arbiter acts, check every
  weight the chosen template names against `/object_info`, and refuse
  early with a grounded error naming the missing ones AND where they sit
  on disk — which is the sentence that tells a user their backend is
  pointed at the wrong root. Probe first: `/object_info` is already
  fetched by `scripts/attribute-workflow-nodes.js`, so the route exists.

- **Also filed 2026-08-30, smaller, for the remote session:** four of the
  seven catalog entries (`sd15`, `sdxl`, `ltx-small`, `wan22-5b`) have NO
  `workflowTemplate`, and `recommendGen` happily offers them — an 8/12/16
  GB card is now recommended `sdxl` for image, which `comfy_generate`
  cannot render because the panel bundles no SDXL graph. Pre-existing;
  the krea2 correction just made it the common case rather than the edge.
  `tests/test-model-catalog.js` now at least fails a template name that
  does not exist.

- ~~**And one measured oddity, logged not fixed:** the KREA2 template
  upscales 1.6x, so `comfy_generate {width: 1024, height: 1024}` returns a
  1640x1640 image.~~ DONE 2026-08-30 (0.10.21), and the graph's behaviour
  was left exactly as authored — what was wrong was that nobody said so.
  Two halves, because the panel had no way to answer the question at
  either end. (1) `injectParams` traces the size chain FORWARD from every
  node it sized to the node that writes the file and appends one line
  saying what the size becomes, using the scaling node's own arithmetic:
  a latent upscale lands on the /8 grid, which is why 1024 is 1640 and
  not 1638. It stays SILENT for every chain it cannot account for — a
  factor that lives in a `.pth`, a factor behind a link, a non-positive
  widget, two output branches that disagree, a chain reaching no output —
  by the 0.10.20 rule that a number which might be wrong is worse than no
  number. (2) `import_file` returns the size AE MEASURED (plus duration /
  frameRate for media that has them, absent rather than zero for a
  still), and `comfy_generate` hoists it to `outputSize`; before this,
  nothing anywhere in the panel knew the size of a file it had just
  imported. Field-verified on the real card by
  `scripts/output-size-probe.js`, which predicts BEFORE it renders and
  then reads the PNG's own IHDR: 512 -> 816 (not the 819 plain arithmetic
  would give, so the /8 grid is measured and not assumed) and 1024 ->
  1640, reproducing the number this bullet was filed with.
  `tests/test-comfy-output-size.js`, 23 checks, and the AE half is
  self-test step 533.
- ~~**Tier impersonation ladder**~~ DONE 2026-08-30 (0.10.13).
  `scripts/tier-ladder-probe.js` walks 4/6/8/12/16/24/32 plus the card's
  own number, against real nvidia-smi, a real llama-server and the
  weights on the real disk, and asserts the three questions this bullet
  asks as INVARIANTS rather than reading a table by eye: 176 of them,
  green on the 32B chat model and again on the 7B (which is what reaches
  the `concurrent` branch — the crossover is between 24 and 32 GB, 560 MB
  short at 24). Every rung was consistent; what the ladder found was one
  rung's INPUT. The panel priced the shipped H3 i2v template at null on
  the machine that had already rendered with it, because all four of its
  weights live in the ComfyUI Desktop app's shared auto-download store —
  a root no setting and no config file declares. Fixed at
  `comfyModelRoots` (shared store + any `extra_model_paths.yaml` /
  Desktop `extra_models_config.yaml` roots), which is the 0.10.9 bug
  arriving from outside the manifest. Backfilled by
  `tests/test-tier-ladder.js` (the ladder without a GPU) and five checks
  in `tests/test-vram-arbiter.js`. Timings on small cards stay
  training-quoted and still say "typically" — the ladder impersonates
  VRAM, never speed. See WORKPLAN-LOG 2026-08-30.
- ~~**OOM recovery**~~ DONE 2026-08-30 (0.10.14), and the bullet's premise
  did not survive the field. **This backend does not OOM on an oversized
  job — it GRINDS**: KREA2 at 4096x4096 on a 32 GB card offloads weights
  and runs at 33 s/it on pass one and 92 s/it on pass two, no exception,
  no end. So the reachable shape of "a generation the card cannot do" is
  the panel's own TIMEOUT, and that is the WORSE case: a torch OOM frees
  its allocation on the way out, an abandoned job does not.
  `scripts/oom-probe.js` drives the real panel path (override 6 ->
  mandatory handoff, so chat is really stopped) into exactly that, and it
  found the panel abandoning a job it had queued: the round timed out,
  said "prompt <id> may still finish in ComfyUI", and then asked
  llama-server to load 18 932 MB back into a 32 768 MB card the abandoned
  job still held **23 673 MB** of, with 1 job still running in ComfyUI.
  Windows' sysmem fallback hid the collision. A timeout now CANCELS —
  queue read first, only the panel's OWN prompt id acted on (deleted if
  pending, targeted-interrupted if running, nothing touched if it is
  someone else's), because this is the user's ComfyUI and they may have
  queued their own work in its UI. Re-measured: 10 588 MB at warm-up,
  0 running, round 225 s -> 112 s, chat back and answering in 93 ms.
  `tests/test-comfy-timeout-cancel.js` (18 checks; 10 fail on the
  reverted file). Harness 532/532 either side.
  - ~~**Filed, measured, NOT fixed here**: the resume still prints "VRAM
    did not visibly release within 10 s" after a cancelled round.~~ DONE
    2026-08-30 (0.10.15). Reproduced first, and the timeline named a
    worse number than the filing: the card sat at **23 654 MB of 32 768**
    for the entire wait and fell to **2 918 MB one second after it
    expired**, so a user with 29 GB free was told their VRAM had not been
    released. The wait now asks the honest question — is there ROOM for
    the chat model (card total minus used ≥ its footprint), with the old
    floor kept as an OR and as the whole answer when the card's own size
    is unknown — and the card total comes from nvidia-smi, never from
    `vramOverrideGB`, because pairing a measured reading with an
    impersonated total is arithmetic about no machine at all. The
    timeout's sentence now reports what it measured (used / card / need)
    instead of asserting a failure, and the room wait is 30 s because
    this backend's own post-cancel release finishes at ~10.5 s — a 10 s
    limit was a coin flip on exactly the round the cancel created. It
    costs nothing on a free card: the predicate answers on poll one.
    `oom-probe.js` gained the verdict and is green on it; four new checks
    in `tests/test-vram-arbiter.js` fail on the reverted file.

## 7b. OWNER-APPROVED 2026-08-30: finish the catalog measurements

**BLOCKED 2026-09-03: there is no ComfyUI running at all.** Neither 8188
nor 8000 answered and no ComfyUI process existed, so every bullet in this
section — the H3 un-blind, the three templates, the downloads and every
catalog VRAM measurement — has no backend to work against. A pass cannot
start the owner's instance for them: 0.10.9 established
`Comfy.ensureRunning` cannot start the working 0.32.0 here, and an
unattended restart risks leaving the machine with no backend at all.
**Needs the owner to bring ComfyUI up** (and to confirm the port). Until
then this whole section is skipped and passes fall through to section 8.

**THE UNBLOCK IS §17c, and it is better than "the owner starts it"**
(owner, 2026-09-06). `ensureRunning` cannot start the owner's OWN
ComfyUI — by design, it only ever spawns the vendor portable install
under `<dataRoot>\vendor\comfy` (`comfy.js:2122-2141`,
`setup.js:943-964`). Install that vendor backend on this machine and
the loop can boot its own backend on demand, unattended, with no owner
in the loop — **and it is then measuring the thing buyers actually
get**, which the owner's hand-built 0.32.0 never was. §17c is the pass
that does it. Until §17c lands this section stays blocked.

**THIS MACHINE'S ComfyUI LISTENS ON PORT 8000** (owner, 2026-09-01).
Every probe script under `scripts/` defaults to
`http://127.0.0.1:8188` and will find nothing without
`--url http://127.0.0.1:8000`; the panel's own `comfyUrl` setting must
say 8000 too, or `comfy_status` reports the backend down and the
arbiter refuses every generation. Check the setting FIRST and record
what it said in the log — a night lost to the wrong port is a night
lost.

The owner approved (in so many words: "bake in the other models for the
rest of the tier package. Test on this machine, it has the space") the
downloads that section 7 was blocked on, and settled the H3 question
("if you know where the models are just use them"). The panel side
shipped with 0.11.0: settings now has per-model Download / Remove rows
(`Tools.catalogModelStatus` / `removeCatalogWeights`,
`Setup.downloadGenWeight`, `tests/test-gen-model-manager.js`), and
`applyExtraModelPaths` writes the Comfy-Desktop shared store into the
hidden backend's yaml. What is left needs this machine. One bullet per
pass, smallest first:

- **Un-blind the running ComfyUI (H3 unblock, do this first — it is one
  file).** The running instance was launched `--base-directory
  Documents\ComfyUI` and reads `extra_model_paths.yaml` from that base
  directory; none exists there. Write one declaring the Comfy-Desktop
  shared store (`%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models`,
  every kind folder mapped — copy the section
  `Comfy._applyExtraModelPaths` writes, it is the same yaml dialect).
  Restart the backend, then verify the fix through the panel's own
  refusal machinery: `scripts/weight-availability-probe.js` must flip
  from "H3 refused, four weights named" to clean, and
  `Comfy.missingWeights` on the H3 template must answer empty. THEN
  measure minimax-h3 with `scripts/catalog-vram-probe.js` (this card is
  Blackwell, so the shipped nvfp4 template applies) and write the
  reading into version.js the way krea2 carries its own.
- **Templates for the template-less entries.** ~~sd15, sdxl and
  wan22-5b~~ **WIDENED AND MOVED TO §18 (owner, 2026-09-06).** The count
  was wrong: FIVE of seven catalog entries have no `workflowTemplate`
  (add `ltx-small` and `minimax-h3-int8`), and `minimax-h3`'s only
  template is i2v. The owner asked for a basic working graph per model
  as its own track — see **§18**, which carries the two-tier scheme, the
  ratchet that would have caught this, and the authoring order. Every
  VRAM measurement in this section is blocked on it
  (`catalog-vram-probe.js:282` refuses an entry with no graph).
- **Download + measure, one entry per pass: sd15 (2 GB), then sdxl
  (6.6 GB), then wan22-5b (17.3 GB).** Use the panel's own settings
  Download button path (`Setup.downloadGenWeight`) — that is field
  verification of the new rows, note how it behaves in the log — then
  `catalog-vram-probe.js`, then the measured block into version.js
  (`measured: true`, `measuredVramMB`, `measuredSeconds`, `measuredAt`,
  `measuredOn`), correcting `minVramGB` wherever the reading disproves
  it, with the ripple check on `recommendGen` picks that krea2's
  correction established as the pattern.
- **Verify the settings rows in real AE while the disk is in each
  state** (absent -> partial mid-download -> present -> removed):
  labels, measured sizes, the shared-store "in a folder the panel
  doesn't manage" copy on the H3 row, Remove receipts in chat. Add a
  selftest.js step for `catalogModelStatus` against a temp root if one
  does not exist yet.
- **Optional, last, owner-approved on space: minimax-h3-int8's own
  encoder** (~25.3 GB, the non-Blackwell variant). Measuring it on this
  Blackwell card still answers "does 32 GB hold the int8 encoder at
  all", which is the entry's open `note:` question. Skip if the night
  runs short — it gates nothing.

After each pass: patch bump (these are panel-visible catalog/measurement
changes), push, log. The 8 GB intermediate cap question is CLOSED (owner
asked, answered from the 0.10.17 measurements — it is a per-call
`maxIntermediateGB` disk guard now, not a format limit; no render test
needed).


### NEXT (one minute of real AE, from the 2026-09-03 retraction)

- **Re-measure `comp.saveFrameToPng` and add a real-AE step.** The log
  currently contains two contradictory real-AE readings: item 5.8's prep
  measured it writing 407 bytes with `resolutionFactor` honoured, and the
  0.11.26 pass concluded it writes nothing — without ruling out the
  silent no-op this same log documents for a **folder that does not
  exist**. The shipped `save_frame` tool guards exactly that case and
  depends on the call. Create the folder, call it once, read `f.length`.
  Then add a `save_frame` step to `extension/js/selftest.js`: it has 106
  stubbed assertions and **zero** real-AE steps, and the stub fakes the
  write, so nothing re-measures it. Unblocks the frame-comparator
  instrument the self-verify track wants. Do NOT build
  `save-frame-hazard-probe` from the salvage stash before doing this —
  it was written to chase the retracted claim.

## 8. Natural-language robustness — the paraphrase matrix (local; owner-requested 2026-08-30)

The owner's words: "a full natural language pass ensuring that
functions and actions can be adequately used with varied inputs rather
than exact prescribed trigger words." The instrument exists —
`scripts/chat-probe.js` already drives the REAL model through the REAL
panel code against the canned host — what it lacks is VARIANCE. One
bullet per pass:

**RESCOPED by the 2026-08-30 audit (docs/AUDIT-0.11.md part 1.4): a
variance number computed on today's harness would LIE.** The audit
measured: shared history never resets (chat-probe.js:346 — later
variants ride earlier successes), step order is load-bearing
(test-chat-probe.js:426-429 pins indexes), checks in steps 4/5/6
score wrong-but-present as pass (chat-probe.js:830-865), and the
name-scoped SWEEP whitelist (:621-635) makes project-mutating rows
(D-section, H3) UNSAFE against the owner's live project. Build in
this order, one bullet per pass:

- ~~**Prerequisites first.**~~ DONE 2026-09-02 (local, real AE,
  UNBUMPED — nothing in `extension/` changed). All three parts:
  history now resets PER STEP by default (only "a second turn that
  refers back" declares `carry`); `--isolate` rebuilds a
  deterministic rig (`rigPlan`, 34 AELL_callBatch commands, no model)
  before every step that declares `fromRig`, so N phrasings of one
  scenario cannot contaminate each other; the step indexes in
  tests/test-chat-probe.js are addressed by title and relative order;
  and steps 4/5/6 now read what their sentences actually ask for.
  New `--rig-check` builds and verifies the rig in real AE in
  seconds. Verified: rig-check green, `--isolate --steps 15,20,25`
  3/3 with the rig rebuilt between each, `--steps 1,2,4,5,6` 5/5.
  Two AE 2026 measurements are pinned in the log. The original
  instruction, for reference:
- **Prerequisites first.** Per-variant history + comp reset so one
  scenario can run N phrasings independently; un-pin the load-bearing
  step indexes in tests/test-chat-probe.js (address steps by title,
  not position); tighten the loose check() functions in steps 4/5/6
  with matching canned-host cases. Remote pre-builds; local
  calibrates with --reuse-server.
- ~~**Wire variants over the SAFE rows only.**~~ DONE 2026-09-02
  (local, real AE, UNBUMPED). `--variants` (which implies `--isolate`)
  runs each step's canonical sentence AND every paraphrase it declares,
  each from a freshly rebuilt rig with a fresh conversation. 45
  paraphrases over the 15 trigger-layer steps — casual / vague / typo'd,
  2-3 each, which covers all fourteen roadmap-item-2 trigger mappings
  and the A3/B3/E3/E4 usefulness rows that have a rig twin. Scored in
  three: pass / miss (check failed, comp untouched) / **HARM** (check
  failed, comp changed anyway), with the change read off the two
  READ_COMP states the run already fetches (`compDiff` — it sees the
  expression, the eased key and the recolour that `SIG_FN` cannot).
  `gradeMatrix` is the acceptance gate the bullet states. Findings are
  in the log; the wording fixes belong to the next bullet.
  ~~**Still owed here:** the A/B/C/E rows with no rig twin~~ DONE
  2026-09-02 (local, real AE, UNBUMPED — nothing in `extension/`
  changed). A SECOND rig, not a second set of sentences: `fromRig` now
  names a VARIANT, and `"icons"` builds the UNFINISHED world — six
  scattered solids over a full-frame `BG`, a small white `HEADLINE`, no
  keyframes, no expressions, no effects, nothing parented. The seven
  rows ask for exactly what it lacks, which is the only way a pass means
  anything. Steps 30-36. `rigProblems(variant, state)` is pure, so
  `--rig-check` runs it against the real comp (both rigs, in sequence)
  and the stub suite runs it against a synthetic one. Matrix: **19 pass,
  2 miss, 7 HARM over 28 runs** — findings in the log, fixes are the
  next bullets. The original instruction, for reference:
- **Wire variants over the SAFE rows only** (A/B/C/E scenarios + the
  ten roadmap-item-2 trigger mappings): 2-3 paraphrases each (casual,
  vague, typo'd). Score: right tool + right target = pass; honest
  grounded refusal or sensible question = pass; wrong-target mutation
  claiming success = the failure that matters, logged loudly.
  Acceptance: no variant may do harm; at most one may miss where the
  canonical passes.
- **Report, don't fix, in the same pass.** Append scenario / phrasing
  / chosen tool / verdict to WORKPLAN-LOG per run. Wording
  dependencies get ONE tool-doc/system-prompt change per pass (so a
  regression is attributable), re-run to show the flip, patch bump.
  Watch the 6KB prompt budget — measure buildSystemPrompt size
  before/after every rule addition. **In flight, one row per pass:**
  - ~~row 23 "keep it drifting" (was 1 miss + 1 HARM of 4)~~ DONE
    2026-09-02 (0.11.10). The rig was the second-order failure: ALL
    FOUR phrasings omitted `property` and hit the bare, ungrounded
    `Missing 'property'`, which is what the canonical gave up on and
    what took the typo run's whole round down in a rollback. Grounded
    now (`AELL_missingProperty`: the transform words, the layer's own
    effects, what is already keyframed), plus ONE rules bullet that
    carries `property: 'position'` and "on THAT layer, never a null".
    **4 pass, 0 miss, 0 HARM**, every run a single first-shot call.
    Prompt full 58910 -> 58953 (ceiling 59000 — the next addition needs
    a real cut). Harness 576 -> 578.
  - ~~row 19's canonical, "Chop off the lower half of Beta" ->
    `set_layer_timing`~~ DONE 2026-09-02 (0.11.11). Two wrong turns,
    not one: the canonical read "chop off" as the timing rule's "trim
    it", and the casual "I only want to see the top half" reached for
    center_anchor_point + set_transform. ONE rules bullet now carries
    both phrasings AND the anti-targets ("never set_layer_timing (that
    trims TIME), scale or anchor"), paid for by dropping "add_mask
    creates a mask (rectangle/ellipse/custom points)" — the args line,
    which compact keeps, already spells the shapes. **2 pass / 2 miss
    -> 4 pass, 0 miss, 0 HARM**, canonical and casual both single
    first-shot calls. Prompt full 58953 -> 58995 (ceiling 59000).
  - ~~row 17's "cheap"/"feels stiff" vocabulary reaches stagger_layers
    / distribute_property rather than apply_keyframe_ease~~ DONE
    2026-09-02 (0.11.12). The vocabulary was one of four defects and the
    only one wording could fix: the other three were REFUSALS whose words
    were the bug. apply_keyframe_ease with no 'layers' said "select
    layers in AE" and named nothing, so the model relayed it to the user
    and stopped; distribute_property's animated-property refusal ADVISED
    "delete the existing keyframes first" and the model obeyed, wiping 18
    keys; and easing a property with no keys named no property that HAS
    any, so the model asked the user to go make some. All three grounded
    (`AELL_noTargets`, `AELL_keyedProps`, non-destructive advice), plus
    ONE rules bullet carrying 'feels cheap' and "never stagger_layers
    (that moves layers in TIME)". **2 pass / 1 miss / 1 HARM -> 4 pass,
    0 miss, 0 HARM**, every run a single first-shot call. Paid for by
    three docs that repeated a phrase list the never-compacted rules
    already carry: prompt full 58995 -> 58989 (ceiling 59000, headroom
    5 -> 11).
  - ~~row 29, "clean up this comp" still lands somewhere destructive~~
    DONE 2026-09-02 (0.11.13). The routing bullet existed and was
    ignored because of its ORDER: it listed five removal tools before
    the "unnamed, ask" clause, and all four phrasings stopped reading at
    the tools. Rewritten ask-first, carrying the measured vocabulary
    ("a mess", "junk everywhere", "sort out") and the two measured wrong
    turns as anti-targets. Underneath it, three host fixes for the same
    round: `remove_keyframes` now GATES a wipe that names every layer in
    the comp (`AELL_wipeGate`, the clean_project/organize_project
    three-branch shape — the field round removed 18 opacity keyframes
    on an `ok` receipt); `AELL_noTargets` stops reading as "pass them
    all" for a destructive caller (the model copied all twelve names
    straight out of that refusal); and remove_effect's empty-parade
    refusal closes the door instead of offering apply_effect (the model
    guessed eight effect names in one round). **0 pass / 3 miss / 1 HARM
    -> 4 pass, 0 miss, 0 HARM**, every run a single first-shot ASK with
    zero tool calls. Prompt full 58989 -> 58974 (ceiling 59000), paid
    for by two third copies of "dryRun defaults to true" and a
    compressed clean_project doc tail. Harness 578 -> 589.
  - ~~row 36 casual, "drop shadow on every layer but the BG" ->
    `apply_effect {layers: [...]}` answered `Missing 'layer'`~~ DONE
    2026-09-02 (0.11.15). The refusal named the key that was ABSENT and
    never the key that had ARRIVED, so the model re-sent the identical
    call and gave up. Fixed at the one place a layer ref is resolved,
    not per tool: `AELL_missingLayer` reads the `layers` the caller
    actually handed over (parked by `AELL_runTool`) and names
    for_each_layer, the plural these tools DO have; a list under the
    singular `layer` gets the mirror message instead of AE's "invalid
    numeric result (divide by zero?)"; a bare miss is grounded in the
    comp's own roster. `AELL_layerOrSelection` refuses the same way
    rather than falling through to a selection the caller never named.
    `AELL_resolveLayer` now takes the arg NAME, so 'parent' /
    'matteLayer' / 'above' report themselves instead of saying 'layer'.
    **2 pass / 1 miss / 1 HARM -> 3 pass, 0 miss, 1 HARM** — the casual
    phrasing is a clean seven-call first shot. Zero prompt cost (host
    strings only). Harness 589 -> 593.
  - ~~row 36 vague, "everything should sit off the background a bit —
    shadow them, not it" — the model passes an EXPRESSION STRING as a
    `set_effect_param` value~~ DONE 2026-09-03 (0.11.17). The first of
    the two filed candidates was built at the root
    (`AELL_badValueMsg`, called from `AELL_writeValue` AND from
    `add_keyframe`), and the shape came from a measurement that
    contradicted the obvious fix: **real AE COERCES a numeric string** —
    `setValue("50")` reads back 50 and `["10","20"]` reads back
    `[10, 20]` — so the guard keys on "a string that is not a number",
    never on "a string". The refusal hands back a paste-ready
    `link_property {property: "effect.<Fx>.<Param>", ...}`, and the
    field run shows the model taking it and calling exactly that on its
    next round, `ok`. The filed failure (round rolls back, **6 of 7
    layers skipped on an "ok"**) did not recur — all seven non-BG layers
    carry the shadow. **The second candidate was measured and NOT built:
    `Parameter not found` already prints Drop Shadow's complete 7-name
    roster with Distance and Direction in it**, so there is nothing to
    rank. Row 36 vague is still HARM for a lesser, different reason (the
    model adds a `CTRL` null, layer count 8 -> 9). Harness 593 -> 599.
    One doc change and it was a CUT: `set_effect_param`'s
    `value: number|[..]|string` invited the failure, now
    `number|[..]` (prompt 58974 -> 58967). See the log.
  - ~~**`for_each_layer` prints an identical failure once PER LAYER**~~
    DONE 2026-09-03 (0.11.18). Its "Stopped after 5 failures" summary
    repeated the same ~450-char refusal five times, ~2.2 KB in ONE
    result against a 16384 ctx, and the next transcript line was
    `context trimmed — 2 earlier message(s) dropped` — the panel drops
    HISTORY on overflow, so a repeated refusal deletes the turns the
    model needs in order to act on it. `AELL_groupFailures` now prints
    ONE copy of each distinct message prefixed by every layer that hit
    it (`A, B, C: <msg>`), at BOTH report sites; messages that really
    differ still print in full, and a lone failure keeps the old
    `Name: error` shape. Measured on the same five-layer refusal:
    **1692 chars -> 420**. Zero prompt cost (host strings only). The
    canned host in tests/test-self-test.js used to SUMMARISE batch
    failures, which is why no stub could see this class; it now runs
    the sub-tool per layer. Harness 599 -> 602.
  - ~~**the `Parameter not found` lever is a CONCEPT map, not a
    ranking**~~ DONE 2026-09-03 (0.11.19). `AELL_paramConcept` +
    `AELL_paramMissMsg` in hostscript answer "which of these names is
    the thing you asked for": an `Offset` on Drop Shadow now reads
    `— on 'Drop Shadow' that is: Direction, Distance.` before the same
    grounded roster, `Blurriness` reads `that is: Softness`, and a word
    that means nothing there (`Wobble`) gets the OLD message with no
    invented suggestion. 14 concept rows, every word taken from a
    roster measured in real AE (`scripts/param-concept-probe.jsx`, 29
    effects). The same helper serves BOTH places a caller names a
    parameter — the dotted `effect.<Fx>.<Param>` spec that
    add_keyframe / link_property / set_expression resolve through used
    to refuse with the name and nothing else, no roster at all. Second
    measurement, second half of the fix: AE's own lookup takes
    `distance` but NOT `DISTANCE`, `dIsTaNcE`, `shadow color` or
    `Distance ` — arbitrary, so `AELL_paramIn` folds case and
    separators the way remove_effect and the render-template picker
    already do, and the receipt reports AE's spelling. Zero prompt cost
    (host strings only, 58967 unchanged). Harness 602 -> 610.
  - ~~**row 32: `stagger_layers` alone on layers with NO keyframes
    reports `ok` and animates nothing**~~ DONE 2026-09-03 (0.11.20).
    Three of four phrasings called it alone; it moved six start times,
    answered `ok {layers:6, spread:2.5, placed:[…]}` and nothing faded.
    Fixed as BEHAVIOUR, not wording: `AELL_staggerNoMotion` scans the
    targets it just retimed and adds a `warning` when EVERY one is
    provably static — no keyframe, no expression, no effect, no moving
    source. Deliberately one-sided, so an expression (it may read a
    keyed slider elsewhere) or ANY effect (CC Particle World and Radio
    Waves animate at zero keys) buys silence. Measured first
    (`scripts/stagger-motion-probe.jsx`, AE 26.3x87): **Marker is root
    property 1 and a LEAF on every layer type**, so a numKeys walk that
    did not skip it would call a merely-marked layer animated; Time
    Remap is a root leaf too and DOES count; a solid's source reports
    duration 0 where a precomp's reports 4; the walk costs 162 nodes on
    a bare solid and ran 6480 nodes in 53 ms (0.008 ms/node), so the
    20000-node budget covers ~120 layers and an exhausted budget stays
    quiet. Zero prompt cost (host string only, 58967 unchanged).
    The stub could not see this class at all — its layers answered
    `property()` by NAME only, with no root list to walk — so
    tests/test-curve-tools.js grew an index-addressable property tree
    with Marker, Time Remap, Masks and Effects on it. Harness 610 -> 622.
  - ~~**row 35: "soften"/"too sharp" reaches `add_mask`**~~ DONE
    2026-09-03 (0.11.21), with the typo phrasing's ellipse left open on
    purpose. Two of four phrasings masked the BG instead of blurring it,
    both HARM. Fixed on both levers the failure has. ROUTING: the choice
    happens before any tool call, so no receipt can reach it — and the
    prompt taught how to REMOVE a blur and never how to ADD one, while
    its only soft-sounding words were the mask bullet's own "a vignette
    is a big feathered ellipse". That bullet now carries
    `'soften it / blur it / too sharp / out of focus' = apply_effect
    {effect: 'Gaussian Blur'} — a mask feather softens the mask EDGE,
    never the picture`, and it is a NET CUT: 58967 -> 58947, paid by
    dropping add_mask's worked "bottom half" example and its wrong
    `sizes from get_comp_details` pointer plus delete_mask's description
    of its own grounded refusal (compact +184, written down in the log).
    BEHAVIOUR: the vague call's region was the layer's own four corners,
    which falls BETWEEN add_mask's two refusals (it neither misses the
    layer nor exceeds it), so `add_mask` now warns that the mask cuts
    nothing away and that a feather fades the OUTER EDGE, naming
    apply_effect 'Gaussian Blur'. One-sided: the tool's own default
    region, inverted, subtract, and a feather on a region that really
    does cut something away are all silent. The typo phrasing's ellipse
    hides ~90% of the layer, which is indistinguishable from a spotlight
    — nothing provable to say, so nothing said. Harness 622 -> 629, and
    it found a leak on the way (below).
  - ~~**the suite leaked its carpet-bomb rig comp, one per run**~~ DONE
    2026-09-03 (0.11.21). `AELL Self-Test Wipe` was the one rig comp
    with no cleanup step, so ten harness runs left `…Wipe` through
    `…Wipe 10` in the owner's project, and the bottom-of-suite "nothing
    of the suite's remains" check could not see them (it looks for the
    `ST ` namespace and for new FOOTAGE). It surfaced ten runs later and
    a long way off: `reduce_project`'s refusal TRUNCATES its comp list,
    and the tenth leaked comp pushed the comp that step looks for off
    the end of it — 627/628. Cleanup step added; the final check now
    also flags any un-baselined `AELL Self-Test…` item.
  - ~~**row 30 casual: `grid_layout` with no `layers` grids the
    BACKGROUND in**~~ DONE 2026-09-03 (0.11.22), with the HEADLINE half
    left open on purpose. "line the Icon layers up in a neat 3 by 2
    grid" arrived as `grid_layout {spacingX: 40, spacingY: 40}` — no
    `layers`, no `columns` — and headless there is no selection, so the
    fallback gridded every content layer and the comp's full-frame
    BACKGROUND took a cell with a rig expression on its Position.
    BEHAVIOUR: a layer that covers the WHOLE frame is a backdrop, not
    grid content, so a GUESSED grid now leaves it out and NAMES it
    (`skipped` + a paste-ready `layers: [...]` note). Skipped rather
    than warned because grid_layout cannot un-rig what it already
    rigged. New `AELL_compBoxOf` / `AELL_fillsFrame` (the corner mapping
    get_bounds already reports). One-sided: an explicit `layers` list, a
    live selection, a 3D chain (no honest comp box exists there) and a
    comp where dropping backdrops would leave under 2 layers are all
    untouched; the scan stops at 200 layers. ROUTING: the class-of-
    layers rule's phrase list was one shape short — `'the X layers'`
    added — and '3 by 2' = columns: 3 went on the ARGS line, which
    compact never touches. A NET CUT, 58947 -> 58926, paid by
    grid_layout's doc dropping its "never add_null first" sentence (the
    rules bullet says it word for word) and its "(nulls/cameras/lights
    excluded)" roster (the receipt now names what was left out); compact
    +64, written down in the log. A non-full-frame text layer is
    indistinguishable from a tile, so the HEADLINE half says nothing.
    Harness 629 -> 639. It found a lint false alarm on the way: the ES3
    ternary lint's ±25-line window counted an `ADBE ` EXAMPLE in a doc
    string as evidence, so a one-line shift turned a tool's args line
    into a failure — `^\s*args: "` lines are now excluded, proved by two
    assertions.
  - ~~**a rollback throwing away the calls that WORKED when a later one
    fails on a parameter name**~~ DONE 2026-09-03 (0.11.23). Row 35
    canonical: `apply_effect 'Fast Box Blur'` succeeded, then
    `set_effect_param {param: 'Radius'}` came back properly grounded
    ("'Fast Box Blur' has: Blur Radius, ...") — and the round rolled back,
    so the grounding worked and the blur it bought was thrown away. Fixed
    at the trigger, not per tool: `AELL_errArg` is the opposite pole from
    `AELL_errPartial` — a NAMING refusal that provably wrote nothing and
    already says what does exist — and `AELL_maybeRollback` leaves a round
    whose failures are ALL of that class alone, annotating the first one
    with the sentence that stops the model redoing the round whole. Seven
    pre-write refusals in apply_effect / set_effect_param carry it. Same
    defect one level down: `for_each_layer` called five naming refusals
    with ZERO successes `errPartial`, which armed the rollback over a call
    that had written nothing; it is `errArg` now, and every other shape
    stays partial (the conservative reading). Narrow ON PURPOSE — one
    non-naming failure, or any `mutated` result, still takes the round
    whole, so the nine-squares round is untouched. A bad VALUE is left
    OUT and pinned as a boundary assertion. Zero prompt cost (host
    strings only). Harness 639 -> 644; 26 new stub assertions across
    test-round-rollback / test-for-each-layer / test-property-access,
    10 of them RED against the reverted branches. The field run did NOT
    reproduce the failing shape (see the log) — that receipt is still
    open.
  - ~~a `--variants` re-run of rows 30 and 35~~ DONE 2026-09-03
    (0.11.24). **Row 30 is CLOSED — 4 pass, 0 miss, 0 HARM**: every
    phrasing gridded the six icons and left the BACKGROUND out, so
    0.11.22's phrase-list additions are measured in the field at last.
    **Row 35 went 2 pass / 2 HARM -> 3 pass / 0 miss / 1 HARM** on a
    defect the run named precisely: the CANONICAL sentence and its typo
    twin both called `set_mask {layer: 'BG', feather: 10}`, and
    `AELL_findMask`'s roster branch answered a MASKLESS layer with
    "(several masks — pass {mask: name|index}). Masks here: (none —
    add_mask creates one)" — false in the direction that reads as
    "there ARE masks, name one", and closing on an instruction the model
    obeyed straight into a full-frame feathered mask that softens
    nothing. Fixed at the resolver, not per tool: a zero branch that
    sends a FEATHER-ONLY ask to `apply_effect {effect: 'Gaussian Blur'}`
    and does NOT name add_mask (remove_effect's door-closing shape,
    0.11.13), while any other edit still points at add_mask — that
    caller does want a mask. `delete_mask` had carried this guard
    privately, with a comment saying the resolver's wording was wrong
    for zero; it is the resolver's now, so `set_mask_path` gets it too.
    Both HARMs flipped to pass in BOTH re-runs. Zero prompt cost (host
    strings only). Harness 644 -> 653; +19 stub checks, 8 RED against
    the reverted host, and the canned host grew the `set_mask` case it
    never had (which is why no stub could see this class).
  - ~~the `vague` phrasing routes "too sharp" to a MASK~~ DONE
    2026-09-03 (0.11.25). **ROW 35 IS CLOSED — 4 pass, 0 miss, 0 HARM,
    in BOTH re-runs**, every phrasing a clean apply_effect
    {effect: 'Gaussian Blur'} and not one mask anywhere. The lever was
    ORDER, exactly as filed and exactly the 0.11.13 lesson: the
    soften/blur clause already carried 'too sharp' but lived INSIDE the
    crop/mask bullet, behind a "But", in a bullet that OPENS by naming
    add_mask — so the model filed a blur as a sub-case of masking and
    stopped reading at the first tool. It is its own plain-English
    bullet now, placed BEFORE the crop bullet, and it names add_mask as
    the anti-target outright. A NET CUT: 58926 -> **58839**. Paid by
    grid_layout's doc dropping "with nothing selected it grids ALL
    content layers in the comp", which had been WRONG since 0.11.22
    stopped a guessed grid taking the backdrop and which the rules
    bullet above already says correctly — so the cut is a correction
    too. Row 30 re-run to prove the cut is safe: still 4 pass, 0 miss,
    0 HARM. Harness 653/653 unchanged (a routing fix is prompt-side;
    real AE cannot see it — the field matrix is its instrument).
    tests/test-chat-probe.js +10 assertions pinning BOTH halves,
    separation and order; all 10 RED against the reverted prompt.
  - ~~**a full-frame SUBTRACT mask erases the layer and says nothing**~~
    DONE 2026-09-03 (0.11.26). Filed by the 0.11.24/0.11.25 passes as
    the top item: `add_mask {bounds: [0,0,1920,1080], mode: 'subtract',
    feather: 100}` empties a layer on a bare `ok`. The one-sidedness
    argument the bullet asked for turned out to be a MEASUREMENT, and
    the tool's own comment was the thing under test — it claimed
    "'subtract', 'intersect' and inverted:true all cut SOMETHING away at
    full coverage", and some of them cut EVERYTHING away. New
    `scripts/mask-erase-probe.js/.jsx` reads the layer's alpha at nine
    points through `sampleImage(postEffect)` (the obvious instrument
    does not work: `comp.saveFrameToPng` exists on AE 26.3x87, throws
    nothing and WRITES NO FILE, with or without the comp in a viewer —
    a byte compare against it calls every case identical, which is the
    same silent-success shape). Measured, mode by mode: with the region
    covering the whole layer only `subtract` empties it; `inverted`
    makes the region worth NOTHING instead, and then `intersect` and
    `darken` empty it whatever is above them while `add`, `lighten` and
    `difference` empty it only when nothing is. The miss matrix is the
    exact mirror. `AELL_maskErases` is that table; the receipt now warns
    (never refuses — an animated reveal opens with exactly this mask),
    and unlike "cuts nothing away" it warns even when the caller named
    no region, because the tool's own default region under `subtract`
    erases the layer. Same correction to BOTH neighbouring refusals,
    whose reasons carried the same additive assumption: a comp-sized
    `subtract` "hides nothing" was really "hides the WHOLE layer" with
    show-shaped advice, and an off-layer `subtract` "would hide the
    whole layer" really changes nothing. Zero prompt cost (host strings
    only). Harness 653 -> **667**; +21 stub assertions, 12 of them RED
    against the reverted host, and two OLD assertions deleted because
    they pinned the defect ("an INVERTED full-layer mask hides
    everything — no warning"). The canned host in tests/test-self-test.js
    had no model of the default region at all, which is part of why no
    stub could see this.
  - ~~**a full-coverage mask that changes NOTHING answers a bare ok**~~
    DONE 2026-09-03 (0.11.27). Filed by the 0.11.26 pass as its top item
    and left out of it on purpose: `add_mask {bounds: the whole layer,
    mode: 'subtract', inverted: true}` is a provable no-op and reported
    success. No new measurement was needed — the same probe run was read
    from its other end (the rows that come out IDENTICAL to the baseline
    rather than 0), which is also what stopped a deduction getting two
    rows wrong: `add`/`lighten` at full coverage leave the layer fully
    showing whether or not it already had masks (so the older, wider
    "cuts nothing away" sentence keeps them, and `lighten` was WIDENED
    into it), and `difference` is a no-op only while it is alone.
    `AELL_maskNoOp` is the counterpart table to `AELL_maskErases` —
    same arguments, same inversion rule, nothing answers both — and the
    new receipt names the setting that did it and the argument that
    fixes it, mode-aware (inverted, everything but `subtract` HIDES the
    region it is handed). Gated on the caller having NAMED a region,
    which is the opposite one-sidedness from the erasure warning beside
    it and deliberate: a no-op is cheap, a vanished layer is not. Two
    omissions left silent on purpose: mode `'none'` (a path carrier, and
    a no-op at any region) and the two modes above. Zero prompt cost.
    Harness 667 -> **674**; +18 stub assertions with 9 RED against the
    reverted host, 7 of the 10 new/rewritten real-AE steps RED against
    the reverted canned host, and THREE old assertions plus TWO old
    suite steps rewritten because they pinned the defect — each proved
    "not an erasure" and then required a bare ok for it.
  - ~~**neither mask table can see the mask ABOVE, only whether one
    exists**~~ DONE 2026-09-03 (0.11.28). Filed by the 0.11.27 pass as
    its top item and correctly called a MEASUREMENT pass first: the two
    tables took a boolean `alone`, and both had only ever been measured
    against two worlds (no mask, and one add mask on the left half). New
    `scripts/mask-above-probe.js/.jsx` varies the thing the old probe
    held fixed — six parades, chosen so that "what they SHOW" and "how
    many there are" come apart — and reproduced both filed defects with
    the shipped tool: a full-coverage `difference` over masks showing
    every pixel takes the layer from alpha 1.0 to **0.0 with no warning
    at all**, and a full-coverage `add` over masks that hid something
    takes it 0.429 -> 1.0 on "cuts nothing away — every pixel of it
    still shows". Both tables are gone, replaced by ONE algebra
    (`AELL_maskApply`) plus `AELL_paradeShows`, which reads what the
    existing masks show EXACTLY (coordinate compression over the layer
    box; axis-aligned rectangles only, and it bails to silence on a
    feather, a bezier, part-opacity or an animated shape). Four
    outcomes now, not two: erases / no-op / **undoes** (new — the
    masking stopped working, unasked like the erasure because the layer
    visibly changes) / nothing to say. Three measured corrections fell
    out: an off-layer `intersect` empties a BARE layer and leaves a
    masked one alone (the inverted/miss mirror is false once masks
    exist), a `subtract` over a layer whose masks already hide
    everything takes nothing rather than erasing, and an unreadable
    parade still gets the sentence every reading agrees on ("a
    full-coverage subtract leaves the layer blank"). Zero prompt cost
    (host strings only). Harness 674 -> **698**; +18 stub assertions
    with 10 RED against the reverted host, 5 of the new real-AE steps
    RED against the reverted canned host, and six old assertions plus
    two suite fixtures repaired because they pinned the blindness.
  - ~~**an ELLIPSE is not its bounding box, and three sentences assume
    it is**~~ DONE 2026-09-03 (0.11.29). Filed by the 0.11.28 pass as
    its top item and correctly called a MEASUREMENT pass first. New
    `scripts/mask-ellipse-probe.js/.jsx` puts every ellipse row next to
    its RECTANGLE twin built from the identical numbers, and the twins
    read OPPOSITE alpha at the four corners in all twelve compositing
    rows: an 11x9 grid leaves **0.202** of the layer showing under a
    full-box ellipse `subtract` where the rectangle leaves **0.000**,
    and 0.798 under an ellipse `add` where the rectangle leaves 1.000.
    So `add_mask {shape: 'ellipse', mode: 'subtract'}` at the tool's own
    default region was answering "hides ALL of the layer" about a layer
    still showing four corner slivers, an `add` was told it "cuts
    nothing away" having just cut those corners off, and an inverted
    `subtract` "changes nothing" having done the same. Fixed at the one
    place coverage is decided: `AELL_shapeCoversBox` answers the
    ELLIPSE exactly (an ellipse is convex and a rectangle is the hull of
    its four corners, so containment is four corner tests), and every
    other shape it cannot prove answers false — which closed the same
    hole for a custom TRIANGLE that had the layer's bounding box and
    covered half of it. The two coordinate refusals drop the coverage
    CLAIM when the shape does not back it and keep the coordinates,
    which are the diagnosis. One new sentence replaces the false one,
    because silence would be worse than the old lie for a layer left
    showing four slivers: "hides all of 'X' EXCEPT the four corners of
    its box … about a fifth of the layer", gated on the parade being
    empty — measured, over one add mask on the left half only two
    corners survive. Zero prompt cost (host strings only). Harness
    698 -> **710**; +23 stub assertions with 11 RED against the reverted
    host, and 5 of the new real-AE steps RED against the reverted canned
    host.
  - ~~**row 36 vague over-builds a CTRL null rig for a one-line shadow
    ask**~~ DONE 2026-09-03 (0.11.30). **ROW 36 IS CLOSED — 4 pass, 0
    miss, 0 HARM, in every one of four field runs.** The last open HARM
    in the section 8 matrix, and the routing was never wrong: all seven
    non-BG layers got their Drop Shadow. What was wrong was the SIZE of
    the answer — the model opened with `add_control {layer: "CTRL"}`
    three times over on a layer that did not exist, built the null for
    real after the rollback, and the comp went 8 layers to 9. Prompt-side
    by nature (the choice happens before any tool call, so no receipt can
    reach it), and the lever was an omission rather than an order
    problem: the SCOPE bullet already listed what may not be bolted on —
    grids, effects, styling, animation — and a CONTROL RIG was not in it.
    It is now, with the measured vocabulary and the three anti-targets
    named outright (`no add_null, no add_control sliders, no
    link_property`), and the exemption travels with the ban so the
    audio/beat bullet below it keeps its link. **A first cut of the
    bullet routed the ask to "apply_effect (many: for_each_layer) +
    set_effect_param" and both field runs under it had the model
    inventing settings nobody asked for** (Shadow Color [0,0,0], Opacity
    50, Distance 20, Angle 120) — naming a tool in the ROUTE of a scope
    rule reads as permission to use it, so set_effect_param moved to the
    anti-list and the last two runs invented nothing. Paid for by the
    MACRO bullet's second copy of the same exemption and by
    audio_to_keyframes' doc repeating the link_property recipe the beat
    bullet spells out in full: prompt 58839 -> **58933** (ceiling 59000),
    compact 39574 -> 39803. Step 24 (the beat row, the one that needs
    link_property AFTER audio_to_keyframes) re-run to prove the cuts are
    safe. Harness 710/710 unchanged — a routing fix is prompt-side and
    real AE cannot see it. tests/test-chat-probe.js +14 assertions, 9 of
    them RED against the reverted prompt, plus the first check-side
    assertion for the CTRL-null shape itself.
  - ~~**`remove_effect`'s "no effects at all" refusal takes a whole
    correct round down with it**~~ DONE 2026-09-03 (0.11.31). Filed by
    the 0.11.30 pass as its top item and measured in the field: row 36
    vague run 1 sent `for_each_layer {apply_effect Drop Shadow}` (7 of 7
    ok) together with a belt-and-braces `remove_effect {layer: "BG"}`,
    that refusal fired, and `AELL_maybeRollback` threw the seven shadows
    away. It is exactly the `AELL_errArg` class 0.11.23 built and it was
    simply not tagged. All FOUR of remove_effect's pre-write refusals
    carry it now (no parade at all, a layer type that cannot take
    effects, a missing `effect` arg, a name that is not in the parade);
    the post-`remove()` "AE refused" failure is deliberately left plain,
    because AE threw inside the mutation. Second half, and the reason
    this is not a one-word change: the sentence the rollback appends
    said "Re-send only this one, with the name corrected", and THIS
    refusal has no name to correct — the fix is to drop the command, so
    it now offers both. Zero prompt cost (host strings only). Harness
    710 -> **715**, all five new steps RED against the reverted host in
    real AE and reproducing the field failure verbatim; +7 stub
    assertions in tests/test-property-access.js, 4 of them RED, and the
    canned host's rb-comp effect parade is PER LAYER now (it was one
    flat list for the whole comp, which is why no stub could tell "this
    layer carries none" from "the comp carries none").
  - ~~**`link_property` silently overwrites the expression that is
    already there**~~ DONE 2026-09-03 (0.11.32). The top item the 0.11.31
    pass filed: two calls drove one property from two different sliders,
    BOTH answered ok, and nothing said the first link was gone. Measured
    first, in real AE, by the new re-runnable
    `scripts/link-overwrite-probe.js` — which found the sharper half of
    the same class on the FAILING path: AE does NOT throw a bad
    expression (it keeps the text and fills `expressionError`, all four
    classes), so `AELL_setExpr`'s cleanup — `prop.expression = ""` —
    threw the user's WORKING expression away as the price of a REJECTED
    write. Fixed at the helper, so all four doors that write expressions
    inherit it: the prior text is captured before the write, RESTORED on
    rejection (with its OFF switch, since a disabled expression still
    reads back in full and any write re-enables it), and named on
    success — `replaced` + a note saying it is gone and how to put it
    back, `unchanged` when the same text is written twice, `removed`
    when a clear is what removed it. grid_layout reports the Position
    expressions its rig displaces, three with their text and the rest by
    name. Zero prompt cost (host strings only; prompt 58973 / compact
    39843, unchanged). Harness 715 -> **722**, six of the seven new
    steps RED against the reverted host in REAL AE; +19 stub assertions
    in tests/test-property-access.js, 12 RED. Both stubs were unfaithful
    in the same place and that is why the class hid: the `Prop` stub let
    `expression` be a plain string and wrote `expressionError` NOWHERE,
    and the canned host answered link_property/set_expression from their
    arguments alone, so a first link and a fifth read identically.
  - ~~**a mask's OPACITY is read nowhere, and neither is its
    EXPANSION**~~ DONE 2026-09-03 (0.11.33). The top item every mask
    pass since 0.11.26 has re-filed: `set_mask {opacity: 0}` on the only
    mask of a layer took it from alpha 1.0 to **0.0 on a bare ok**, and
    `AELL_maskRect` REFUSED any mask carrying an opacity, so one of them
    in a parade made add_mask's four sentences go quiet. Measured first
    by the new re-runnable `scripts/mask-opacity-probe.js/.jsx`, and the
    measurement broke the obvious rule twice: opacity 0 is NOT "the mask
    is off" (alone, every mode empties the layer — including a
    `subtract`, which "its region is worth nothing" says leaves the layer
    whole) and it is NOT "the layer is empty" either (further up the
    parade it behaves exactly as a region worth nothing, and `inverted`
    is not applied to it at all). `AELL_maskZeroApply` is that rule; all
    13 parades the probe built now read what the alpha reads. EXPANSION
    was the rider: measured +25 takes a half mask from 0.429 to 0.571 and
    +300 to 1.0, so a rect read from the SHAPE alone was a claim AE
    disagrees with — it makes the mask unreadable now, which turned a
    false "every pixel of it shows again" into the true sentence. Second
    half at the write end: `set_mask` reads the picture BEFORE and AFTER
    its own edit (never deduced from the argument, so the same guard
    catches a MODE change that empties the layer), and names erases /
    undoes / no-op, with the measured way out for opacity 0 — mode
    'none' is the off switch it reads like. "some" is never compared to
    "some". Zero prompt cost (host strings only, 58933 unchanged).
    Harness 722 -> **736**, four of the new steps RED against the
    reverted host in real AE; +34 stub assertions in
    tests/test-shape-mask-tools.js with 28 RED, and the canned host in
    tests/test-self-test.js grew an opacity/expansion model and a
    set_mask that judges its own edit (it answered from the arguments
    alone, so an edit that emptied the layer and one that changed
    nothing read identically).

- **DEFERRED until a sandbox design exists:** D/F/H3 rows (project
  mutation, renders, mass-delete) — wiring them against the live
  project is the harm the whitelist cannot contain. Also deferred:
  the full 75-125-variant nightly matrix (multi-hour sequential on
  the one machine) and the doc anti-drift assertion (it fails both
  directions today: 16 probe rows lack steps, 6 steps lack doc rows
  — add the 6 doc rows when wiring starts).
- **First pass housekeeping check:** eyeball the newest
  `logs\local-agent-*.log` — the Clean-Line scrubber (ANSI escapes,
  UTF-8 punctuation transliteration) shipped 2026-08-30 unparsed by
  any Windows PowerShell; if the loop dies on a syntax error or the
  log still shows mojibake, that fix is the pass.

## 9. Roadmap — ranked by the 2026-08-30 audit (owner approves order)

Supersedes the earlier proposal list (its items were absorbed,
re-ranked, or deliberately dropped — see docs/AUDIT-0.11.md part 2
for the full what/why/file:line and the dropped list with reasons).
Ranking optimizes for THIS stage: pre-launch alpha, robustness and
demo-power over breadth. Owner picks; remote builds features/minors,
local verifies in real AE.

1. **[S] Zero-silent-failure gate** — every audited silent-lie path:
   set_keyframes:8772 / apply_keyframe_ease:4698 partial-mutation
   errors become AELL_errPartial so rollback arms; executeCommands'
   silent 20-command slice (tools.js:2776) gets a synthetic
   "dropped N — re-issue" row + RESPONSE_SCHEMA maxItems; bare error
   paths grounded (apply_effect:3885, set_effect_param:3906/:3908 via
   AELL_effectNames, rename_item:742, delete_item:1118,
   move_to_folder:729, set_track_matte:8970/:8998); comfy
   image-landed fail-fast (the KREA2 silent image drop); uploadImage
   unique name prefixes; the two fitResult byte-slice fallbacks
   (tools.js:2582/2637) removed.
2. **[S] Plain-English trigger layer** — synonym rules + doc
   rebalance for the ten audited orphan tools ("group these" ->
   precompose, "trim it" -> set_layer_timing, "stick it to" ->
   set_layer_parent, "smoother" -> apply_keyframe_ease, "fix the
   pivot" -> center_anchor_point, "hide the bottom half" -> add_mask,
   "stop it moving" -> remove_keyframes, "make it pop/cinematic" ->
   list_presets+apply_preset, "keep it drifting" ->
   apply_expression_preset, "show the video through the text" ->
   set_track_matte); "clean this up" project-vs-comp disambiguation;
   one single-phrasing probe step per mapping.
   **The "clean this up" half is CLOSED 2026-09-02 (0.11.7) — by
   BEHAVIOUR, not wording. The routing miss itself is unchanged
   (measured 5 runs, both doc forms, with the disambiguation present in
   the tool doc AND in the never-compacted rules), but clean_project can
   no longer act on it: the preview is now a GATE (a delete must cite a
   preview of the SAME plan taken in an EARLIER user request) and a
   comp/layer argument is REFUSED instead of silently ignored. The field
   flip is in docs/WORKPLAN-LOG.md — the same sentence that deleted 7
   project items now deletes nothing and asks. NEXT of this class:
   organize_project carries the same preview-shaped advice and no gate.**
3. **[S] img2img restyle loop** — un-bypass KREA2's authored image
   branch, denoise param, snapshot_frame -> comfy_generate{image,
   denoise} -> import_as_layer reuse+reload. Needs item 1's landed
   check. Also fix the H3 I2V authoring-manifest drift (detachable
   flag) while in there.
4. **[S] Relative restack + removal symmetry** — reorder_layers
   relative mode (above/below/toFront/toBack on moveBefore/moveAfter),
   remove_effect, delete_mask, all with grounded neighbor/effect/mask
   listings; stacking-language disambiguation rule.
5. **[S] Animate-this-frame I2V one-liner** — trigger rule for
   snapshot_frame -> H3 I2V {image} -> import_as_layer; flagged
   3-call chain, fallback = compound panel tool.
6. **[S] One-click support bundle** — copy-chat grows into a full
   support report (redacted settings, tier line, comfy_status, server
   log tail, last round receipts); factor it testable so main.js
   finally gets executed stub coverage.
7. **[M] First-run flight check** — GPU/tier verdict in plain words,
   AE scripting-permission probe with the grounded fix message,
   guided download, canned first-win demo.
8. **[M] Timeline finesse pack** — retime_layer (stretch/reverse/
   time-remap), freeze_frame, shift_keyframes; local MEASURES
   stretch/remap quirks first, stubs encode them (padded-dims
   precedent).
9. **[L] Region inpainting hero demo** — full plan in
   docs/SELF-VERIFY-PLANS.md section 3; after items 1 and 3; ships
   as compound repaint_region, never 5-call model choreography.
10. **[S] Word-level kinetic captions** — whisper -oj JSON, per-word
    timestamps + confidence gating (retires the English-only
    SILENCE_WORDS sentinel), karaoke/typewriter mode.
11. **[M] Chat-probe variant machinery** — section 8's scoped
    version; measures item 2 and every prompt edit after it.
12. **[M] Bring-your-own-endpoint chat** — settings URL for any
    OpenAI-compatible server, skip spawn lifecycle; salvage path
    becomes load-bearing off llama.cpp, test it explicitly.
13. **[S/remote] Context budget is already over the default window
    (found 2026-09-01 by the trigger-layer review). OWNER PRIORITY
    2026-09-01 — "function needs to be prioritized much higher than
    conversation": this is the NEXT remote build, ahead of the rest of
    the list; the daytime batch's prompt growth (+7.8% after trimming)
    is the last addition that lands without a matching cut.** At ctx 16384 the
    arithmetic is: 3,072-token reply reserve, ~1.5K tokens of state,
    and a ~54.5K-char system prompt (~13.6K tokens) — HEAD sat at the
    edge (matches the field-observed 16,755-token overflow) and every
    prompt addition lands on history first. main.js's proactive
    `histBudget = max(4000, (ctx-3600)*3 - system.length)` is NEGATIVE
    at these sizes, so history gets the 4,000-char floor and the panel
    leans on the HTTP-400 `forceTinyContext` retry, which keeps four
    entries and breaks refer-back turns. The trigger layer was trimmed
    to fit (rules carry the phrase lists, docs carry one phrase each),
    but the shape is wrong: (a) make the budget ctx-aware from the
    measured prompt size, not a floor; (b) default ctxSize by TIER
    (T7 with a 32B Q4 on 32 GB has KV-cache room for 32768 — measure
    the VRAM cost with the arbiter's numbers before raising it);
    (c) a compact tool-doc mode where well-routed tools get one line;
    (d) a reply-brevity rule — the model's answer is one or two
    sentences over the receipts, never a restatement of what the tool
    results already say (its replies live in the same window and in
    the 3,072-token reserve); (e) a prompt-size ceiling pinned in
    tests/test-context-budget.js so growth without a cut fails CI;
    (f) **the summarization protocol (owner ask 2026-09-01)** — the
    measured truth today is that main.js's histBudget floor (4,000
    chars) means most rounds already run with about ONE turn of
    memory; fitHistory drops whole entries silently and the system
    note only says "N messages were trimmed". Replace the silent drop
    with a deterministic LEDGER: every entry fitHistory would drop is
    folded into one line the panel builds WITHOUT a model call — a
    user turn → its first ~120 chars; an assistant turn → the tool
    names it ran with their naming args (layer/comp/property) and its
    reply's first clause; a TOOL RESULTS turn → ok/error counts and
    the names created/renamed/deleted from the receipts. The ledger
    ("Earlier in this session:" one-liners, newest last, hard cap ~1.5
    KB with its own reserved slice) rides in the system prompt tail so
    the user-first template invariant holds, and it is what lets "make
    them blue instead" resolve after the original exchange fell out of
    the window. Phase 2, measured before adopted: when the ledger
    itself hits its cap, ONE cheap model call (max_tokens ~200, only
    between rounds, never mid-round) compresses it; skip if the 32B's
    latency cost is not worth it. NOTE, resolved 2026-09-02: pass 22's
    stash touched this same area and has been salvaged — the fitHistory
    floor landed (0.11.6), the planContext half was filed rather than
    applied because this item's own 0.11.4 work already answers it with
    better measurements. Nothing left to reconcile; the stash is dropped.
Stub-testable; local measures the VRAM side.

Dropped for now, with reasons recorded in the audit doc: comp
versioning (first post-alpha minor), comp checkpoint/diff, review
render slates, missing-footage triage, segmentation-to-matte
(fast-follow AFTER inpainting), 2.5D parallax, variation boards,
one-call audio reactivity, the full paraphrase matrix.

## 10. Self-verification harness track (owner-requested 2026-08-30)

The owner's words: "built in plans and recursive checks for the more
advanced tools like mogrt creation and captions generation and
image/inpainting via mask generation so I dont need to manually test
nearly as much." The full adversarially-verified plans live in
**docs/SELF-VERIFY-PLANS.md** — read the relevant section BEFORE
starting a bullet; the "Requirements from refutation" there are
constraints, not suggestions. Local passes work these in order,
smallest first, one bullet per pass; remote pre-builds the [remote]
steps of each plan's build order:

- **MOGRT step 0 (a live bug, fix immediately):** AELL_mogrtFound
  (hostscript.jsx:9482) trusts a possibly mid-write file size — add
  the two-stable-polls settle per the plan, plus the reserved-device-
  name gap in AELL_mogrtBadName. Remote builds; local verifies.
- **MOGRT harness** per plan section 1: reader + planted-defect
  tests [remote], shipped capped post-check [remote], the Premiere-
  gated fixture pin [local, one manual Premiere drop], mogrt-probe
  wired into the overnight stage [local].
- **Captions harness** per plan section 2: bridge factor-out +
  TextDocument readback + pure helpers [remote], captions-probe with
  env triage [remote], real-box calibration + nightly wiring +
  forced-failure drill [local].
- **Inpainting** per plan section 3: comfy plumbing + export_mask +
  pixel comparator [remote], AE fact probes BEFORE trusting stubs
  [local], template authoring + report-only runs + owner-blessed
  tolerances [local], compound repaint_region + chat-probe scenario
  [remote]. This is also roadmap item 9 — the harness and the
  feature ship together.

## 11. Can the harness drive PREMIERE too? (probe first, owner asked 2026-09-02)

**Folded into section 12 / docs/PREMIERE_PLAN.md P0 on 2026-09-02**
— the probes below are P0 step 4 there, and P0 is OWNER-GATED. Do not
run them from an unattended pass; the text stays for context.

The overnight harness exists because After Effects ships
`AfterFX.exe -r <script.jsx>`, which runs ExtendScript in a live
instance. **Premiere has no such flag** — that, not effort, is why
every Premiere check has been manual. Two candidate doors, neither
measured; this item is the measurement, not the build:

- **BridgeTalk from inside AE.** The harness already runs ExtendScript
  in AE, and BridgeTalk was Adobe's inter-app script channel
  (`new BridgeTalk(); bt.target = "premierepro"`). If Premiere 2026
  still answers it, driving Premiere costs no new machinery. Adobe has
  been retiring ExtendScript in Premiere in favour of UXP, so this may
  simply not answer. PROBE: from a `-r` script with Premiere RUNNING,
  send a one-line script that writes a file, and see whether the file
  appears. Record the exact Premiere target name that worked (it is
  versioned, e.g. `premierepro-25`), or that none did.
- **A CEP panel installed into Premiere.** We already build one for
  AE, so the skill is in the repo. A minimal panel that runs on
  Premiere launch, does the check, writes a result file and reports.
  Heavier than BridgeTalk and it changes the user's Premiere install,
  so only if BridgeTalk is dead.
- **If both are dead, say so and stop.** The manual step stays manual
  and gets written up as a genuine limit, not a TODO. Note that the
  0.11.x foreign-corpus probe already covers the part that matters
  (can we READ what Premiere ships); what Premiere-driving would add
  is "does Premiere ACCEPT what AE wrote", a narrower question.

Whatever the answer, write it into CLAUDE.md's hard-won facts: the
next session must not re-derive whether Premiere is scriptable.

## 12. Premiere panel in the same ZXP — OWNER-GATED, plan filed 2026-09-02

The plan is `docs/PREMIERE_PLAN.md`. Short version: yes, the ZXP can
carry a second CEP extension for Premiere (one bundle, one feed, one
installer); but Adobe's own doc sources say Premiere ExtendScript is
supported "through September 2026" and CEP "for a calendar year" after
25.6 (~Nov 2026), and UXP cannot spawn processes or ride the ZXP. So
the CEP surface is a bridge: probe first, MVP on the dev junction
only, UXP decided on a date.

**P0 is APPROVED (owner, 2026-09-02) and its scripts are written. P1
and beyond are NOT approved** — an unattended pass that finishes P0
appends the results and stops; it does not start P1.

### P0 — what exists now (remote side DONE)

- `probe/com.cptk.aellama.probe/` — throwaway bundle, own bundle id,
  OUTSIDE `extension/` so CI can never publish it. Shape A manifest
  (two `<Extension>`, per-extension `HostList`) plus
  `manifest-shape-b.xml` (one extension, both hosts, loader
  `ScriptPath`). `jsx/probe.jsx` is the ES3 half; `index.html` is the
  page, which shims CEP itself and loads nothing from `extension/`.
- `probe/com.cptk.aellama.harness/` — door 3's invisible runner.
  DEV-ONLY, never packaged; claims a job file before running it because
  `StartOn` fires on every OS focus gain.
- `scripts/install-probe.ps1` — CSXS key snapshot (a measurement in
  itself) + PlayerDebugMode 10–14 + the junction. `-Shape A|B`,
  `-Harness`, `-Uninstall`.
- `scripts/ppro-door-probe.ps1` — all three doors, with
  `ppro-door-bridgetalk.jsx` (door 1) and `ppro-door-cli.jsx` (door 2).
  Exit 0 a door answered, 3 every door measured dead, 4 nothing
  measured.
- `scripts/ppro-probe-report.js` — the grader. MEASURED / MISSING /
  FAILED per row; G0 passes only on MEASURED rows.
- `scripts/ae-window-census.ps1 -ProcessName` — census Premiere too.
- `scripts/bump-version.js` — global regex + every `<Extension>`
  asserted (`tests/test-bump-version.js` reproduces the old bug).
- `ZXPSignCmd -verify` in `package-zxp.ps1` and as its own CI step.
- `tests/test-probe-bundle.js` — the probe can never ship, never
  depends on the panel, both shapes are what they claim, both inline
  page scripts parse, and MISSING never grades as a pass.

### P0 — what the owner runs (in order)

Plain PowerShell in the repo root. Not the Claude CLI.

1. `powershell -ExecutionPolicy Bypass -File scripts\install-probe.ps1`
2. Quit AE and Premiere completely. Start **After Effects** first,
   open `Window > Extensions > AE Llama P0 Probe (AE)`, press "Run all
   read-only probes", then "Engine soak".
3. Start **Premiere**, same menu, same two buttons. (AE first is what
   answers the localStorage question.)
4. `powershell -ExecutionPolicy Bypass -File scripts\ppro-door-probe.ps1 -Census`
   — add `-AllowAdminWrite` (elevated shell) for door 2 and
   `-ClosePremiere` if it may quit Premiere for doors 2 and 3.
5. `node scripts\ppro-probe-report.js`
6. Repeat 1–3 with `-Shape B`, then with the signed ZXP
   (`package-zxp.ps1` → `install-zxp.ps1`) and **the aescripts
   installer** — that last path is mandatory, it is the only one
   testers use.
7. Install the Premiere 27.0 beta and repeat step 3 there.
8. MOGRT: with a scratch sequence open in Premiere, press "MUTATES:
   MOGRT accept read-back" and give it
   `logs\mogrt-verify\AELL Probe Card.mogrt`.
9. Export one transcript as TXT, CSV and SRT; open the Premiere AI
   Assistant and record what it does, refuses, uploads and charges.

### P0 — exit

Gate G0 in `docs/PREMIERE_PLAN.md`. Commit the probe JSONs under
`docs/measured/`, fill `docs/PREMIERE-PLATFORM.md` sections 2 and 4,
add the facts to CLAUDE.md, close section 11 with its answer. **No
version bump — nothing here ships.**

## 12b. DRIVE THE PREMIERE P0 PROBE TO GREEN (loop item, owner-approved)

**ALTERNATE with the rest of the backlog. Never two Premiere passes in
a row.**

Read `docs/WORKPLAN-LOG.md` first, as always. If the LAST entry was a
12b pass, skip this section this pass and take the next normal item
instead. If it was anything else, take 12b. That gives roughly half the
night to Premiere and half to the AE product, which is the actual
priority: AE is the shipping product and Premiere is an unfunded probe.

A Premiere pass launches and closes Premiere and takes ~5 minutes, so
it is not free; that is the other reason not to run them back to back.

**Section 13 (attention/KV backends) counts as "the rest of the
backlog" for this rule**, and its first pass should be 13a step 1 — the
environment measurement — because every later decision in that section
depends on it and it costs one command. Do not let 13 starve behind the
paraphrase matrix: it is the section that decides whether the product
works on the cards most buyers own.

Everything needed already works unattended: `run-ppro-probe.ps1`
launches Premiere, the invisible door-3 runner claims the job with
nobody at the keyboard, every battery step reports its own verdict, and
the result is copied into `docs/measured/`. What is left is iterating on
the remaining failures, and that is loop work, not human work. The owner
has been running it by hand all day and should not have to again.

### One pass

1. `powershell -ExecutionPolicy Bypass -File scripts\run-ppro-probe.ps1`
   It closes Premiere first, launches it, waits, prints every step, and
   closes Premiere again. Allow it up to 6 minutes.
2. Read the printed output AND the newest `docs/measured/ppro-probe-*.json`.
   The JSON has fields the summary does not print.
3. If every step passed: write the measurements into
   `docs/PREMIERE-PLATFORM.md` section 4 (grades: MEASURED), close this
   item in `docs/WORKPLAN-LOG.md`, and stop working it.
4. Otherwise fix the FIRST failing step only. One root cause per pass.
   Re-run the probe in the same pass to confirm the fix before
   committing; a fix that was not re-run is not a fix.
5. Commit, push, and append to `docs/WORKPLAN-LOG.md` what failed, what
   you changed, and what the re-run showed.

### Rules

- **No version bump.** The probe is not shipped; `extension/` is not
  touched. Bumping would push a no-op update to every panel.
- **Never touch the owner's projects.** The probe works in a scratch
  `.prproj` under `%APPDATA%\AE-Llama\probes\`. If a step would mutate
  anything else, fix the step, do not widen its permission.
- **No dialogs, ever.** A modal with nobody at the keyboard is a hang.
  `createNewSequence(name, "")` opens the New Sequence dialog and is
  gated behind `allowDialogs:true` for exactly this reason. Anything
  that prompts is a defect to route around, not to accept.
- **Run the lints before every push**: `node tests/test-es3-syntax.js`,
  `test-es3-ternary.js`, `test-powershell-syntax.js`,
  `test-probe-bundle.js`, `test-manifest-xml.js`. They exist because
  each of them cost a wasted Premiere launch once already.
- If a step cannot be made to work, that is a RESULT. Record it as a
  measured limit in `docs/PREMIERE-PLATFORM.md` with what was tried, and
  move to the next failing step rather than looping on it forever.

### Known open failures as of 2026-09-03 03:20

- ~~`project`~~ **PASSES 2026-09-03**, and the fix was the opposite of
  what the old note assumed. Measured over four runs on 26.3.2: a
  scratch `.prproj` handed to Premiere on the COMMAND LINE is not
  opened at all (`app.project.name` empty for the full 30 s wait)
  whether the file was written by a clean close or left by a killed
  instance, and on the way out Premiere raises "This file path does not
  exist on disk at this location." about a file that IS on disk - an
  unanswerable modal, so the close times out and the instance is
  forced. `app.newProject` then refuses the taken path (returns FALSE,
  leaves an `AELL_PROBE_SCRATCH<guid>` sidecar). So saving the scratch
  "for next time" is what broke every run after the first. The runner
  now archives `AELL_PROBE_SCRATCH*` into `probes\stale` and launches
  PLAIN; the battery creates and saves a fresh project each time. Also
  measured: `app.openDocument` EXISTS on 26.3.2 (`hostFacts` records it
  now) and the project step uses it, with all four
  suppress-the-dialog flags, whenever the path is already taken.
  Confirmed from the exact state that had failed twice: `project` ok,
  and Premiere closed by itself.
- ~~`history`~~ **MEASURED 2026-09-03** (it was only ever blocked by
  `project`): three `rootItem.createBin` calls, bins created, and the
  cleanup removed them. The 1-vs-3-undo-entries question still needs a
  human to look at the History panel - the step says so itself.
- ~~`sequence`~~ **PASSES 2026-09-03** (run `-0413`), and forwarding the
  dropped args was the whole fix: the seed route worked first try,
  3 video tracks, so the second suspected cause did not exist.
  `createNewSequenceFromClips` was NOT what answered "Illegal Parameter
  type" - given a real imported clip it succeeds, so the rejected
  parameter was `newBarsAndTone`'s own. Both doors now forward every
  job field they do not own instead of naming six of them twice; a
  whitelist maintained in two files is what lost `seedMedia`, and
  `tests/test-probe-bundle.js` §8 now goes red if either door returns
  to one.
- ~~`mogrt`~~ **PASSES 2026-09-03** (run `-0510`), and with it **every
  battery step passed for the first time**. The diagnosis held: the
  graphic lands at its insertion TIME, so it took index 0 and pushed
  the seed to index 1 - `clips[after - 1]` was asking the SEED for a
  MOGRT component. The probe now photographs the track before and
  after (`AELLP_clipSnap`) and takes the one clip the before picture
  cannot account for (`AELLP_newClip`), by `nodeId` where the build has
  one - measured, 26.3.2 does - and by name + `start.ticks` as a
  multiset otherwise. Read back: **4 controllers, all named, Source
  Text still `HELLO`**, so Premiere accepts what AE writes and
  `docs/SELF-VERIFY-PLANS.md` step 7 is retired on this build. Receipt
  carries `pickedBy` so a fallback pick can never be mistaken for a
  clean diff; `tests/test-probe-bundle.js` §9 holds the class without
  Premiere.

### ~~The battery is green; the GRADER is the item now~~ DONE 2026-09-03

`scripts/ppro-probe-report.js` grades `job-result.json` too. Every row
takes the NEWEST source that has its value and prints which file that
was (`[job]` / `[pnl]`, `*` = the older artifact); a `sources:` line
dates both. The stale `FAIL MOGRT ... clip count did not grow (1 -> 1)`
is gone and the PPRO block went 13-of-23 rows unmeasured to 3-of-27. G0
also stopped grading an ABSENT reading as a measured FAIL. Held by
`tests/test-probe-bundle.js` section 10; measurements in
`docs/PREMIERE-PLATFORM.md` section 4. The GRADER, not the runner's own
printout, is the authority for an unattended run from here.

### ~~The GATE is the item now: the soak is a button, not a step~~ DONE 2026-09-03

**`node scripts/ppro-probe-report.js` exits 0 with `G0: PASS`**, three
of its four rows from `job-result.json` - a run nobody watched. Run
`-0630`, Premiere 26.3.2: **500 of 500 round trips survived in 8190 ms**
with a 2000-byte payload checked whole each round, taken AFTER the full
9-step mutating battery in the same engine.

The item said "add a soak step to the battery" and that was the wrong
fix, which is worth keeping: what degrades is the engine across
evalScript ENTRIES, so 500 iterations inside ONE evalScript would have
reported "survived" while never crossing the boundary - a false pass on
the last row the gate was still honest about. The loop lives on the CEP
side instead, in a `SOAK-SHARED-BEGIN` block both doors keep
byte-identical (the `battArgs` rule again), driven by the door-3 runner
from `job.soakRounds`. `-SoakBudgetSec` (120) keeps it inside
`-TimeoutSec`; a soak it stops reports `STOPPED at round N of 500` with
a `skipped` reason, and a run that never asked writes no soak reading at
all rather than displacing the panel's with its own silence. Held by
`tests/test-probe-bundle.js` section 11 (it drives the real shared loop),
measurements in `docs/PREMIERE-PLATFORM.md` section 4.

### The next 12b item

G0 is closed, so section 12b's step 3 applies: what is left is the PPRO
rows the per-host table could not answer.

1. ~~**the installed manifest shape** and **`$.fileName` inside
   `ScriptPath`**~~ BOTH SETTLED 2026-09-03 (run `-0902`), and they
   settled differently, which was the whole finding. The manifest is a
   FILE and the door-3 runner has `fs`, so the shape row needed no click
   and is measured unattended now (`B (one HostList, loader)`, found by
   `ExtensionBundleId` under every CEP root, with the path it read).
   The ScriptPath row is genuinely CLICK-ONLY and that is now measured
   rather than assumed: `loader.jsx` is the PROBE bundle's `ScriptPath`,
   CEP evaluates it when that panel LOADS, and an unattended run opens
   no panel - the global is absent from the engine door 3 talks to.
   Door 3 was NOT given a `ScriptPath` of its own to close it: "nothing
   auto-loads" is what keeps the invisible runner inert in the owner's
   hosts (section 5 of `tests/test-probe-bundle.js`) and outranks one
   table cell. The REPORT changed instead - a row the newest run could
   not take and said why grades **EXPLAINED** and prints `n/a` with the
   reason, so an absence with a cause stops reading like a host
   refusing to answer. En route, a third defect: Premiere's answer for
   `$.fileName` is the EMPTY STRING and both doors stored it as
   `(fname && ...) ? fname : null`, which threw it away - the one host
   the row exists for would have graded itself unmeasured while holding
   the answer. PPRO now has no `----` row at all (26 ok, 1 `n/a`).
   Held by `tests/test-probe-bundle.js` section 12.
2. **`doors.json` is still MISSING** - `scripts/ppro-door-probe.ps1`
   has not been run since the door-3 runner started working, so the
   report's "headless doors" block says nothing.

Neither blocks G0. Item 2 is the last one; if it turns out to be
bookkeeping, close section 12b outright and hand Premiere back to the
owner-gated section 12.

## 13. Attention + KV backends — the low-VRAM gate (owner-raised 2026-09-03)

**Why this is one section and not two optimisations.** Both items below
buy back VRAM, and VRAM is the thing that decides whether this product
works at all on the cards most buyers own. The owner's own 32 GB card
is limited to a 16K context today; an 8-12 GB card is the common case on
aescripts. On those cards SageAttention is not a speed tweak, it is the
difference between video generation being usable and not.

Both are MEASURE-FIRST. Neither should be landed from reasoning.

### 13a. SageAttention + Triton, fully automated (owner-specified 2026-09-03)

**The owner's requirement, verbatim in effect:** completely hands off.
Scan the hardware, download the right things for it, install them, and
the only thing a user ever sees is *"here's what you're running, and
Triton and SageAttention have been successfully installed"*, shown
alongside the model downloads and the ComfyUI install that happen at
first run. Environment paths get exposed in Advanced Settings for
someone with a niche setup, but reaching for them must never be
necessary.

**CORRECTION 2026-09-06: "the ComfyUI install that ALREADY happens at
first run" was wrong — it does not happen.** `autoBootstrap`
(`main.js:774`) installs the llama.cpp engine hands-off and nothing
else; `Setup.bootstrapComfy` has exactly one caller,
`btn-comfy-install` in Settings (`main.js:1394`). So this section's
step 3 installs wheels into `<vendor>\comfy\python_embeded`, an
interpreter that exists only if the user pressed a button. **§17b is a
hard prerequisite for 13a** — until it lands, "hands off" has a button
in the middle of it.

This is not a research task. **Almost every piece already exists**, and
the job is mostly wiring them together:

| Need | Already in the repo |
|---|---|
| Scan the hardware | `Setup.detectGpu` returns `{hasNvidia, name, cudaVersion, computeCap, vramGB}` — `computeCap` is exactly what kernel selection needs, and it is already measured on a 5090 |
| A Python we control | `Setup.findComfyInstall` → portable ComfyUI with `python_embeded/python.exe` |
| Serve the right file per machine | The hosted `update.json` manifest already carries `modelCatalog` and `comfyCatalog` |
| Decide install from hardware, testably | `Setup.recommendSetup(manifest, gpu)` — pure over its inputs, stub-tested |
| Pick a build by CUDA version | `pickAssets` / `pickReleaseAssets` already do this for llama.cpp |
| Download with progress + cancel | `downloadToFile` |
| Own the launch line | `comfy.js` spawns `install.python` with args we choose |

**The one architectural decision, and it is the whole design.**

**Wheel URLs live in the hosted manifest, never in the panel.** Wheel
availability moves constantly — a new torch, a new Python minor, a new
GPU architecture, a new SageAttention release. If the panel hardcodes
them, every one of those needs a panel release and every user who has
not updated is stranded. In the manifest it is a JSON edit on our side,
and it reaches every installed panel immediately. This is exactly how
`modelCatalog` and `comfyCatalog` already work, so it is a precedent,
not an invention.

Proposed shape, to be confirmed against a real measurement first:

```
"accelCatalog": [
  { "kind": "triton",        "python": "3.12", "torch": "2.x",
    "cuda": "12.x", "minComputeCap": "7.5", "url": "...", "sha256": "..." },
  { "kind": "sageattention", "python": "3.12", "torch": "2.x",
    "cuda": "12.x", "minComputeCap": "8.0", "url": "...", "sha256": "..." }
]
```

**Step 1 — MEASURE the shipped environment. Nothing is chosen before
this, and nothing here may be written from memory: wheel availability
and kernel requirements both move, and a confident guess here strands a
paying user on a broken generation backend.**

One command against the interpreter the panel installed, recorded into
`docs/measured/`:

```
<vendor>\python_embeded\python.exe -c "import sys, torch; print(sys.version); print(torch.__version__); print(torch.version.cuda); print(torch.cuda.get_device_name(0)); print(torch.cuda.get_device_capability(0))"
```

Python minor, torch version, the CUDA torch was **built against** (not
the driver's — `detectGpu` reports the driver's, and they differ), the
device, and the compute capability. Also record which ComfyUI portable
release the build came from, since that is what pins torch.

**Step 2 — `pickAccel(manifest, env, gpu)`, pure and stub-tested.**
Same shape as `recommendSetup`: given the manifest, the measured
interpreter environment, and the GPU, return the wheels to install, or
an explicit "nothing matches this machine" with the reason. Purity is
what lets this be tested for a dozen machine shapes with no hardware —
which is the only way a matrix this wide gets covered at all. Test the
5090 (sm120), a 12 GB 40-series, a 3060, a GTX card below the INT8
kernel floor, an AMD/Intel card, and a machine with no GPU.

**Step 3 — install, offline and hermetic.** Download the wheels
(verifying `sha256`), then install into the embedded interpreter only:

```
python_embeded\python.exe -m pip install --no-index --no-deps <wheel> ...
```

`--no-index` and `--no-deps` on purpose: a hands-off installer must not
resolve dependencies from the network into an environment the user
depends on, and must never silently upgrade the torch ComfyUI is pinned
to. If a wheel needs something the environment lacks, the manifest is
wrong and step 2 should have refused. **There is no compile-from-source
route** — the owner's requirement settles the question I previously
filed as open: a route needing MSVC and a CUDA toolkit is not hands off,
so no wheel means no install, and see step 5.

**Step 4 — VERIFY IT ACTUALLY LOADED. The user-facing sentence has to be
earned.** "Successfully installed" printed off a pip exit code is the
silent-success class this repo has spent weeks removing, and here it
would be worse than silence: the user would believe they are on the fast
path while every generation runs slow. Required before that sentence is
shown:

- import the module in the embedded interpreter and confirm it loads;
- launch ComfyUI **with** `--use-sage-attention` and read ComfyUI's own
  startup log for its confirmation line, rather than inferring;
- run one fixed workflow at a fixed seed and record seconds and peak
  VRAM, before and after, into `docs/measured/`. If the numbers do not
  move, it did not load, whatever anything claims.

**Step 5 — degrade honestly and invisibly.** Any failure at any step:
launch ComfyUI without the flag, install nothing further, and never
retry in a loop. The status line then names the attention backend
actually in use. A user on a small card is entitled to know they are on
the slow path — but they are not asked to do anything about it, and
nothing is presented as an error, because nothing they did was wrong.

**Step 6 — the surface.** First-run shows one line among the existing
model/ComfyUI steps, in the shape the owner asked for: what is running,
and that Triton and SageAttention are installed. Advanced Settings
exposes the interpreter path, the resolved wheel URLs, the detected
env/GPU facts, and a re-run button — read-only escape hatches for a
niche setup, never a required step. Nothing here may become a prompt a
normal user has to answer.

**Step 7 — `tiers.js` consequences.** The VRAM arithmetic behind
`comfyPauseLlm: "auto"` is calibrated on the current attention path. If
peak VRAM moves, those thresholds are stale, and a card that could now
run generation alongside the chat model will still be told to pause it.
Re-measure the tiers that move; do not adjust them by reasoning.

**Why this is worth the passes:** on 8-12 GB cards — the common case for
aescripts buyers, not the exception — this is the difference between
video generation being usable and being unusable. It is a gating
feature for most of the market, not an optimisation for enthusiasts.

### 13b. KV-cache quantization for llama-server

`llama.js`'s `spawnServer` passes `-m --host --port -c -ngl` and nothing
else, so the KV cache runs at fp16. For a 32B GQA model that is roughly
256 KiB per token: about 4 GiB at the default 16K context and 8 GiB at
32K, on top of ~19 GB of weights at Q4_K_M. That is why the owner's
32 GB card behaves like a 16K card once ComfyUI also wants VRAM.

`--flash-attn` with `--cache-type-k q8_0 --cache-type-v q8_0` roughly
halves the KV cost, which would put 32K within reach of the VRAM 16K
occupies today.

**Not a free win, and not landable without measurement:**

- q8 KV is lossy. The instrument that can see whether it costs accuracy
  is the paraphrase matrix (`scripts/chat-probe.js --variants`), because
  routing is what degrades first and no stub can see it. Run the same
  rows at fp16 and at q8 and compare pass/miss/HARM.
- Record tokens/sec both ways as well; flash-attention usually helps, but
  "usually" is not this repo's standard.
- Older llama-server builds reject these flags. Detect and fall back
  rather than failing to start — a panel that will not launch its model
  is worse than a slow one.
- This touches `extension/`, so it BUMPS.

**If it lands, the context default is worth revisiting** — but 16384
stays the shipping default regardless (see §7 and `docs/ORIENTATION.md`):
buyers on 8-12 GB cards are the common case, and the compact prompt form
is built for them.

**Instrument, and the direction of the dependency (review, 2026-09-05).**
No launcher in the repo can pass `--flash-attn` / `--cache-type-k`:
every probe that starts llama-server goes through `Llama.start` →
`spawnServer`, whose arg list is closed. A pass that adds the flags to
`llama.js` to take a reading has changed `extension/` and must bump —
shipping KV quantization to every buyer as the side effect of a
measurement, before this section's own "detect and fall back" guard
exists. So the measurement in §16f #2 is taken with a **standalone
`scripts/` launcher** (`child_process.spawn` of `llama-server.exe` with
explicit flags, nvidia-smi sampled the way `catalog-vram-probe.js:312`
does), no `extension/` change, no bump. The dependency runs
**13b-fallback → 16f#2**, not the other way. And "roughly halves" above
is a 32B-shaped estimate; the 7B's KV arithmetic is what the reading
establishes.

## 14. Memory compaction (filed 2026-09-05, not started)

`docs/MEMORY.md` made the log's growth survivable — a pass now routes
through a 2k-token index instead of pretending to read 262k tokens. But
the log still grows ~16k tokens a night, and an index over an ever-larger
corpus eventually routes to entries whose subsystem sections are
themselves too long to scan.

**The missing tier is compaction: rolling settled history out of the
append-only log and into the semantic tier**, where it is short, curated
and correctable.

Not built yet, deliberately. The index removed the urgency, and
compaction is destructive in a way that wants its own pass and its own
verification rather than being tacked onto this one.

**Shape when it is taken:**

1. **Only settled entries.** An entry is a candidate when nothing has
   superseded it and it is older than some window. A correction and the
   thing it corrects must compact together or not at all — splitting them
   recreates the exact contradiction rot the index exists to prevent.
2. **Destination is the semantic tier, not a second archive.** A fact
   worth keeping belongs in `CLAUDE.md`'s hard-won facts,
   `docs/ORIENTATION.md`, or the relevant workplan section. If a
   compacted entry produces no such fact, that is the finding: it was
   working, not knowledge, and only the audit trail needs it.
3. **The log is never edited in place.** It is the audit trail and its
   line numbers are published by the index. Compaction moves entries to
   `docs/archive/WORKPLAN-LOG-<range>.md` and leaves a stub, or it does
   nothing. Rewriting history under a live index is how pointers start
   lying.
4. **Regenerate and re-verify.** `node scripts/memory-index.js`, and
   `tests/test-memory-index.js` must still resolve every published range.
5. **Measure the before/after** — corpus tokens, index tokens, and
   whether any correction lost its partner. Record in `docs/measured/`.

**Do not reach for a database first.** For a megabyte of markdown,
`grep -n` is the full-text search and the index supplies its starting
point. SQLite/FTS5 or embeddings are infrastructure ahead of a measured
need; take them only once keyword search is shown to be missing things.

**Not to be confused with the PRODUCT's compaction.** That was proposed
in §15 as "summarize-oldest replacing drop-oldest" and the review found
the premise wrong: the panel already has a deterministic ledger
(`rollupHistory`, no model call, budgeted inside `historyBudget`). §15's
compaction collapses into extending that ledger to keep user turns
verbatim. See `docs/proposals/memory-layer-REFINED.md` §8.

## 15. Memory & planning layer — REVIEWED; store and block OWNER-GATED

**Authoritative document: `docs/proposals/memory-layer-REFINED.md`.**
Read it before anything else in this section. It supersedes the earlier
`memory-layer-REVIEW.md` and `memory-layer-SYSTEM-PROMPT.md` (kept, with
banners, as the record of what was reviewed) and corrects four claims
those documents made — one of which propagated into this section.

Reviewed 2026-09-05 by an adversarial pass: seven grounded skeptics,
every finding verified from two lenses, a completeness critic, and 22
hand re-verifications against source of everything that changed the
plan. 56 confirmed, 26 contested, 1 refuted.

Do not confuse this with `docs/MEMORY.md` — the DEVELOPMENT loop's
memory. This is the PRODUCT's memory. No shared code.

### Corrected here, because it was wrong here

Item 2 of the previous version of this section said "Nothing in the
panel reads `app.project.file`… the layout is anchored to something the
panel cannot currently locate." **False.** `get_project_info` returns
`projectFile` and `fetchProjectState` calls it on every send; it is in
the state block already. A literal grep missed the `var proj =
app.project` alias. No new host tool is needed; identity is a string
compare at turn start.

### Settled by the review (details and citations in REFINED)

- **Strike** "when memory and the project disagree, update the record" —
  it contradicts its own bullet and destroys correct memory under two
  constructed scenarios. Strike-only, no replacement clause.
- **Markdown is the only truth.** No SQLite, no FTS5, no `index.md`.
  Session log is JSONL. Key = (scope, topic, **subject**); the original
  (scope, topic) key allowed 14 records total. Seven topics stay for v1.
- **`remember`/`update` collapse to one upsert**; "one record per key"
  is a store invariant and a stub test, not a prompt bullet.
- **Dated prior-value journal** in APPDATA on every write. Memory tools
  are `mutating: true`. Writes are NOT rollback-aware (rejected: it
  couples a durable user preference to a transient host failure).
- **APPDATA is primary. The session log and `plan.md` are never in a
  hand-off folder.** Only `memory.md` may be exported beside the `.aep`,
  by explicit action. Import is explicit and previewed, never on open —
  a travelling hand-editable file injected into the prompt of a model
  with 60+ mutating tools is an injection channel. Recalled records are
  delivered as TOOL RESULTS, never spliced into `Rules:`.
- **The unsaved project has no project scope.** No hash (nothing stable
  to hash). No automatic adoption on `null → path` (owner decision 1).
- **The block is staged with the tools it names**, not shipped as one
  1,499-char unit: write rules permanent (~700 chars after the strike);
  read rule becomes the index header, injected only when non-empty;
  plan bullet ships with the plan tools; digest bullet is dropped.
- **The resident index is runtime data, not a ceiling problem** — cap it
  like `STATE_BUDGET`, not as a second reserve. With subject keys it is
  ~57 tokens, not 400-800.
- **Drop the handle store** — a stored payload is a cached snapshot of
  project state, principle 1's forbidden thing one layer down. The
  existing expansion is a re-query (`limit:0`).
- **The loop owns plan check-off**, steps carry receipts, a checked step
  is verified on resume by one host lookup (never by presence in the
  budgeted state block), Clear chat deletes the plan, and the MODEL
  decides resume from an injected "A plan exists" line — not a loop-side
  phrase regex.
- **Compaction collapses into the ledger** the panel already has:
  `rollupHistory` is deterministic, re-derived from raw history, inside
  `historyBudget`. Keep user turns verbatim under `LEDGER_BUDGET`.
- **`chat-probe` must run against a temp store**, or the 770/770
  baseline stops being reproducible the day memory ships.

### The budget, corrected

The synthesis budgeted the rules block (1,499 chars, both forms) and
nothing else. Two line items were missing, and one exit was.

- **Tool docs cost both forms too**: every args line survives
  compaction (asserted in CI). Four memory tools ≈ +539 compact / +603
  full.
- **Acceptance is the starve notice, not the ceiling.** On the probe's
  measured real state the block alone flips `historyBudget().starved` at
  16K, and `main.js:635` then tells every default user to raise their
  context — advice §16 says the 8-12 GB buyer cannot follow. Test row:
  `historyBudget(16384, compact + block + tools + index + 2682).chars ≥ 2000`.
- **The missing fourth way to pay: ~850 chars of REAL deletion in both
  forms.** Four rules passages are duplicated on args lines or first
  sentences, which compact keeps — `comfy_generate` bullet (−459),
  project-panel bullet (−223), Rigging closer (−127), line 741 ⊂ 752
  (−41). The earlier claim that Option A "helps compact but not full"
  was wrong for these.

### Loop-takeable NOW (the rest waits on the gate)

Preparatory, non-shipping-surface, each verified by its own instrument:

1. **The four Option A deletions**, one per pass, each gated on
   `scripts/chat-probe.js --variants` for the rows that name the
   affected tool. These free bytes whether or not memory ships. Bumps
   (prompt text is `extension/`).
2. **`tests/test-context-budget.js`: the starve row.** Build compact +
   a 2,682-char state fixture and assert `!starved` at 16384. Today this
   passes (2,682 chars); it is the row the memory block must keep green.
3. **A `--store-root` on `chat-probe.js`** defaulting to a temp
   directory, with provenance printed the way `reportSettingsOrigin`
   does. Harmless before the store exists; mandatory after.

### Build order when the gate opens (REFINED §10)

store + tests → inline global store when non-empty (capped, no index) →
prompt (write rules + deletions + args lines, matrix-verified) → matrix
rows → view/clear/revert UI → resident index → governor digest → plan
file → ledger. First value (a font remembered on session two) is reached
at step 4, not step 7.

### Owner decisions (REFINED §11)

No automatic adoption of unsaved-project intent; seven topics for v1;
schema enum stays wide under routing; the ceiling re-pin number once
deletions are measured; the scope of the model-identity rule.

**Cross-section dependencies:** routing (§16e) is enabling work for
this section's bytes and inherits this gate; §13b changes every budget
here if it moves the default context past 24576.

## 16. Tiers are too generous — CORRECTED; what is loop work is marked

**Read this first.** Two halves, gated differently:

- **§16f — loop work.** Marked per reading, because the review found the
  previous version queued two readings the loop cannot take under its
  own brief.
- **§16a-16e — analysis, owner-gated.** Tier boundaries and copy are
  commercial text. Do not rewrite unattended.

Reviewed 2026-09-05 alongside §15. Three corrections to this section's
own numbers are recorded in place below; the reasoning is in
`docs/proposals/memory-layer-REFINED.md` §0 and §6.

### 16a. The system prompt is the cap, not the model — WITH state

| form | chars | tokens |
|---|---|---|
| compact (ctx < 24576) | 39,803 | **10,758** |
| full | 58,933 | 15,928 |

**Correction.** The previous table was computed with an EMPTY project.
`main.js:571` passes the state block and `STATE_BUDGET` caps it at
6,000 chars; the real number a user gets depends on their project:

| ctx | empty project | probe's real state (2,682) | state at cap (6,000) |
|---|---|---|---|
| 8,192 | **0 — STARVED** | 0 | 0 |
| 16,384 | 4,704 | **2,682** | **309 — STARVED** |
| 20,480 | — | — | 11,368 |
| 24,576 | 26,823 (flips to FULL docs: 8,468 with capped state) | | |

**16K works for an empty project. With a real project it is marginal,
and a busy one trips the panel's own starve notice.** The first
*comfortable* context with a real project is **20,480 compact** — which
multiplies the KV term in every VRAM row below by 1.25. Note the FULL
form kicks in at 24,576 and leaves *less* history than 20,480 compact.
§16f #2 must be taken at 20,480 as well as 16,384, or it measures the
wrong floor.

Below 12,288 nothing helps — see 16e.

### 16b. Nothing reserves VRAM for After Effects

Every tier allows `headroomGB: 1`. Nothing in `tiers.js` reserves memory
for the application this panel lives inside. **The 2-3 GB figure used
here was an estimate from outside the repo** — but the log already holds
three AE-inclusive baselines on the dev 5090: **3,255 MB** idle with
nothing loaded (LOG:7428), and two more in the 2.8-4.4 GB range with
ComfyUI resident. §16f #1 makes it a persisted reading.

### 16c. Tiering reads the card sticker, not free VRAM

`detectGpu` queries `memory.total`; `effectiveVram` uses it directly.
`queryVramUsedMB` exists and is used by the per-job generation
arithmetic — and, the review found, **the arbiter already samples the
non-chat footprint at every handoff and throws it away**:
`tools.js:1821-1827` reads `memory.used` before `Llama.stop()` and again
after the drop (`settledMB → _floorMB`), and `:1862` nulls it. That
`settledMB` is by construction "everything on the card that is not the
chat model" (an upper bound — the drop-wait resolves on the first sample
past a threshold, so some releasing chat memory may remain). The only
free-VRAM gate on a load is the *resume* at `:1875`; the first
`Llama.start` has none.

### 16d. The arithmetic — with the 6,002 relabelled

**Correction.** "The 7B holds 6,002 MB (measured)" was wrong as
labelled: 6,002 = 4,466 (the Q4_K_M file, `version.js:58`) + 1,536 (a
flat constant, `tools.js:1177`) — the arbiter's *formula*, taken at no
context size and no KV type. **But** it is corroborated: LOG:7428-7429
records idle 3,255 MB → chat loaded **9,724 MB** on the 5090, a delta of
~5,974 MB, within 28 MB of the formula. So: *formula, corroborated by one
delta; ctx and KV type at that reading unrecorded.*

| card | 7B (~6.0 GB) + AE (3.3 GB idle, measured; more with a project) | left |
|---|---|---|
| **8 GB** | 6,002 + 3,255 | **−1,065 MB** |
| 12 GB | same | 3,031 MB |
| 16 GB | same | 7,127 MB |

Using the *measured* idle figure the 8 GB row is worse than the estimate
made it, before any project is open and before any image is generated.
**T3 currently promises that buyer "solid 7B chat plus SDXL images and
short video clips."**

### What I would ship, and why

**Honest CHAT floor today: 12 GB.** It is a *chat* floor: the review
found §13a (SageAttention) moves peak generation VRAM and therefore the
generation half of every tier's copy, which §16 never mentioned. **One
owner decision on tiers, after §16f AND §13a step 4, not two.**

**8 GB becomes defensible only after §13b (KV quantization) lands** —
which makes §13b a prerequisite, not an optimization. **Tool routing is
no longer cited here** (16e).

**Below the floor, the custom-endpoint escape hatch is a small feature,
not "a config field".** The review listed five assumptions the chat path
makes about its own server: a literal `127.0.0.1` host; an identity
check that rejects a server the panel did not spawn; the arbiter sizing
the model by `statSync` on a local path and pausing it by killing a
local PID; `ctxSize` set by the panel on its own server (a remote
endpoint's real `-c` is unknown, so the HTTP-400 class returns); and
`json_schema` + `cache_prompt`, which Ollama's compatibility layer only
partly honours. List which are bypassed for a remote endpoint before
selling it.

**Why the risk tolerance is lower than a normal local-AI product:** the
failure mode is a modified project, not a wrong answer.

### 16e. Tool routing — bounded, and no longer a floor lever

**Routing cannot reach 8K.** Preamble + rules to `Available tools:` is
19,060 chars = 5,152 tokens; plus the 3,328-token reply reserve = 8,480
> 8,192. `historyBudget(8192, rules-only).chars === 0` — with ZERO tool
docs rendered an 8K window is starved. Routing moves the context floor
**exactly one rung, 16,384 → 12,288**, never to 8K. It is a
16K-history and §15-bytes lever. §16's floor cites §13b and §16f only.

**Designed as a second axis {all, routed} × {full, compact}** on the
same opts object, with its own CI pins — a ceiling per worst-case group
union and an assertion that the rendered set is closed under the rules
block's references. Without them the existing ratchet goes slack the
moment routing lands (a routed compact prompt sits 10-18K under
`COMPACT_CEILING`), and "routing frees bytes for §15" is true only
because the discipline stopped.

**Two decisions before code:** the rules block names 57 of 79 tools, so
"Use ONLY the tools listed below" contradicts "= apply_effect" when it
is not rendered — closure or route-the-rules; the honestly routable set
is the 22 un-named tools (7,137 compact chars). And the schema `enum` is
all 79 names — narrow it (wrong group → un-emittable) or leave it wide
(hidden tool still runs, grounded errors recover); wide is the default.
Per user turn, round N+1's set is extended by tool names in round N's
results (no model call) — the redirect lever that closed row 35. The
router is an opt on `buildSystemPrompt` mirrored as a `chat-probe` flag,
or the instrument cannot see it.

**Gate:** inherits §15's.

### 16f. The measurements — split by who can take them

**Correction.** The previous version said "three points: idle with no
project, a real project, mid-render — loop work". Two of the three are
forbidden to the loop by its own brief (`run-local-agent.ps1:235-239`:
never quit AE, never close its project — it raises the save modal that
lost two nights), and the repo holds no `.aep` fixture. Re-queued:

**LOOP:**
1. **Persist `_floorMB`.** `tools.js:1862` nulls the non-chat footprint
   the arbiter computes at every handoff; log it instead, with the
   ctxSize and whether a project was open. That is the mid-session,
   real-project figure for free once it lands (bumps — `extension/`).
2. **One launch-time `memory.used` read** before the first
   `Llama.start`, logged — the non-panel baseline. Same change.
3. **Mid-render reading** inside the harness's own scratch comp, with
   llama-server and ComfyUI verified not resident (`memory.used` is all
   processes). Standalone script.
4. **The 7B at ctx 16,384 AND 20,480, fp16 vs `q8_0` KV** — resident MB
   and tokens/sec each way — via a **standalone `scripts/` launcher**
   (see §13b): no `extension/` change, no bump.

**OWNER:** the real-project reading. Item 1 makes it automatic the first
time a generation runs against a real project; until then §16d's AE
figure is the measured *idle* 3,255 MB.

Do NOT rewrite the tier table, copy or boundaries in the same pass.

## 17. The ComfyUI backend — MANAGED by default, own install by explicit choice

Filed 2026-09-06 after the owner asked the question this section exists
to answer: *"will the user always need to start up an external ComfyUI
instance before being able to image/video gen from the plugin?"*

**The intended answer is no, and most of the machinery already ships.**
`comfy_generate` calls `Comfy.ensureRunning` before every generation
(`tools.js:2081`), which in order: (1) uses whatever answers at the
configured URL as-is; (2) scans 8188/8189/8000 and, if a ComfyUI is
answering elsewhere, **reports it and never reroutes** — silently
rendering on a different backend would swap the model set under the
user; (3) otherwise spawns the vendor portable install hidden
(`windowsHide: true`, `--disable-auto-launch`, on the configured port),
health-polls it up, persists the PID and reaps it on panel close
(`main.js:1460`) and on next launch (`main.js:1178`). A buyer sees no
window, no launcher and no port.

**The owner's design call (2026-09-06):** *"allow a user to bypass it
using their own install if they want, but design it as a portable
install by default."* That is an inversion of what ships, not a
restatement of it — today the bypass is what you get by accident and
the managed backend is the fallback. 17a is that inversion; it is the
first item and the other three assume it.

### 17a. Managed is the default; "use my own" is an explicit setting

**The defect, measured in the code.** `comfyUrl` defaults to
`http://127.0.0.1:8188` (`settings.js:59`) — **ComfyUI's own default
port.** `ensureRunning` step 1 uses whatever answers there, as-is, with
no disclosure and no choice recorded. So every buyer who already runs
ComfyUI on the standard port silently becomes a bring-your-own user
without ever deciding to be one, and the panel prices jobs, checks
weights and reports status against a model set it does not manage.

**The inconsistency that names it as a bug rather than a preference.**
Step 2 refuses to reroute to a ComfyUI found on another port, and the
comment says why (`comfy.js:1926-1931`): *"silently rendering on a
different ComfyUI than the user configured would swap the model set
under them."* **Step 1 does exactly that whenever the port happens to
match, and carries no such guard.** The panel's own stated reasoning is
applied at one door and not at the other, and the unguarded door is the
one a default install walks through.

**Second defect, same root.** The managed backend spawns on the
CONFIGURED port (`comfy.js:2137-2141`), so on a default install it
targets 8188 too — the port the user's own ComfyUI will want the next
time they start it. The panel would be squatting on it.

**The shape:**

- `comfyBackend: "managed" | "own"`, defaulting to **`"managed"`**.
- **Managed owns its own port** and does not consult `comfyUrl` at all.
  Pick a fixed default outside `LOCAL_COMFY_PORTS` (8188/8189/8000) so
  the panel never collides with, or is mistaken for, a user's own
  instance — 8288 unless something better turns up — with a settings
  override for a genuine collision. **If that port is already answering,
  fail honestly and say so; never attach to it.** Attaching is step 1's
  bug wearing a different number.
- `comfyUrl` belongs to `"own"` and is only reachable once that mode is
  chosen. So does `comfyDir`, `Comfy.launch` and the Launch button.
- `applyExtraModelPaths` only ever writes into the managed install —
  the panel does not edit a config file it does not own.

**`findLocalComfy` becomes an OFFER, not a refusal.** Its existing
finding ("a ComfyUI is answering at 127.0.0.1:8188") stops being an
error hint and becomes the bypass's front door: *use it instead of the
built-in one?* — which flips `comfyBackend` to `"own"` and fills in the
URL. That is the whole feature the owner asked for, and it costs one
button on an existing measurement.

**Migration, and the trap in it.** An existing install with a
non-default `comfyUrl` is someone who configured it → `"own"`. An
untouched default → `"managed"`. **Read `loadedFrom` before deciding**
(`settings.js:135`): a value that is only a default must not be
migrated as if it were an answer. That exact confusion already cost two
sessions a false claim about the owner's port (measured 2026-09-02, the
comment at `settings.js:122-133`).

**Verification:** the matrix is small and every row is real — managed
with nothing else running; managed with a foreign ComfyUI on 8188
(must ignore it and boot its own); managed with something already on
the managed port (must refuse, not attach); `"own"` pointing at a live
instance; `"own"` pointing at a dead one (must not silently fall back
to managed — the user chose). Stub-testable end to end; `comfy.js`
already takes an injected `child_process` in `tests/test-comfy-backend.js`.

Bumps (`extension/`). This is user-visible behaviour on a commercial
surface — build it in one pass, not smuggled into another.

### 17b. The backend install is a BUTTON, not first-run (loop-takeable, BUMPS)

`Setup.bootstrapComfy` has exactly one caller: `btn-comfy-install`
(`main.js:1394`). Compare `autoBootstrap` (`main.js:774`), which
installs the inference engine on first run and says so — *"First-run
setup: installing the local AI engine (one time, fully automatic)."*
ComfyUI has no equivalent, so a fresh buyer who never opens Settings
and asks for a picture gets a dead end:

> "ComfyUI is not running and the hidden backend is not installed.
> Install it in Settings → ComfyUI → 'Install hidden backend', or
> launch your own ComfyUI."

Grounded and actionable — and still a manual step in a product whose
stated requirement is that there are none.

**Two halves, and the second is the one that removes the dead end:**

1. **First-run install**, alongside the engine, in the shape §13a
   assumes. Do NOT simply extend `autoBootstrap`'s existing trigger:
   it fires on panel open, and a multi-gigabyte download on open for a
   feature many buyers never touch is a worse default than the button.
   The engine is core (no chat without it); the backend is not.
2. **Install-on-demand at the refusal.** `ensureRunning`'s
   `if (!install)` branch (`comfy.js:2124-2130`) is the exact point
   where the panel knows the backend is missing AND that the user just
   asked for a generation. Install there, with progress in chat, then
   boot and continue — instead of refusing. This is the half that also
   covers a panel installed before 17b shipped, and a first-run install
   that failed or was cancelled.

Verification: delete `<dataRoot>\vendor\comfy`, open the panel, ask for
a picture, and watch it install → boot → render with nothing pressed.
Then re-run with the download cancelled mid-way and confirm the panel
degrades honestly rather than half-installing. Bumps (`extension/`).

### 17c. Dogfood the shipped backend HERE (owner-approved 2026-09-06)

**PROMOTED 2026-09-06: this and §17a are now the top of the queue.** The
owner answered §18's backend question with *"no, build the portable
first"* — the loop may NOT use his ComfyUI on 8000 unattended. So §17a
then §17c gate every local pass in §18, and after them the loop boots
its own backend and takes every reading on the environment a buyer gets.

**The owner's reasoning, which is the whole item:** *"how can we be sure
comfy works on other users if we don't test it here? we should change my
special bypass to just also install a portable comfy like a user would."*

Every ComfyUI measurement this repo holds — krea2's 24,160 MiB, the
/free behaviour, the weight-availability verdicts, the handoff peak —
was taken against the owner's own hand-built ComfyUI 0.32.0 in
`Documents\ComfyUI`, launched by hand with `--base-directory` and a
port a buyer will never have. **No buyer runs that.** The vendor
portable build ships its own python and torch, and torch version is
exactly what §13a's wheel selection keys on, so "it worked here" has
never been evidence about the shipped path.

**The space objection is answered, and it was the only real one.** The
owner's stated reason for using their own install is disk space. The
weights do not have to move or duplicate:

- `applyExtraModelPaths` (`comfy.js:1985`) writes
  `<vendor>\comfy\ComfyUI\extra_model_paths.yaml` from
  `comfyModelsDir` + `comfyModelRoots` + the Comfy-Desktop shared store
  it finds on its own. Point `comfyModelRoots` at
  `Documents\ComfyUI\models` and the vendor backend SEARCHES the ~26 GB
  already on this disk without copying a byte.
- New weights land in `comfyModelsDir` if set, else
  `<vendor>\comfy\ComfyUI\models` (`setup.js:669-694`) — one folder,
  deletable.
- `removeCatalogWeights` (`tools.js:1527`) **refuses to delete anything
  outside a panel-managed folder**, so the Settings Remove button
  cannot touch the owner's own store while cleaning up test downloads.
  Exercising that refusal in the field is already §7b's fourth bullet.

So the standing cost is the portable runtime (python + torch + CUDA
libs), not the models. **Record its real extracted size in the log —
nobody here has measured it**, and the number decides whether this is a
permanent arrangement or a per-test one.

**17a makes this FREE, and that is the argument for doing 17a first.**
Written before 17a existed, this item carried a manual step: the
owner's own ComfyUI had to be genuinely stopped, or `ensureRunning`
step 1 would use it (same port) or step 2 would refuse with a hint
(other port) and the vendor backend would never boot. **Under 17a that
step disappears** — managed mode owns its own port and ignores foreign
instances by design, so the owner's ComfyUI can stay up on 8000 and the
panel still exercises the shipped path beside it. The dev machine stops
being a special arrangement and becomes a `"managed"` user like every
buyer, with `"own"` one deliberate toggle away when the owner wants
their install back.

**The pass (assumes 17a; if taken before it, stop the owner's ComfyUI
first and say so in the log):**

1. Confirm `comfyBackend` is `"managed"` and note what the migration
   chose, with `loadedFrom` — a default must not read as an answer.
2. Settings → Install hidden backend (or, once 17b lands, just ask for
   a picture). Log the download size, the extracted size, the ComfyUI
   version, and the torch/python the build pins — the last is §13a
   step 1's measurement, taken for free here.
3. Set `comfyModelRoots` to the existing stores; verify the written
   yaml and that `Comfy.missingWeights` answers empty for KREA2.
4. Re-run `scripts/weight-availability-probe.js` and one real
   `comfy_generate` end to end through the panel — with the owner's own
   ComfyUI still running, which is the row that proves 17a.
5. Log what the buyer path does that the owner's install never did.

After this, §7b's bullets are loop work: the loop boots its own backend.

### 17d. What must be RE-measured once 17c lands

Not a rewrite of the numbers — a marked re-take, because the
environment changed underneath them:

- **krea2's 24,160 MiB** (`version.js`, `measured: true`) was taken on
  the owner's torch build. Re-run `catalog-vram-probe.js` on the vendor
  backend; if it moves, the entry carries the vendor reading and the
  old one goes to the log with its environment named.
- **The /free finding** ("0 MB delta, this backend drops the generation
  on its own ~10 s before the round ends") is a property of a specific
  ComfyUI version. Re-check on the vendor build before trusting the
  resume path's floor logic there.
- **§13a step 7's tier consequences** inherit this: any VRAM threshold
  calibrated on the owner's environment is calibrated on the wrong one.

Do NOT re-measure by reasoning about version differences. Re-run the
probes.

## 18. A basic working graph for EVERY catalog model — PLANNED 2026-09-06

**Authoritative document: `docs/proposals/comfy-templates-PLAN.md`.**
Read it before starting any pass here — it carries the citations, the
per-entry table, the verification chain and the reasoning. This section
is the queue view. Planned by an adversarial pass (five readers, three
drafts, three judges, five skeptic lenses + a critic; 79 findings) and
re-verified by hand; PLAN §0 lists what it overturned.

**Owner, 2026-09-06:** *"keep it strict and basic proof of function for
now, while laying the foundation for more complex workflows in the
future arranged and accessible via the plugin UI."* Two halves, kept
distinct: BASIC templates that provably render NOW; a FOUNDATION (one
manifest-driven describer feeding the default choice and a Settings
Workflows list) that later complex workflows plug into by editing a
manifest and a graph, not panel code.

### Two corrections to what this section said yesterday

- **"Manifests need `sizeMB`" was STALE.** `genNeedMBFor`
  (`tools.js:1579-1596`) prices off the DISK since 0.10.9; `sizeMB` is an
  optional override. What must be right is `file` + `dir`.
- **"H3 may have no t2v path" was WRONG.** `procedural.firstFrame.detachable`
  deletes the LoadImage node when no image is given and runs
  text-to-video (`comfy.js:495-525`, landed 2026-08-26); the first
  end-to-end render on 2026-08-27 (LOG 2445-2515) passed no image. H3
  lacks a MEASURED block, not a t2v path.

### The gap (unchanged, counted)

Seven entries, two templates: sd15, sdxl, ltx-small, wan22-5b,
minimax-h3-int8 have none; minimax-h3 = `AE_LLAMA_H3_I2V_V1` (i2v AND
t2v via detach); krea2 = the owner's authored graph. Nothing catches it:
**(As counted 2026-09-06. Closed since, except the two owner-gated
seat: sd15 P5, sdxl P6, wan22-5b P7, krea2 P8, minimax-h3 P9 and
minimax-h3-int8 P10 all ship core-only basics now, so
`ALLOW_NO_TEMPLATE` is down to `[ltx-small]` and the only entry with no
graph is the one with no weights. Both authored graphs have left the
bundle. The count below is the original statement of the gap, kept
because the reasoning under it is what the section is for.)**
`test-model-catalog.js:229` skips entries with no template, `recommendGen`
never checks renderability, and the nameless default is ALPHABETICAL
(`tools.js:1958` `chosen = list[0]` — "a red apple" goes to the 40 GB H3
video graph today). `catalog-vram-probe.js:282` refuses entries with no
graph, so §7b's VRAM readings are blocked on this section.

### The contract (PLAN §2)

`AE_LLAMA_<MODEL>_<MODE>_V1`, API format, core nodes only, authored from
the RUNNING backend's `/object_info` — never from memory. README
injection contract: CLIPTextEncode via the sampler's links, exactly ONE
width+height node, a literal numeric `length` for video, `SaveVideo`
mp4/h264, seeds pinnable, relative `filename_prefix`, weight filenames =
the entry's `urls[]` basenames. Manifest: `kind` (its first consumer),
NEW `catalogEntry`, `models[{file, dir, role, optional?}]`,
`procedural.firstFrame` only when `/object_info` says the image input is
optional (detachable) or required (true i2v). Frozen once shipped;
refinements are SIBLINGS under new names.

Selection when the model names none: kind from `frames`/`durationSeconds`
→ described workflows of that kind, enabled, `requiresImage` excluded
without an image → ordered `Tiers.entryFits` first, then weights on
disk, then highest `minVramGB`, then name → manifest-less templates
after those → grounded error. Zero prompt bytes.

### Per entry (PLAN §3)

| entry | what | order |
|---|---|---|
| sd15 | `AE_LLAMA_SD15_T2I_V1` — the `example-txt2img` shape with the real ckpt; KSampler / CheckpointLoaderSimple are NOT in the harvest, confirm every input from `/object_info` | 1 |
| sdxl | same shape, ckpt swap | 2 |
| minimax-h3 | exists; regression re-run + the missing measured block; `catalogEntry` | 3 |
| wan22-5b | `AE_LLAMA_WAN22_5B_T2V_V1` — loaders are in the harvest, the 5B latent/sampler classes are not; `/object_info` decides one graph (detachable) or two | 4 |
| krea2 | exists; `catalogEntry` only | done |
| minimax-h3-int8 | probably the H3 graph with one encoder swapped via `adapt --manifest` setInputs — CONFIRM from the UI source | owner Q2 |
| ltx-small | no urls, no graph — pin or drop | owner Q1 |

### Verification (PLAN §5) — the parts that run with no backend

`tests/test-workflow-bundle.js` (new): every non-example template has a
manifest with `kind`, `catalogEntry`, `dir ∈ Comfy.MODEL_SUBS`,
non-optional model basenames ⊆ the entry's urls/files (the shipped H3
manifest's OPTIONAL lora is why "optional" is exempt — the draft rule
would have gone red on night one); `procedural` targets exist; replay
`injectParams` over the real file and assert prompt / seed / size landed
via `_graphCarriesValue` (export it in P1); video graphs carry SaveVideo
mp4/h264. `test-model-catalog.js:229` flips to assert with two allowlists
that fail BOTH directions: `ALLOW_NO_TEMPLATE` (the five) and
`ALLOW_UNMEASURED` (`minimax-h3`) — existence is not proof.
`test-comfy-workflow-choice.js` re-pinned; a `comfyWorkflows.enabled`
migration stub; context budget unchanged.

Per template with a backend: `weight-availability-probe` (prices,
refuses nothing) → `comfy-probe --no-ae` (the server's own validation IS
the `/object_info` check) → `catalog-vram-probe --entry` (reading into
the LOG; `measured: true` ONLY from the vendor backend, §17c/§17d) →
`comfy-probe --workflow` (9 verdicts incl. AE import) → `chat-probe
--steps 12,13`. **Gate 0 of every local pass:** print `Settings.origin()`
and refuse when `appdata` is empty.

### OWNER DECISIONS — ALL ANSWERED 2026-09-06

Q5 **build the portable backend first** — the owner's ComfyUI on 8000 is
REFUSED for unattended work, so §17a then §17c gate every local pass
here. Q1 ltx-small **postponed** (permanent seat in `ALLOW_NO_TEMPLATE`).
Q2 h3-int8 **yes, download the 26 GB encoder**. Q3 refinement returns as
a NEW file — **yes**. Q4 KREA2 enhancer lines — **strip**. Q6 **build
basics for every entry**, krea2 and h3 included.

**The reframe that came with Q6, and it is bigger than Q6** (owner's
words): *"build basic ones and redefine my supplied one as alternate
custom additions just for me for now. I want to fully build the user's
environment and think of mine as another level on top of that that's
separate."*

The product's baseline is the core-only basic set. The owner's authored
graphs become a personal layer, **per entry and only after that entry's
basic has rendered** — removing one earlier would leave its entry with
no graph, the defect this section exists to close. His copies survive:
`ensureDataDirs` (`setup.js:84-116`) seeds, refreshes and preserves and
has NO delete path (verified), so a file already in
`%APPDATA%\AE-Llama\comfy-workflows` outlives its removal from the
bundle. Two consequences worth their own lines:

- **`resolveWorkflow` needs a deliberate baseline tiebreak.** On a
  machine holding both layers, same entry / fit / weights, §2's ordering
  falls through to NAME — `..._T2I_V1` beating `..._V1` alphabetically
  is luck. Prefer the template the catalog entry's `workflowTemplate`
  names. No new manifest key.
- **`package-zxp.ps1:72-77` excludes only `.debug`, `vendor`, `models`,
  `generated`** — so ~200 KB of the owner's authored UI graphs ships
  inside every buyer's ZXP today and nothing at runtime reads that
  folder (verified: no reference in any `extension/js/*.js`). P11.

### Passes — one per night, smallest first (PLAN §6)

### 17e. A non-NVIDIA buyer is handed the AMD runtime, silently

**MEASURED 2026-09-06** against ComfyUI v0.34.0's real asset list (read
off the live release endpoint on the owner's machine while un-blocking
§17c): the release publishes `..._amd.7z`, `..._intel.7z`,
`..._nvidia.7z` and `..._nvidia_cu126.7z` — **and no cpu build at all.**

`pickComfyAsset` (`setup.js:975-983`) looks for a `cpu` asset twice and
then falls back to `/portable.*\.7z$/i`, which takes the FIRST portable
in list order. Run against the real list, `hasNvidia:false` returns
**`ComfyUI_windows_portable_amd.7z`**. So an Intel-GPU or GPU-less buyer
downloads ~1.7 GB of the AMD runtime and nothing says so.

It hid because the test fixture INVENTED the missing asset
(`test-comfy-backend.js:44` shipped a `..._cpu.7z` that does not exist)
and then asserted the picker chose it — a stub unfaithful in exactly the
place that decides the branch. Both real-list outcomes are pinned there
now, the wrong one labelled as this item rather than as correct, so a
fix visibly flips it.

**Not fixed on reasoning, because the right answer needs one fact this
repo does not have.** `detectGpu` returns `hasNvidia` and nothing about
AMD vs Intel vs none, so there is no way to route an Intel machine to
the intel build today. And whether a wrong-vendor portable still runs on
CPU is unmeasured — if it does, the current behaviour is merely
undisclosed; if it does not, it is a dead install. Ordered:

1. Extend `detectGpu` to name the vendor (it already shells to
   nvidia-smi; a WMI `Win32_VideoController` query answers the rest).
2. Route amd / intel / nvidia by that vendor.
3. For "no GPU we can name", REFUSE with what IS available rather than
   guessing — the grounded-error rule. A generation backend the buyer
   cannot run is worse than an honest "this needs a supported GPU".
4. NVIDIA sub-choice: the list carries `nvidia` AND `nvidia_cu126`, and
   `pickComfyAsset` ignores `detectGpu`'s `cudaVersion` entirely. The
   plain build is right for a recent driver (it is what the owner's 5090
   gets, verified); an old driver may need cu126. Same class 0.10.16
   fixed for llama.cpp, unmeasured here.

Remote-buildable except step 4's verification, which needs an old
driver. Does NOT block §17c: the owner's machine is NVIDIA and picks
correctly.

**The `/releases/latest` risk is SETTLED — no walk needed.** Measured
2026-09-06 on the owner's machine: ComfyUI's latest is **v0.34.0,
`prerelease: false`, carrying all four portable `.7z` assets.** So
`bootstrapComfy`'s single-release read (`setup.js:1045`) works as
shipped, unlike llama.cpp's, which 0.10.16 had to replace with a release
WALK after `/releases/latest` answered v0.3.0 with no Windows binaries.
Verified further by running the real `pickComfyAsset` against the real
list: an NVIDIA machine gets `ComfyUI_windows_portable_nvidia.7z` (2 GB,
the newest-CUDA build — right for the 5090), pinned in
`test-comfy-backend.js`. The non-NVIDIA branch is NOT fine — see §17e.

**Backend rule: ONE route.** §17a then §17c come first; after them the
loop boots the MANAGED backend itself (`--boot`/`--stop`, non-8000
port), ignores the owner's instance by design, and every reading is
taken on what a buyer gets — so nothing measured after §17c needs a
§17d re-take. **Nothing local starts before §17c is green.**

| # | who | what | bump | needs |
|---|---|---|---|---|
| **§17a** | remote | managed backend by default: `comfyBackend`, own port, refuse-not-attach, `findLocalComfy` as an offer, migration on `loadedFrom` | yes | — |
| **§17c** | local, LOOP-TAKEABLE | `node scripts/comfy-install.js --boot` (headless, 0.12.0); then `comfyModelRoots` at the existing stores; record the extracted size and the python/torch it pins (= §13a step 1) | no | §17a; ~10 GB free. The release carries a portable asset (VERIFIED, below), and the detached loop now carries APPDATA (below), so gate 0 no longer refuses |
| ~~P0~~ | remote | **DONE 2026-09-06.** `test-workflow-bundle.js`, two both-directions allowlists in `test-model-catalog.js`, manifests walk | no | — |
| ~~P1~~ | remote | **DONE 2026-09-06 (0.12.1).** `describeWorkflows` + `resolveWorkflow` with the baseline tiebreak; the alphabet no longer picks; `comfyWorkflows` setting; `catalogEntry` on both manifests; `test-workflow-resolve.js` (22 rows) | yes | P0 |
| ~~P2~~ | remote | **DONE 2026-09-06.** `--frames`/`--boot`/`--stop` on both probes, `scripts/lib/comfy-managed.js`, `download-gen-weight.js`, chat-probe kind verdict, gate 0. Also fixed: both probes read `comfyUrl` where §17a had moved the answer to `backendUrl` | no | P1 |
| ~~P3~~ | local | **DONE 2026-09-09 (0.12.9).** t2v re-run 9/9 earlier the same day; the measured block is now written from two repeatable `--duration 2` runs (26 969 / 26 944 MiB, 80 s, 1344x768 x 56f) | 0.12.9 | — |
| P3a | local + OWNER | **(a) DONE 2026-09-09** — the row quotes 2 s and states the authored 15 s beside it, enforced against the template itself. **(b) capping the injected default is the owner's** | (b) yes | — |
| ~~P3b~~ | local | **DONE 2026-09-09 (0.12.16).** Step k/N and an ETA through `onProgress`, over a hand-rolled RFC 6455 client (no REST route carries progress). `tests/test-comfy-progress.js` pins the decoder, the tracker, the wiring and the survival rule. §18 P3c filed | 0.12.16 | — |
| P3c | local | the ETA the panel now quotes can exceed `comfyTimeoutSec`, so it promises a finish it will then cancel | yes | P3b |
| ~~P4~~ | remote | **DONE 2026-09-06 (0.12.2).** Settings **Workflows** rows via the pure `Tools.workflowRows()`; `test-workflow-rows.js` (21 rows) | yes | P1 |
| ~~P5~~ | local | **DONE 2026-09-09 (0.12.10).** sd15 basic + manifest + `workflowTemplate` + hash + allowlist −sd15 + a measured block; the frontend measurement is **YES** (§18 P5b). §18 P5a filed | 0.12.10 | — |
| ~~P6~~ | local | **DONE 2026-09-09 (0.12.11).** sdxl basic + manifest + `workflowTemplate` + hash + allowlist −sdxl + a measured block; the gate moved 6 -> 12 on the measurement and `slowBelowGB` went with it. §18 P6a filed | 0.12.11 | — |
| ~~P7~~ | local | **DONE 2026-09-09 (0.12.12).** wan22-5b basic + manifest + `workflowTemplate` + hash + allowlist −wan22-5b + a MEASURED block; `--frames` verified through `comfy-probe --frames 25` (640x384, 1.042 s @ 24 fps, imported into AE); the floor re-pin moved BOTH 8 GB pins. §18 P6a closed, §18 P7a (owner) and §18 P7b filed | 0.12.12 | — |
| ~~P8~~ | local | **DONE 2026-09-09 (0.12.13).** krea2 basic + manifest + `workflowTemplate` + hash + a RE-MEASURED block (18 848 MiB / 8 s at 1920x1080, gate unchanged at 24); the authored `AE_LLAMA_KREA2_V1` moved to `tests/fixtures/authored-krea2/` and the three probe scripts that DEFAULTED to it now default to the basic. §18 P8a filed | 0.12.13 | — |
| ~~P9~~ | local | **DONE 2026-09-09 (0.12.14).** H3 basic + manifest + `workflowTemplate` + hash + a RE-MEASURED block (26 080 MiB / 253 s at 1344x768 x 124 f, gate unchanged at 32); the authored `AE_LLAMA_H3_I2V_V1` moved to `tests/fixtures/authored-h3/` and the two probe scripts that DEFAULTED to it now default to the basic. `authoredNote` removed -- measured == authored at last. §18 P9a filed | 0.12.14 | — |
| ~~P10~~ | local | **DONE 2026-09-09 (0.12.15).** h3-int8 basic + manifest + `workflowTemplate` + hash + allowlist −minimax-h3-int8 + a MEASURED block (26 048 MiB / 259 s at 1344x768 x 124 f, gate unchanged at 32). The UI-source confirmation came back negative (no vendor template names the int8 encoder), so the graph is the nvfp4 sibling with one input swapped and the proof is a render. Two new stub rules pin the pair: no two templates share a `filename_prefix`, and the H3 siblings may differ in exactly the encoder and the prefix. §18 P7b confirmed with a number | 0.12.15 | — |
| P11 | remote | `package-zxp.ps1` `$excludeDirs` += `workflows` | yes | — |
| ~~P12~~ | remote | **DONE 2026-09-09.** All three allowlists have reached the size this item asked for. `ALLOW_UNMEASURED` is `[]` (minimax-h3 was its last seat, P3). `GATE_UNDER_ITS_BIGGEST_FILE` is `[]` (wan22-5b was its only seat, §18 P6a, closed by measurement). `ALLOW_NO_TEMPLATE` reached `[ltx-small]` and STOPPED there — sd15 left in P5, sdxl in P6, wan22-5b in P7, minimax-h3-int8 in P10. ltx-small's seat is the one Q1 covers (it has `urls: []`, so there is nothing to download and nothing to render); emptying it is the owner's call, not a pass's. Every list now fails in both directions, so none may grow without a log entry | tests only | P5–P10 |

### Hooks, named so nobody builds them early

`procedural.denoise` / `maskImage` / `audio`; `want.requiredInputs`;
stored default per kind; feed `comfyCatalog` guard (no producer exists);
`catalog-vram-probe --out docs/measured/` for §13a step 4; renderable
predicate on `recommendGen`; `video: [names]` on `comfy_list_workflows`
only if the chat-probe verdict shows the model needs it.

## ~~18 P6a. wan22-5b's VRAM gate is under its own biggest weight file~~ DONE 2026-09-09 (filed and closed the same day, local session)

**CLOSED by §18 P7's measurement, and the answer was worse than the
filing guessed.** Two runs of the shipped `AE_LLAMA_WAN22_5B_T2V_V1` on
the managed backend cost **26 187 and 24 576 MiB** (127 s each, 1280x704
x 121 frames) — not "a gate slightly under one file" but a gate under
the job by a factor of three. `minVramGB` is **32**, `measured: true`,
and the `GATE_UNDER_ITS_BIGGEST_FILE` seat is gone (the list is empty and
stays checked in both directions).

**Step 3's last clause happened, so it is now its own item: §18 P7a.** A
third run settled it with evidence rather than argument — at 704x480, a
THIRD of the pixels, the same graph still cost 21 536 MiB, because the
floor is the 17 304 MiB of resident weights and not the frame. So no
width, height or length the panel can inject fits this entry on a card
under 24 GB, and both 8 GB pins moved to `ltx-small` with their reasons.

_Original filing below, kept because it is the reasoning that found it._


**Found by the stub written for §18 P6, not by a GPU.** `wan22-5b` ships
`minVramGB: 8` (8192 MiB) and three weight files of 9536 / 6424 / 1344
MiB. Its largest single file is **9536 MiB — larger than the entire card
the gate admits.** Nothing lets a sampler hold less than its one biggest
tensor file, and 0.10.14 measured what this backend does when a job
outgrows the card: it does not OOM, it GRINDS. So an 8 GB buyer is
offered Wan as their *video* default (pinned in `test-tiers.js`) and gets
minutes-per-frame.

This is the same class as sdxl's, which §18 P6 measured and fixed the
same day: a `minVramGB` written from training, exempt from the one check
that would have caught it because that check only fires on
`measured: true`. `tests/test-model-catalog.js` now checks it for
UNMEASURED entries too, via the largest-single-file rule, and wan22-5b
holds the list's only seat:

    const GATE_UNDER_ITS_BIGGEST_FILE = ["wan22-5b"];

**The seat is both-directions, so this item cannot be closed by forgetting
it** — correcting the gate must also remove the name, and no new entry can
quietly join the list.

**Not fixed on reasoning, deliberately.** The right gate is a
measurement, and item 5 (§18 P7) is already going to boot this entry to
author its basic t2v graph. Fold it in there rather than guessing a
number now:

1. Author `AE_LLAMA_WAN22_5B_T2V_V1` as P7 says.
2. `catalog-vram-probe --entry wan22-5b` twice; take the larger delta and
   the cold wall clock, as sd15 and sdxl did.
3. Set `minVramGB` from that reading, remove the `wan22-5b` seat from
   `GATE_UNDER_ITS_BIGGEST_FILE`, and move the `test-tiers.js` 8 GB video
   pin WITH ITS REASON if the gate now excludes an 8 GB card — the pin
   currently asserts "8 GB video is Wan 2.2 5B, not the experimental LTX",
   and if Wan no longer fits, an 8 GB buyer's video default becomes
   `ltx-small`, which is flagged `experimental` and has **no template at
   all** (a permanent `ALLOW_NO_TEMPLATE` seat, owner Q1). That would
   leave an 8 GB card with no runnable video graph, which is an
   OWNER-facing product question, not a test edit. Say so in the log and
   flag it rather than deciding it.

Step 3's last clause is the part that needs a human eye.

## 18 P7a. Every card under 32 GB now has NO runnable video graph — OWNER CALL (filed 2026-09-09, local session)

**This is the consequence §18 P6a step 3 said to flag rather than decide,
and the measurement that forced it is taken.** As of 0.12.12 the video
half of `COMFY_CATALOG` gates at:

| entry | minVramGB | template |
|---|---|---|
| `ltx-small` | 6 | **none** (permanent `ALLOW_NO_TEMPLATE` seat, owner Q1) |
| `wan22-5b` | **32** (was 8) | `AE_LLAMA_WAN22_5B_T2V_V1` |
| `minimax-h3` | 32 | `AE_LLAMA_H3_T2V_V1` (was the authored `AE_LLAMA_H3_I2V_V1`; §18 P9) |
| `minimax-h3-int8` | 32 | `AE_LLAMA_H3_INT8_T2V_V1` (§18 P10, measured 2026-09-09) — but gated at 32 too, so it does NOT narrow this gap |

So a 4090, a 4080, a 3090, a 4060 — every card below 32 GB — is
recommended `ltx-small` for video: an entry flagged `experimental`, with
`urls: []` and no graph. It cannot download and it cannot render. Both
8 GB pins (`test-tiers.js` and `test-model-catalog.js` recommendSetup)
now assert exactly that, with the reason inline, so the gap is visible
and cannot widen unnoticed — but asserting a gap is not closing it.

**The gate is not negotiable and re-measuring will not move it.** Three
runs, 2026-09-09, managed backend, RTX 5090: 26 187 MiB and 24 576 MiB at
the authored 1280x704 x 121, and **21 536 MiB at 704x480** — a third of
the pixels for a 20% saving, because this graph holds 17 304 MiB of
weights resident (fp16 diffusion 9536 + fp8 encoder 6424 + vae 1344) and
the frame is the small term. There is no size or length the panel can
inject that rescues a 24 GB card, let alone an 8 GB one.

**Four ways out, and choosing between them is the owner's, not a pass's.**
Each is a product decision about what a mid-range buyer is offered:

1. **Pin a smaller Wan build as a second entry.** Comfy-Org publishes
   `wan2.2_ti2v_5B_fp8_scaled` alongside the fp16 this catalog names, and
   `umt5_xxl_fp8_e4m3fn_scaled` is already the fp8 encoder. An fp8
   diffusion file roughly halves the 9536 MiB term. UNMEASURED — nothing
   here has run it, and the same "measure it, do not reason about it"
   rule that produced this item applies to that number too.
2. **Give `ltx-small` a real graph and real urls**, which is owner Q1
   reopened: it was postponed on 2026-09-06 when it was the fallback for
   6 GB cards only, and it is now the fallback for everything under 32.
3. **Recommend nothing for video below 32 GB** and say why. The
   grounded-error rule prefers an honest "your card cannot run any video
   model this panel ships" to a recommendation that cannot execute — and
   `recommendGen` returning `null` for video is already a supported shape
   (`test-tiers.js` pins it for a 4 GB card).
4. **Accept the grind and gate Wan lower with a disclosure**, the way
   `slowBelowGB`/`slowNote` used to. Note that §18 P6 deliberately
   REMOVED that pair from sdxl rather than re-tune it, so bringing the
   mechanism back is itself a reversal that needs saying out loud.

Options 1 and 2 need a download and a measurement; 3 and 4 are repo-only.
**Do not pick one in an unattended pass.**

## 18 P7c. MEASURE both low-VRAM video candidates (owner-approved 2026-09-09, takeable)

**Owner's call, 2026-09-09: do options 1 AND 2 of §18 P7a.** "I want to
be able to give even the lowest end cards an option here if they're able
to have one." The last clause is load-bearing: if nothing fits, that is a
RESULT, not a failure, and §18 P7a option 3 becomes the answer.

**Measuring is not deciding.** P7a says do not pick an option in an
unattended pass, and that stands. This item takes the numbers so the
owner's choice is arithmetic instead of judgement. Ship/don't-ship stays
in P7a.

**The 5090 answers the small-card question.** §18 P7 established the
floor is RESIDENT WEIGHTS, not the frame: 704x480, a third of the pixels,
still cost 21 536 MiB against 26 187. So a resident-weight measurement on
this machine tells you whether a model fits 8 or 12 or 16 GB. No low-end
card is needed, and none is available.

**The rule that produced this whole item applies to its own output: the
MEASUREMENT sets the gate.** `wan22-5b` shipped `minVramGB: 8` written
from training and it was 32. Do not write a gate from a model card, a
README, or a parameter count. If a candidate measures at 14 GB, the gate
is 14.

### Step 1 - fp8 Wan 2.2 5B (cheapest, do this first)

Comfy-Org publishes `wan2.2_ti2v_5B_fp8_scaled` beside the fp16 this
catalog names; `umt5_xxl_fp8_e4m3fn_scaled` is already the fp8 encoder.
The fp16 diffusion term is 9536 MiB of the 17 304 MiB resident floor, so
fp8 should roughly halve it.

This is the §18 P10 pattern exactly: a SECOND catalog entry whose graph is
the shipped `AE_LLAMA_WAN22_5B_T2V_V1` with the diffusion filename
changed and NOTHING else, verified node by node, then measured with
`catalog-vram-probe`. h3-int8 was built that way in one pass.

Do NOT replace the fp16 entry. Both stay; `entryFits` and the tie-break
already handle two entries of one kind at different floors.

### Step 2 - settle what "ltx-small" even IS, before pinning anything

`ltx-small` in `COMFY_CATALOG` is `minVramGB: 6, measured: false,
sizeMB: null, urls: [], experimental: true` and has no graph. Measured
2026-09-09, it does not correspond to anything the vendor backend ships:

The vendor carries SIX LTX blueprints, all 2.0 or 2.3. Its
`blueprints/Text to Video (LTX-2.3).json` names
`ltx-2.3-22b-dev-fp8.safetensors` (a **22B** diffusion) plus
`gemma_3_12B_it_fp4_mixed.safetensors` (a **12B** text encoder), a
distilled LoRA and a spatial upscaler. **That is LARGER than Wan 2.2 5B,
not smaller** — it belongs in the 32 GB bracket and rescues nothing.

So the entry is imagining the older LTX-Video 2B line (0.9.x), which the
vendor ships no blueprint for. Before pinning weights, answer in order:

1. **Does this backend still have the LTXV nodes a 2B graph needs?**
   `scripts/comfy-node-defs.json` reports ZERO nodes matching "ltx",
   which CONTRADICTS the vendor's own blueprint using
   `EmptyLTXVLatentVideo`. That fixture is the §17l defect in the flesh —
   a hand-taken snapshot that has drifted. **Ask a RUNNING backend's
   `/object_info`, never the fixture**, and fix or refresh the fixture
   while you are there.
2. If the nodes exist, pin a specific LTX-Video 2B build and author a
   basic graph the same way §18 P5-P10 authored six others.
3. Measure it. If it lands under 12 GB this closes the gap the owner
   asked about; if it lands at 24, say so and stop.

### Step 3 - report, do not choose

Write both floors into the log and into P7a as a table. If neither
candidate fits 8 GB, say that plainly — P7a option 3 (recommend nothing
for video below the floor, and say why) is a legitimate outcome and the
grounded-error rule already prefers an honest refusal to a
recommendation that cannot execute.

### Worth noting for a separate item

The vendor also ships `Image to Video (LTX-2.3).json`. **§18 P9a** is
"no shipped template can take a reference image any more". If LTX is
pinned for any reason, i2v may come with it and close two gaps at once.
Do not let that widen this item; note it and move on.

## 18 P7b. `download-gen-weight` re-downloads a file the backend already has (filed 2026-09-09, local session)

**Measured while taking §18 P7's weights.** `wan22-5b` names
`umt5_xxl_fp8_e4m3fn_scaled.safetensors`, and that file was ALREADY on
this machine — in `comfyModelRoots`
(`C:UsersmrDocumentsComfyUImodels	ext_encoders`), where
`extra_model_paths.yaml` points the managed backend, and the running
backend was already LISTING it in `/object_info/CLIPLoader`. It was
downloaded again anyway: 6424 MiB, into the vendor's own models tree.

The cause is one line. `Setup.downloadGenWeight` (`setup.js:714`) asks
`fs.existsSync(dest)` about the ONE path it chose and nothing about the
roots the backend actually searches:

    if (fs.existsSync(dest)) { cb(null, dest); return null; }

So "do I have this weight" is answered against one folder while "can the
backend load this weight" is answered against several — the same
two-sources split `genNeedMBFor`'s neighbouring comment already
describes for SIZE (`tools.js:1598-1620`), reappearing for EXISTENCE.

Cost, per buyer with a pre-existing ComfyUI: a duplicated download and a
duplicated copy on disk, silently. `minimax-h3-int8` (§18 P10) names a
**26 GB** encoder, so this is not a rounding error for long.

**CONFIRMED, with a number, 2026-09-09 while taking §18 P10 — and the
sharpest statement of it is not "a duplicate download" but "two scripts
in this repo disagree about whether a file exists."** Within one minute
on one machine, `catalog-probe.js` reported three of `minimax-h3-int8`'s
four weights as `[disk]` and printed their paths under
`C:\Users\mr\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models` (a
`comfyModelRoots` root the backend loads via `extra_model_paths.yaml`,
and one the running backend was listing in `/object_info`), while
`download-gen-weight.js --entry minimax-h3-int8 --check` reported all
FOUR as `MISSING`. Both are reading the same disk; only one of them
knows about the roots. So the pass that needed 25 884 MiB would have
been handed a **51 427 MiB** download — 25 543 MiB of it a second copy
of files the backend already had. This pass fetched the one missing file
directly and left the rest alone, so the waste was avoided by NOT using
the panel's own downloader, which is the wrong way round.

That also gives the fix a free oracle: `catalog-probe.js` already
resolves a catalog file against every root correctly. Whatever
`downloadGenWeight` grows should agree with it, and a stub test can
assert exactly that — the two answers must match for every catalog
entry, which is a rule that keeps holding after this bug is gone.

The fix is small and needs no backend: check every configured root for
`dir/basename` before choosing `dest`, and when a copy is found, say
where it is and skip. Two traps for whoever takes it — (a) a root may be
a whole `models` tree OR a per-kind `kind=path` line (`comfy.js`
`applyExtraModelPaths`), so resolution must go through the same rule, not
a hand-rolled join; (b) skipping on NAME alone is what the panel already
does elsewhere and is right here, because ComfyUI itself resolves by
name — a same-named different file is already indistinguishable to the
backend, so this changes nothing about that.

Stub-testable end to end: two fake roots, one holding the file, and
assert no download is attempted. No GPU, no network.

## 18 P8a. Two catalog entries are exempt from the gate rule, because their weights carry no sizes (filed 2026-09-09, local session)

**Found while re-measuring krea2 for §18 P8.** §18 P6's back-fill gave
`test-model-catalog.js` a rule that can price a gate with no GPU and no
backend: **`minVramGB` must hold the biggest single weight file the graph
loads.** It is the check that caught sdxl's 6 GB gate under a 6617 MiB
checkpoint, and wan22-5b's 8 GB gate under a 9536 MiB diffusion file.

It cannot ask the question of `krea2` or `ltx-small`: both carry
`sizeMB: null`, an empty `urls: []`, and `files:` as a list of BARE
NAMES with no sizes attached, so there is nothing for the rule to compare
a gate against. It prices off `urls[].sizeMB` and returns early
(`if (!sizes.length ...) return;`) when there is none.

That skip was SILENT until tonight, which is the repo's own recurring
defect — a check that answers "this is fine" and "there is nothing here
to check" identically. **Half of this is already done (0.12.13):**
`NO_FILE_SIZES_TO_CHECK = ["krea2", "ltx-small"]` in
`tests/test-model-catalog.js` now names them and fails in BOTH
directions, so an entry cannot join them quietly and krea2's seat must go
the moment its files carry sizes. Negative control run: giving krea2 a
`urls[]` entry fails four assertions including this one.

What is left is the hole itself, and krea2 is the entry that shows why it
matters: its weights are **18 109 MiB** (measured off this disk by
`weight-availability-probe`, three files), its biggest single file is the
diffusion model, and its gate is 24 GB. It happens to pass. Nothing in
the repo knows that, and nothing would notice if the gate were edited
to 8.

**The work, in order:**

1. Give `krea2`'s three files their real sizes. The shape question comes
   first and it is not cosmetic: every other entry carries sizes on
   `urls[]`, and krea2 has no urls (owner-supplied weights, "download
   links ship via the update feed once pinned"). So either `files[]`
   grows from `["name.safetensors", ...]` to
   `[{file, sizeMB, dir}, ...]`, or the entry gains a parallel map.
   Whichever is chosen, `tools.js` `genNeedMBFor` / `catalogModelStatus`
   and `tests/test-workflow-bundle.js` read `files` today — check every
   reader before changing the shape.
2. Then delete krea2's seat in the rule's skip list, so the entry is
   policed like the others.
3. `ltx-small` KEEPS its seat in `NO_FILE_SIZES_TO_CHECK`: owner Q1
   postponed it, it ships no graph and no urls, and an entry with no
   files cannot have a biggest file. It is the permanent case; krea2 is
   the accidental one.

No GPU, no backend, no AE — the sizes are already on this machine and
`weight-availability-probe` prints them. Repo-only after that.

## 18 P9a. No shipped template can take a reference image any more (filed 2026-09-09, local session)

**Found by doing §18 P9, and it is that item's own cost.** The authored
`AE_LLAMA_H3_I2V_V1` was the LAST bundled graph declaring
`procedural.firstFrame`. It left the bundle for the core-only
`AE_LLAMA_H3_T2V_V1`, and measured after the move: **zero** of the five
shipped manifests declare `procedural.firstFrame`, and **no** shipped
graph contains a `LoadImage` node at all. So image-to-video and
image-to-image are both gone from the product as of 0.12.14.

**The panel is honest about it, which is why this is a gap and not a
bug.** `comfy.js:1882` refuses an image that lands on no node -- "the
upload succeeded, so everything up to here looked right, and the render
would finish as text-to-image, the reference silently ignored" -- and the
refusal names the templates that would accept one. That branch now always
takes its empty form: *"none of the templates alongside this one do"*.
The user is told the truth; they just cannot do the thing.

Pinned in BOTH directions so it cannot widen or close quietly
(`tests/test-workflow-bundle.js`): `IMAGE_CAPABLE_SHIPPED = []` fails if
the set changes either way, and a second assertion states the gap in
words so the failure reads as "P9a is closed now" rather than as a list
mismatch. Negative control run: declaring `procedural.firstFrame` on the
H3 basic turns both red. `test-comfy-image-landed.js` case 2 already
covered the empty-list REFUSAL, against a synthetic folder -- what
nothing said was that the real bundle is now that case.

**Two ways out, and they are not equal.**

1. **A sibling i2v file per video entry** -- `AE_LLAMA_H3_I2V_V2` and
   `AE_LLAMA_WAN22_5B_I2V_V1`, each a copy of its t2v basic with the
   optional image input wired and `procedural.firstFrame` declared.
   `first_frame` is OPTIONAL on `MiniMaxH3ImageToVideo` and `start_image`
   is OPTIONAL on `Wan22ImageToVideoLatent` (both measured from
   `/object_info`, 2026-09-09), so both models can do it today. The cost
   is the one the wan22-5b basic already wrote down: a `LoadImage` in a
   shipped API graph needs a filename that exists in the BACKEND's input
   folder or `validateGraphInputs` refuses the template before it is
   queued -- an API graph has no "muted". Whatever placeholder is chosen
   has to be one a fresh managed install actually has, and that is a
   measurement, not a guess.
2. **`firstFrame.detachable` on the existing t2v basics** -- one file per
   entry instead of two, the shape the authored H3 graph used: the panel
   DELETES the LoadImage when no image is given. Fewer files, but it
   makes every text-to-video render depend on a node that only exists to
   be removed, and it re-introduces the placeholder-filename problem for
   the t2v path as well, which is exactly what §18 P9 took out.

Option 1 is the recommendation: it keeps each basic a basic, and the
contract already says refinements arrive as SIBLINGS under new names.
Not done in this pass because it needs the placeholder measurement above
and §18 P9's rule is one template per pass, proven end to end.

## 18 P3a. H3's authored default is a >15-minute render, and that is what a
user who names no length gets (filed 2026-09-09, local session)

**Measured, on the machine, on the MANAGED backend a buyer gets.**
`catalog-vram-probe --entry minimax-h3` runs a template at its AUTHORED
settings on purpose, because that is what `comfy_generate` gives a user
who names no size and no length. For `AE_LLAMA_H3_I2V_V1` those settings
are node 136 = **15 seconds**, node 167 = **0.98 MP**, node 142 = **20
steps**, and node 135 turns 15 s x 24 fps into a **362-frame** latent.
On an RTX 5090 that job was **still sampling at 901 s** when the probe
cancelled it. 3511 nvidia-smi samples: idle floor 4857 MiB, peak
**30191 MiB** against a 32607 MiB card, 100% utilisation throughout.

**Two facts, and only the first is about VRAM.**

1. H3 FITS the card. No OOM, no page-thrash signature, peak 24.7 GiB
   over the floor with headroom left. Whatever the catalog's gate should
   say, 32 is not disproved.
2. The number cannot be MEASURED at that length inside an unattended
   pass, and more importantly a **user cannot sit through it**. Fifteen
   minutes-plus on the fastest card the catalog knows about, with no ETA
   from `comfy_generate` while it runs, is the panel's DEFAULT for a
   video request that names no duration.

**The decision, which is a product call and not the probe's to make:**

- **(a) Quote the catalog at a stated shorter length.** Take the reading
  with `catalog-vram-probe --entry minimax-h3 --duration 2` (56 frames,
  minutes not quarter-hours) and write `measuredAt` so it names the
  length as well as the frame — `tests/test-model-catalog.js` now
  REQUIRES that of a `kind: "video"` entry. Honest, cheap, and it leaves
  the 15 s default in place: the catalog then describes a job the user
  is not the one being given.
- **(b) Cap the duration the panel injects when the user names none.**
  A default the buyer will actually wait for (2-4 s), with the template's
  15 s reachable by asking for it. Changes panel behaviour, so it bumps,
  and it needs the owner — it is his authored graph's default being
  overridden.
- **(c) Both**, which is probably right: measure at the capped default,
  so the catalog quotes the job the panel actually runs.

Nothing here should be guessed at by an unattended pass on its own; but
(a) is takeable NOW and blocks nothing, and P3's measured block should
not be written from a run that never produced a file.

### (a) TAKEN 2026-09-09 (local session, 0.12.9). (b) is still the owner's.

The reading exists and it is repeatable: two runs at `--duration 2`, one
seed, on the managed backend — **26 969 and 26 944 MiB** over an
established idle floor (25 MiB apart), **80 s** each, 1344x768 / 56
frames out, peak 31 705 of 32 607 MiB. The higher is published, as
krea2's was. `minimax-h3` is now `measured: true` and
`ALLOW_UNMEASURED` is EMPTY.

**The (a)-only gap the filing warned about is closed structurally, not
by prose.** "The catalog then describes a job the user is not the one
being given" was the honest objection to (a) on its own, so the entry
carries `measuredClipSeconds: 2` AND `authoredClipSeconds: 15` and an
`authoredNote` naming the 15-minute default — and
`tests/test-model-catalog.js` reads the authored length out of the
entry's **own shipped API template** (node 136 via the manifest's
`procedural.durationSeconds` pointer), so the disclosure cannot drift
from the graph and a future short measurement cannot ship without one.

**The gate is unaffected either way.** 32 GB covers the 26.3 GiB
measured here and the >=24.7 GiB the cancelled 15 s run had already put
on the card.

**(b) — capping the injected default — is untouched and still needs the
owner** (NEXT UP 2a). It changes what his authored graph renders.

## 18 P3b. DONE 2026-09-09 (0.12.16) — a generation now says step k of N
and how long is left

Was: elapsed seconds every ten seconds and nothing else, ninety times over
on H3's authored 15 s clip, with no way to tell a job a tenth done from
one that had wedged.

**Where progress actually lives, measured on the managed vendor build
(ComfyUI 0.34.0) rather than assumed:** the websocket at `/ws`, and
nowhere else. `/history/<id>` is EMPTY until the job finishes; `/queue`
says only that something is running; and `/api/jobs/<id>` — the newest
route and the one that sounds like it should be the answer — serialises
status, timing and outputs with no `value`/`max` anywhere. There is no
REST route to poll, so the poll loop could not be extended and a socket
was the only way.

`extension/js/comfy.js` therefore speaks RFC 6455 itself over the http
Upgrade it already had a client for: Node 17 (CEP's) has no `WebSocket`
global, the browser one landed in Node 21, and a package would put the
first dependency into a panel that has none. ~90 lines, and it runs
identically in the panel and in a headless probe, which is what makes it
testable without AE.

What ships:

- `openEventSocket(base, clientId, onMessage)` — subscribes as the SAME
  client id the prompt is posted under, which is the only id ComfyUI
  addresses these events to. Opened BEFORE the queue POST (on a warm
  backend the first steps land in the same second) and closed on every
  exit path.
- `makeProgressTracker(promptId)` — `progress_state` (and the older flat
  `progress`) into `{value, max, node, etaSec}`. Of several running bars
  it takes the one with the most steps, so a VAE tile bar cannot make the
  fraction jump backwards.
- `Tools._generatingLine(elapsed, progress)` — the sentence.
  `ComfyUI still generating… 40s — step 13/20, about 16s left`.

Two rules that are the point of it, both pinned in
`tests/test-comfy-progress.js`:

1. **The ETA is measured from the first sampling STEP, never from
   elapsed.** Elapsed includes the model load, which is most of a minute
   on the video templates — `elapsed / value` would quote an estimate far
   past the truth on exactly the renders that need one.
2. **Both halves are omitted rather than guessed.** No progress event
   means no fraction (an old build, a refused upgrade); one step seen
   means no estimate. A wrong number here is the number the user decides
   to wait on.

Verified on the real backend, not just the stub: `comfy-probe --no-ae
--duration 2 --width 832 --height 480` (H3, 66 s) printed 10s bare (still
loading), then `20s — step 4/20, about 42s left`, `30s — step 8/20, about
31s left`, `40s — step 13/20, about 16s left`, `50s — step 17/20, about 7s
left`, `60s — step 20/20`. Sampling ended at ~57 s against the 42 s-left
quoted at 20 s.

**Root defect found en route:** the terminal SUCCESS path of
`Comfy.generate` latches `finished`/`clearInterval` by hand instead of
going through `settle()`, so anything `settle` is responsible for is done
only when a generation FAILS. It cost nothing before, because settle only
cleared a timer that path cleared too; it would have leaked one websocket
per successful generation for the life of the panel. Fixed at that path;
worth remembering that `settle` is not the single exit it looks like.

Harness 770/770, stubbed suite 89/89 green.

## 18 P3c. The ETA the panel now quotes can be longer than the timeout it will cancel at (filed 2026-09-09, local session)

Found by P3b, and it is P3b's own doing: until 0.12.16 the panel made no
promise about when a render would finish, so `comfyTimeoutSec` (600 by
default) could quietly cancel a long job and the only thing the user had
seen was a rising number. Now the panel says **"about 12m left"** and
then, at 600 s, cancels the job and reports a timeout — a contradiction it
put on screen itself, and the second half looks like a bug in the backend
rather than a setting the user could have changed.

The numbers are not hypothetical. H3's basic renders 124 frames in 253 s
at 1344x768 on a 5090; the same graph on a 32 GB card at a larger size, or
any of the video templates on the slowest hardware their gate allows, goes
past 600 s. The default has simply never been tested against a template
whose measured time is now known — every §18 P5-P10 entry carries one.

What to do about it, cheapest first (a pass may take the first two; the
third is an owner call):

1. **Say it, at the moment it becomes true.** When
   `elapsed + etaSec > timeoutSec`, the progress line stops promising and
   starts warning: name the setting and the number, once, not every ten
   seconds. Grounded-error rule — the refusal must say what the current
   value is and where to change it.
2. **Make the timeout's own message carry the estimate it had.** Today it
   says "timed out after 600s"; it should say the job was N% in and was
   projected to need M more, so the user knows they hit a limit rather
   than a hang. Everything needed is already in the tracker.
3. **Reconsider the 600 s default against the measured catalog** —
   OWNER. Every catalog entry now has a measured render time; the
   default could be derived from the chosen template's own measurement
   plus a margin instead of being one number for all of them. That
   changes behaviour for existing users, so it is not a pass's call.

Bumps. Loop-takeable for (1) and (2).


## 18 P5a. A manifest's positional `widget: N` silently lands on the wrong input (filed 2026-09-09, local session)

**MEASURED, and it cost a GPU render to find.** The sd15 basic was
authored with `procedural.resolution: {nodeId: 4, widget: 0}` on its
`EmptyLatentImage`. `proceduralKey` (`comfy.js:605-627`) has no
`entry.input` name to use, so it falls back to **index 0 of the node's
non-link inputs in key order** — which for that node is `batch_size`,
not `width`. The panel then wrote 0.15 (megapixels, from 512x288) into
it and ComfyUI refused the entire graph before sampling a step:

    Prompt outputs failed validation
    [node 4 (EmptyLatentImage): Value 0 smaller than min of 1 — batch_size]

The immediate authoring error is fixed (that template declares no
`resolution` at all — an EmptyLatentImage takes literal width/height and
introspection handles it), and `tests/test-workflow-bundle.js` now
replays `injectParams` over every shipped template and fails when
injection turns a whole positive number into a fraction or a zero —
verified by reintroducing the bug, which reports
`4.batch_size: 1 -> 0.15`. **The class is still open**, and it is a
manifest-authoring landmine rather than a one-off:

1. A positional index into JSON key order is only unambiguous when the
   node has exactly ONE settable input. Everywhere else it is a guess
   that re-serialising the graph can silently re-point —
   `adapt-workflow.js` rewrites these files.
2. The shipped H3 manifest uses `widget: 0` on nodes 114, 136, 138 and
   167. Those are right TODAY (each was checked when authored); nothing
   holds them right. Converting them to named `input:` values is the
   fix, and each conversion needs one `comfy-probe --workflow` run to
   prove it (cheap — the probe runs H3 at 0.2 s).
3. Then `proceduralKey` should REFUSE a positional index on a node with
   more than one settable input, naming the inputs it does have (the
   grounded-error rule). That refusal cannot land before step 2 or it
   breaks the shipped H3 template.

Not bundled into P5: P5's own fix is complete and verified, and step 2
changes a template that renders today.

## 18 P5b. ANSWERED — the ComfyUI frontend DOES open an API graph editable

The one measurement `docs/proposals/comfy-templates-PLAN.md` §5 said the
owner's ask depends on ("can the frontend open a basic API-format graph
as an EDITABLE canvas? Unverified in this repo"), taken 2026-09-09 on
the MANAGED backend's own frontend build, in headless Chrome over CDP —
not read off the source. `app.loadApiJson(AE_LLAMA_SD15_T2I_V1.json)`
produced:

    isApi: true, nodeCount: 7, missingNodeTypes: [], wiredInputs: 9
    KSampler widgets: seed=12345 [number], control_after_generate=randomize
      [combo], steps=20 [number], cfg=8 [number], sampler_name=euler
      [combo], scheduler=normal [combo], denoise=1 [number]
    CLIPTextEncode text: "a red toy car on a white table in daylight"

Real LiteGraph nodes, real links, typed interactive widgets carrying the
authored values. The drop path is `getDataFromJSON` (every value has
`class_type` -> `{prompt}`) -> `app.handleFile` -> `isApiJson` ->
`loadApiJson`, which calls `LiteGraph.createNode(class_type)` per node.

**So the contingency in PLAN §5 is dead and must not be built:** basics
ship as API files, and "improve manually" starts from the actual graph.
The alternative it named — ship UI exports plus `adapt-workflow.js`,
forcing a re-harvest of `comfy-node-defs.json` for KSampler /
CheckpointLoaderSimple / Wan* — is now unnecessary work. P6-P10 inherit
this answer; do not re-measure it.

## 19. "I already have models" — discovery and confirmation (filed 2026-09-07)

**Owner, 2026-09-07:** *"it would be nice if there was some kind of
prompt or some kind of wizard that allows them to choose — hey, I have
models, here's where they're at."*

**The plumbing is DONE. This section is the UX over it**, and nothing
here needs new search logic.

### What already works (measured 2026-09-07, do not rebuild)

`comfyModelRoots(s)` (`tools.js:1274`) is the panel's search path, most
specific first:

1. `comfyModelsDir` — the panel's own primary folder;
2. every **Extra model folders** line, with per-type `kind=path`
   (`checkpoints=D:\SD\ckpts`);
3. the **Comfy-Desktop shared store**, auto-detected from
   `%LOCALAPPDATA%`, needing no configuration at all;
4. `<comfyDir>\models` — the user's own ComfyUI tree;
5. every root parsed out of the user's OWN `extra_model_paths.yaml` and
   the Desktop app's `extra_models_config.yaml`
   (`tools.js:1200-1221`, `parseComfyPathsYaml`).

So the panel **inherits an existing ComfyUI's model configuration**
rather than asking the user to restate it. Both consumers read the same
roots: `catalogModelStatus` reports the exact path each weight was found
at (feeding §18 P4's Workflows rows and the resolver's weights-present
ranking), and `applyExtraModelPaths` writes them into the managed
backend's yaml so it can LOAD them.

### The three gaps, in value order

1. **Nothing DISCOVERS anything.** The only auto-detected location is
   the Comfy-Desktop store. A standard `Documents\ComfyUI\models` — the
   most common layout, and the one on the dev machine — is found only if
   the user types it or sets `comfyDir`.
2. **No feedback, no validation.** `formToSettings`
   (`main.js:1167-1170`) trims each line and drops empties; nothing
   else. A typo is stored silently and the only symptom is a Workflows
   row still saying files are missing.
3. **Nobody is ever ASKED.** There is no first-run prompt, so a user
   with 200 GB of models has to go looking through Settings to find out
   the panel can use them.

### 19a. `Setup.scanForModelRoots()` — loop-takeable, BUMPS

Pure over an injected fs + env so it is stub-testable. Probes a NAMED
SHORTLIST and returns candidates with what is in them:

    { path, source, counts: {checkpoints: 12, vae: 3, ...}, total }

**Never scan drives.** A recursive sweep of a user's disks is slow,
alarming on a commercial product, and would find other applications'
models the panel has no business claiming. The shortlist:
`%USERPROFILE%\Documents\ComfyUI\models`, `%USERPROFILE%\ComfyUI\models`,
the Comfy-Desktop store, `<comfyDir>\models`, and every root already
named by a parsed yaml. Anything else is the Browse button's job.

Count by EXTENSION in the known sub-folders (`Comfy.MODEL_SUBS`), not by
catalog membership: a user's own checkpoints are not catalog entries,
and "found 47 model files" is the honest number. A candidate already
covered by `comfyModelRoots(s)` is marked as such rather than offered
again.

### 19b. "Scan for models" in Settings — loop-takeable, BUMPS

A button beside **Extra model folders**. Runs 19a, shows one line per
candidate with its counts and an Add checkbox, appends the chosen ones.
Plus the cheap half that is worth doing even alone: **validate what is
typed** — after an edit, each line reports "12 model files" or "folder
not found", so a typo is visible immediately instead of surfacing as a
missing weight three screens away.

### 19c. First-run prompt — OWNER-GATED

Where it belongs in first-run, and what it says, is commercial copy.
Draft shape: after the tier line, if 19a finds anything the panel is not
already using — *"Found 47 model files in Documents\ComfyUI. Use them?
[Use these] [Not now]"* — and nothing at all when it finds nothing. It
must never block first run, and it must never be the only way to reach
19b.

### Order and gating

19a then 19b are loop work and independent of everything Comfy-backend
(they touch only the search path and Settings). 19c waits on the owner.
None of it blocks §18.

## 20. The loop cannot tell working from hung (filed 2026-09-08)

### ROOT CAUSE FOUND 2026-09-08 (local session) — read this before 20a

The bypass was lost to **a bare `--` inside the brief**, and the break
dates from **2026-09-05 (`2d2e034`), not 09-08** — four nights, not two.
PS 5.1 shreds the multi-line prompt into ~18 argv fragments; one is the
`--` from `"SUPERSEDES: <lines> -- <what changed>"`; `claude.exe` 2.1.265
honours a bare `--` as end-of-options, so the trailing
`--dangerously-skip-permissions` became prompt text. The parser ignores
unknown flags silently, so nothing errored. `-p` also got only ~350
characters of the brief.

**The "PS 5.1 quoting alone" candidate was retired on bad evidence.** It
rested on "8 quotes ran the WORKING 09-06 nights" — but there were no
loop runs on 09-06. The last loop log before 09-08 is 09-02; §18 P0-P2
and P4 were pull-request merges `(#73)`, `(#74)`. Loop success was
inferred from overnight commits. Quoting WAS the cause; quote COUNT was
never the variable.

Handoff item 4 ("which change fixed it") is answered: **both are
independently sufficient**, so there is nothing to settle. Full working
in `docs/WORKPLAN-LOG.md`, entry of 2026-09-08 (local session).

20a and 20b are still exactly as needed as before — the loop still
cannot tell working from hung. Only the cause narrative changes.

`claude -p` returns its output in ONE block at the end, so a pass that is
working normally writes no log line for its entire 6-10 minute run. The
loop logs the pass start and then nothing until the pass ends.

That is why two days were spent unable to answer "is it working?". CPU
does not answer it either: `claude -p` is API-bound and burns almost no
CPU while working (8.66 CPU-seconds over ten minutes is a NORMAL pass),
and the harness deliberately leaves AE open and idle between steps, so a
flat `AfterFX` counter is the designed state rather than a stall. Both
readings were taken and both were wrong, in opposite directions, off the
same instrument.

### 20a. A heartbeat — takeable, no bump

While a pass runs, the loop should write a line every 30s carrying
something that PROVES progress rather than merely that time passed:
the pass process still exists, its elapsed time, and the repo's dirty
file count (`git status --porcelain | Measure-Object -Line`). A pass
that has started editing shows a rising count; one that has not shows
zero, and the two are then distinguishable from outside.

Do NOT use CPU. It is measured to be uninformative here in both
directions, which is the whole reason this item exists.

### 20b. A per-pass timeout — DONE 2026-09-08 (local session)

`-PassTimeoutMin`, default **45**, forwarded across the WMI detach. A
background job sleeps the bound, then kills the pass by DESCENT from the
loop process (`Get-AellCliPassProcesses`) and drops a sentinel file;
killing the child unblocks the pipeline, so the loop takes the next
iteration on its own and logs `Pass TIMED OUT: ...`.

45 rather than the 30 proposed below, because NEXT UP item 1 is a ~2 GB
download and a bound that kills the work it protects is worse than none.

Never by process NAME: the Claude desktop app is Electron and owns 21
processes called claude on this machine (measured), so a name match would
kill the owner's editor. `tests/test-pass-timeout.js` asserts exactly
that, and checks live that a process with no pass beneath it nominates
nothing.

The original filing follows.

There is no upper bound on a pass. `run-ae-selftest.ps1` has
`-TimeoutSec 240` and every other step has nothing, so a genuinely wedged
pass holds the loop until a human notices. Kill a pass that exceeds a
generous bound (30 minutes), log it as timed out with the last heartbeat,
and take the next iteration.

### 20c. Verify a pass completes and commits — DO THIS FIRST

Nothing has committed since the bypass repair. Three single-pass runs
were started and all three were killed before reaching a verdict. Run
`-Iterations 1` and let it finish untouched; the pass is done when it
prints `Pass committed <sha>` or `Pass produced no commit`. Until that
has been seen once, the loop is not known to work end to end and no
overnight run should be started.

### 20e. The harness's own output never reaches the loop log — takeable, no bump

Filed 2026-09-09 (local session) from the first full overnight run.

Grepping the 2026-09-09 log: `Running self-test via` appears **0** times,
and so does the `Crash flag:` line added in §21. The pass runs
`run-ae-selftest.ps1` as its own subprocess, so the harness's stdout goes
to the PASS, and only whatever the pass chooses to summarise reaches the
loop log.

That is fine while a pass finishes and writes a summary. It is exactly
wrong when one does not: pass 16 on 2026-09-09 was killed by the §20b
timeout at 45:48 and its summary died with it, so nothing in the loop log
says whether its self-test was even green. The heartbeat proves a pass is
alive; it cannot say what the harness found.

Tee the harness's output into the loop log (or a per-pass file the loop
names), so a killed pass still leaves the two lines that matter: the
self-test verdict and the crash-flag result.

### 20d. A guard test for the pass invocation — takeable, no bump

Filed 2026-09-08 from the root cause above. Nothing stops a future brief
edit from re-opening this: the failure is silent at every layer, and the
repo's own pure-ASCII rule is what turns an em-dash into the `--` that
does the damage.

Add a stubbed Node test that builds the pass argument vector the way
`run-local-agent.ps1` does and asserts the bypass survives as a REAL
flag — not merely that the string appears somewhere in argv, which is
what it did on all four broken nights. The distinction is the whole bug.

The brief lives in the `.ps1`, so the test has to reach into it rather
than re-declare it; a copy of the prompt in the test is a copy that will
drift, and a test that passes against a stale copy of the thing it
guards is the preflight mistake again.

## 21. AE's crash-recovery dialog blocks the harness, and no rule can press it (filed 2026-09-08)

**This outranks everything in NEXT UP.** While it stands, no pass can
run `scripts/run-ae-selftest.ps1` at all, so no pass can verify anything
in real AE -- which is the only thing this session is for.

Measured 2026-09-08 (local session), AE 2026.3, pid 82520 left blocked
by a timed-out harness run:

    Running self-test via ...\AfterFX.exe
    No results after 240s: After Effects never opened its main window,
    with a popup in front of it the whole time.

The popup is AE's crash-recovery prompt. Its REAL text, harvested by
`Write-AellUnknownDialogs`:

> We detected a crash in your last session. Crashes can potentially be
> caused by faulty plugins, scripts, extensions, or corrupt preferences.
> We recommend starting a Safe Mode session in order to diagnose the
> problem. During a Safe Mode session default preferences are used,
> scripts and extensions are not loaded, custom workspaces are not
> available, and 3rd party effect plugins can be disabled.

### Two independent defects, both measured

**21a. The rule's match fragment is wrong.** `Get-AellDialogRules`
matches this dialog on `Contains = @('recover')`. The measured text has
no "recover" in it anywhere -- it says "We **recommend** starting a Safe
Mode session". The rule was written as a candidate and its own header
says so ("their fragments and button labels are candidates"); this is
that guess coming due. Match on `detected a crash` and `Safe Mode`,
which are the measured strings.

**21b. The dialog has no pressable control, by EITHER mechanism.** This
is the one that makes 21a insufficient on its own. The window is a
`#32770` with an EMPTY title, and its entire visible content is a single
child:

| probe | result |
|---|---|
| `EnumChildWindows` | 1 visible child: `DroverLord - Window Class` / `OS_ViewContainer`, plus 3 hidden (`OS_ViewContainer`, `OS_EditTextContainer`, `Edit`) |
| UI Automation, `TreeScope::Descendants` | **1 descendant total**: `ControlType.Pane`, name `OS_ViewContainer`, no AutomationId |

So there is no "Open Normally" HWND and no UIA button element -- the
buttons are owner-drawn inside the pane. Every `Buttons = @(...)` list
in `host-dialogs.ps1` is unreachable here, and the rule falls through to
`CancelIfNoButton` / WM_CLOSE. **Do not assume WM_CLOSE is the safe
answer on this one.** Unlike the save-changes prompt, "cancel" has no
obvious meaning for a crash prompt, and the WRONG choice is not a
re-ask -- it is a **Safe Mode session, in which scripts and extensions
are not loaded**, i.e. AE runs, the harness launches, and the panel and
`hostscript.jsx` are simply absent. That failure looks like a code bug
for as long as it takes to notice.

### Why this is self-perpetuating

A harness run that times out leaves AE alive and blocked (that is what
pid 82520 is). Killing it arms the crash prompt for the NEXT launch, so
"kill it and retry" is a loop, not a fix. The pass that hits this can
only report it -- which is what the brief already says to do -- so the
condition survives every unattended night until the rule can actually
answer it.


### PREVENTION LANDED 2026-09-08 (local session) — owner chose "prevent it"

The dialog is not answered; the flag that arms it is cleared before AE
is launched. Measured on the live machine:

    HKCU:\Software\Adobe\After Effects\<ProductVersion>\CrashOccurred

a DWord. Stale 26.2 carried `CrashOccurred = 1`; healthy running 26.3
carried no such value, so ABSENT is the state AE itself writes and the
value is REMOVED rather than set to 0.

`<ProductVersion>` comes from `AfterFX.exe` itself — 26.3 reports
`ProductVersion` "26.3", which is exactly the registry subkey. The
install folder is "Adobe After Effects 2026"; deriving the key from that
would clear a key that does not exist and report success.

`scripts/lib/ae-crash-flag.ps1` (owner's policy: remove the value, refuse
while AE runs), dot-sourced from `run-ae-selftest.ps1` immediately before
`Start-Process`. Guarded by `tests/test-ae-crash-flag.js`. Suite 81/81.

**The refusal is not a limitation.** Only a COLD launch can meet the
prompt: when AE is already up, `-r` hands the script to that instance.
And AE owns the key for its whole session and rewrites it on exit, so a
clear applied underneath a live AE is silently undone — success reported
while being reverted, which is the §20 preflight lesson again.

Two things this does NOT fix, left open deliberately:

1. `Test-AellAeRunning` is version-blind: any running `AfterFX` blocks a
   clear for every version key. Conservative and wrong-safe, but a 26.3
   session currently blocks clearing stale 26.2.
2. The stale `CrashOccurred = 1` still sitting on 26.2 on this machine.
   Harmless while 26.3 is the version in use; it will fire on the first
   26.2 launch.

The watchdog rule that keys on "recover" is still wrong and still cannot
match. It is now unreachable rather than load-bearing, but it should be
either corrected or deleted so it does not read as coverage that exists.

### What to do, in order

1. **Measure which key answers it, on a throwaway AE**, not on the
   owner's session: `WM_CLOSE`, then `VK_ESCAPE`, then `VK_RETURN`, and
   after each one check `Get-Process AfterFX | MainWindowTitle` for a
   real main window AND run a one-line `-r` script that calls
   `AELL_call` -- a Safe Mode session will fail that, which is exactly
   how to tell the two outcomes apart. Record which key gives a NORMAL
   session.
2. Rewrite the `crash / auto-save recovery` rule on the measured
   fragments (21a) with the measured key from step 1, and mark in its
   comment that its control is keyboard, not a button, and why.
3. Back-fill `tests/test-host-dialogs*.js` with the harvested text above
   as a fixture, so the rule is proven to MATCH this exact wording
   without AE. The current rule would pass any test written from its own
   guessed wording -- that is how it shipped unmatched.
4. Consider whether the harness should refuse to start when a
   `#32770` with no pressable child is already up on AfterFX, and say
   THIS, rather than spending 240s discovering it again.

**Human eye wanted on step 1.** An unattended pass must not press a
blind key on a dialog whose wrong branch silently removes the panel.

## 22. The install should hand a buyer exactly the setup their card can run (owner direction, filed 2026-09-09)

**Owner, 2026-09-09:** *"when somebody's automatically downloading the
plug in, I want it to be able to scan their hardware and apply the
recommended installs for their machine, including the workflows that
support those recommended installs. So we'll end up having quite a few
basic workflows, but that's kind of the idea. And then from there, we can
holistically and strategically expand on the functionality of all of
those basic workflows in tandem."*

The unit being shipped is therefore not a model, it is a **bundle**:
chat model + gen entry + the workflow that renders it + whatever nodes
that workflow needs. Hardware picks the bundle. Nothing that cannot run
is installed or shown.

### What already exists (checked 2026-09-09, not assumed)

- `Setup.recommendSetup` / `recommendGen` already scan and choose: tier,
  chat model, image entry, video entry, with `entryFits` gating on
  `minVramGB` and `requiresBlackwell`.
- Six basics ship and are **core-only BY CONSTRUCTION** (§18 P5-P10).
  Checked: all six manifests carry `catalogEntry` and NO `optionalNodes`.
  The only two manifests with `optionalNodes` are the owner's authored
  KREA2 and H3 i2v, and both left the bundle for `tests/fixtures/`.
- Manifests already attribute every node class to a PACK, and
  `test-workflow-manifests.js` already asserts that every non-core pack
  carries a repo URL. That is the foundation an installer would need.
- §18 P4 already renders what a template NEEDS in Settings: VRAM floor,
  architecture gate, needs-an-image, missing-weight count.

**So the hard part is largely done.** The invariant that makes the whole
plan work — a buyer's recommended set needs no custom nodes — is true
today. It is just not GUARANTEED.

### 22a. Nothing pins "a bundled template is core-only" — takeable, no bump

The load-bearing invariant is unasserted. A future template could name a
custom pack and every buyer without it would get a graph that cannot run,
with nothing in CI objecting. Refuse, in `test-workflow-bundle.js`, any
manifest under `extension/comfy-workflows/` whose packs are not
`(comfy-core)`. Fixtures are exempt on purpose and the message must say
so, or the next person deletes the wrong half.

### 22b. Seeding is hardware-blind — takeable, bumps

`Setup.ensureDataDirs` copies EVERY bundled template into
`%APPDATA%\AE-Llama\comfy-workflows` with no reference to the card. An
8 GB buyer is seeded the H3 and Wan graphs, which need 32, and the
Workflows list then reads as capability. Seed what `entryFits` accepts;
keep the rest available behind an explicit "install anyway".

Careful: `ensureDataDirs` has NO delete path (verified §18 P8), which is
what preserves a user's own files. Hardware-conditional seeding must stay
additive — a card upgrade adds templates, and nothing is ever removed
because a reading changed.

### 22c. Nothing SEQUENCES the first run — takeable, bumps

Every piece exists and no code path runs them in order: scan ->
recommend -> download the recommended weights (`download-gen-weight`) ->
seed the templates that fit (22b) -> inherit existing model roots (§19)
-> report what was installed and what was skipped and why. That sequence
is the product's first impression and today it does not exist.

### 22d. A node-pack installer — for the EXPANSION layer only

Needed for what the owner calls expanding functionality "in tandem", not
for the basics. **The basics must stay core-only** (22a) so that a buyer
never needs this to get working. Manifests already carry pack repo URLs.
Was "out of scope, remote builds it" while there was a remote session;
there is not one now.

### 22e. A coverage matrix, kept true as the catalog grows

Every tier must end with a runnable image AND video template, or an
honest statement that it has none. **Today the video half is empty below
32 GB** (§18 P7a), which is the first hole in this matrix and is being
measured under §18 P7c. This is the item that stops the catalog growing
into a set of recommendations nobody can execute.

### Order, and the reference machine

The owner tests the whole stack on this machine first — a 5090 runs every
entry, so it is the reference for what "works" means before any tiering
is trusted. That is also why §18 P7's finding matters here: the floor is
RESIDENT WEIGHTS, not the frame, so this machine can measure whether a
bundle fits a smaller card without owning one.

## Out of scope for the local session (remote builds these)

- ComfyUI bundled node-pack installer and wiring generation into
  5.8's round-trip; tier-plan P5 (final video file pins per tier).
- Phase E roto/tracking hybrids. (Phase D animation utilities are now
  largely items 5.1–5.7 above — do not double-build them.)
- The rollback DESIGN in item 4 may be built only after the remote
  session reviews the proposal.
- Minor/major version bumps, PRs into main, release notes. PATCH bumps
  are YOURS: `node scripts/bump-version.js patch` before pushing a fix
  you verified in real AE, or it never reaches a panel (see CLAUDE.md).

## ~~17f. The shipped KREA2 template cannot render on the vendor backend~~ DONE 2026-09-09 (0.12.7)

**DONE. Substitute chosen by rendering all six candidates, not by
argument: `exp_heun_2_x0`.** Node 278's `sampler_name` is now set by the
manifest's `panelAdaptation.setInputs`, alongside the filename_prefix
adaptation that was already there - the same shape of defect (an
authored value true on exactly one machine), so the same seam. The UI
source stays a faithful export of the author's graph and
`scripts/adapt-workflow.js` applies the substitution on regeneration,
so a re-export cannot silently undo it.

**The measurement** (2026-09-09, vendor backend 0.34.0, seed 12345,
768x768 -> saved 1232x1232, one prompt for all six). This is why the
item insisted on renders rather than reasoning - the shortlist in the
original filing was actively misleading:

| sampler | result |
|---|---|
| `res_multistep` | coherent, but hazy - blown highlights, weak spoke detail |
| `res_multistep_cfg_pp` | **unusable** - collapses into flat colour noise |
| `res_multistep_ancestral` | **unusable** - collapses into flat colour noise |
| `res_multistep_ancestral_cfg_pp` | **unusable** - collapses into flat colour noise |
| **`exp_heun_2_x0`** | **clean, correct exposure, crisp detail - CHOSEN** |
| `exp_heun_2_x0_sde` | clean and detailed; slightly more contrast/grain |

**Three of the four samplers the original filing shortlisted are
unusable at this template's 4 steps**, and the two it MISSED are the two
that work. The name match on `res_*` was the wrong instinct: `res_2s` is
RES4LYF's Refined Exponential Solver, 2nd-order SINGLE-step and
deterministic, and `res_multistep` shares its prefix while being a
different method. `exp_heun_2_x0` is the core build's deterministic
2nd-order exponential Heun on x0-prediction - the actual analogue - and
it also rendered best. `exp_heun_2_x0_sde` is its stochastic twin and
was passed over for adding randomness the authored sampler did not have.
(The `cfg_pp` collapse is consistent with those samplers expecting
cfg near 1 while this graph's guider does not; not chased further, since
they lost on the render.)

**Verified end to end**, not only in the sweep: the shipped path with no
hand edits - `comfy-probe.js` -> adapted template -> vendor backend ->
real AE import - passes every verdict, and the output file is
BYTE-IDENTICAL to the sweep's `exp_heun_2_x0` render, so the manifest
route reproduces exactly the graph that was measured.

**Stub back-fill: `tests/test-comfy-enum-values.js`** (new), which is the
part that outlives this one template. See 17l for why the repo's
existing offline node definitions could not be used for it.

<details><summary>Original filing</summary>

## 17f. The shipped KREA2 template cannot render on the vendor backend (filed 2026-09-09, local session)

**This is the finding §17c was created to produce**, and it lands exactly
where the owner predicted: *"how can we be sure comfy works on other
users if we don't test it here?"*

Measured 2026-09-09 on the managed vendor backend (ComfyUI portable,
python 3.13.14, torch 2.13.0+cu130):

    node scripts/comfy-probe.js --url http://127.0.0.1:8288 \
         --workflow AE_LLAMA_KREA2_V1 --width 512 --height 512

    FAIL generation completed - ComfyUI dropped every output branch of
    this workflow when it validated it, so nothing was rendered:
    node 278 (KSamplerSelect): Value not in list -
    sampler_name: 'res_2s' not in (list of length 44)

`AE_LLAMA_KREA2_V1.json` node 278 is a **core** `KSamplerSelect` whose
`sampler_name` is **`res_2s`** — a sampler that the RES4LYF custom node
pack ADDS to that core node's enum. The owner's hand-built ComfyUI has
RES4LYF; the vendor portable build does not. Queried live, the vendor
build offers 44 samplers and `res_2s` is not one of them. The nearest
core equivalents it DOES have:

    res_multistep, res_multistep_cfg_pp,
    res_multistep_ancestral, res_multistep_ancestral_cfg_pp

Every KREA2 measurement this repo holds was taken where `res_2s`
existed, so "KREA2 works" has never been a statement about a buyer.

**Why the optional-node machinery did not save it.** The panel can drop
custom NODES it cannot find (`tests/test-comfy-optional-nodes.js`). This
is not a missing node — the node is core and present. What is missing is
one VALUE in that core node's enum, which is contributed by a pack. No
node-type check can see that, which is why it reached a real render.

**The work.** Pick a substitute from the four above and re-measure KREA2
rather than reasoning about which is closest: a sampler change moves the
image, so this needs a rendered comparison, not an argument. Then decide
the general rule — does the panel SUBSTITUTE a missing enum value and
say so, or refuse and name what the backend has? Grounded-error practice
here means naming the 44, not "invalid sampler".

**Unblocked 2026-09-09 (0.12.6), and one of the four is already
rendered.** Taking this item is what found §17j's real severity: with
`res_2s` swapped out the graph reached execution for the first time and
died on the DETACHED backend's dead stderr pipe, so no sampler could
have been measured before that was fixed. It now is. One render exists —
`res_multistep`, seed 12345, 768x768 (saved 1232x1232), on the vendor
backend with all five optional-node rules firing:
`logs/comfy-probe/2026-09-09_CRPTK-KREA2__00001_.png` — on the AE
machine only, since `logs/` is gitignored; a remote session cannot open
it and should not go looking. It is a coherent,
well-formed image at the model's 4 steps, which is the load-bearing
question (a turbo model falls apart under a sampler that needs more).
That is ONE data point, not the comparison this item asks for.

To finish it, render the other three at the SAME seed/prompt/size and
compare:

    node scripts/comfy-probe.js --no-ae --url http://127.0.0.1:8288       --workflow AE_LLAMA_KREA2_V1 --width 768 --height 768 --seed 12345       --prompt "<the same prompt each time>"

editing node 278's `sampler_name` between runs. Note also that the
vendor build carries `exp_heun_2_x0` and `exp_heun_2_x0_sde`, which the
original filing's list of four missed — `res_2s` is a 2nd-order
EXPONENTIAL single-step method, so those are worth a render too rather
than assuming the `res_*` name match is the closest behaviour.

A `res_2s` reference render was NOT taken: the owner's own ComfyUI (the
one with RES4LYF) was not running, and booting a second backend on an
unattended night risks a port fight with the managed one for a
nice-to-have. Judge the candidates against each other and against the
prompt; if a reference is wanted, take it on a pass where the owner's
instance is already up.

Blocks §18 items 3-8: authoring more templates against a sampler set the
shipped backend does not have would multiply this bug.

</details>

## 17g. A preflight that checks weights but not enum values reports "ready" about a graph that cannot run (filed 2026-09-09, local session)

Same run as §17f, and the more general defect. Immediately before the
generation that ComfyUI refused outright:

    weight-availability-probe --url http://127.0.0.1:8288
    AE_LLAMA_KREA2_V1: backend checked 3 weight slot(s), 0 it cannot
    load; panel prices it off disk at 18110 MiB
    == PASS a template whose weights the backend LISTS is not refused

So `Comfy.missingWeights` gave a clean bill of health to a template
ComfyUI then dropped every output branch of. The check is not wrong
about weights; it is being READ as "this template will run", which it
cannot answer. A user is told a generation is ready and then watches it
fail — the "complete-LOOKING answer that does not contain the truth"
class this repo has already paid for once (§1, the truncated comp
roster).

ComfyUI already has the honest check: **`POST /prompt` with
`validate_prompt`**, which is what produced the `res_2s` message. The
work is to run the graph past validation as part of the preflight, and
report what it says, instead of inferring readiness from weight slots
alone.

### DONE 2026-09-09 (local session, 0.12.8) — and the paragraph above is wrong about HOW

**`POST /prompt` cannot be used for this, measured in the vendor build's
own source.** There is no validate-only endpoint and no validate-only
flag: `server.py`'s `post_prompt` calls `execution.validate_prompt` and,
`if valid[0]`, puts the graph straight on the queue. Validation failing
is the only path that has no side effect. A "validate" that RUNS the job
when the answer is yes is not a preflight — and it cannot be undone
after the fact either: the worker thread wakes on the put, so a cancel
(`/api/jobs/<id>/cancel`, which does exist here) arrives after the first
node has begun loading, which for KREA2 is 18 GB of weights. That is the
opposite of the cost this check exists to save.

So the check is client-side, against the same ground truth ComfyUI
validates from: **`Comfy.validateGraphInputs`** walks `/object_info`
once per class and reports both halves — the weight slots the backend
cannot load (unchanged, `missingWeights` is now a thin wrapper on it)
and the build-constant enum VALUES it does not offer. `tools.js`
`preflightRefusalFor` (was `weightRefusalFor`) refuses on either, in the
same place as before: after the boot the generation was going to pay for
anyway, BEFORE the arbiter stops the chat model, and with nothing
queued.

It mirrors exactly what `validate_inputs` does to a LITERAL — combo
membership — and deliberately not the rest (link types, min/max), which
needs the graph the panel actually posts rather than the template on
disk.

Kept honest in both directions, which is what makes it safe to ship:

- an enum whose options come from THIS DISK (`ckpt_name`,
  `LoadImage.image`) is never judged. Those are one machine's contents,
  and half of them the panel overwrites before posting. Same
  build-constant rule and same regex as `scripts/harvest-core-enums.js`,
  so the offline test and the live preflight cannot drift into answering
  different questions.
- a node the manifest drops or re-classes UNCONDITIONALLY is skipped
  (`opts.skipNodes`), because the preflight reads the template and the
  panel posts what `resolveOptionalNodes` left. Every entry shipping
  today is gated on `when: "missing"`, which is self-answering: a missing
  class has no definition and the check is already silent there.

**The one residual exposure, written down so a false refusal is not
re-diagnosed from scratch:** ComfyUI SKIPS its own combo check for an
input named in a node's `VALIDATE_INPUTS` argspec, and nothing in
`/object_info` says a validate function exists. So a pack whose node
validates its own enum could in principle be refused here for a value
that build would accept. `missingWeights` has carried the identical
exposure since it shipped and no instance has ever been seen. If one is
reported, this is the first suspect.

Verified against the real vendor backend (0.34.0, port 8288), not only
stubs: both shipped templates pass (6 and 7 build-constant values
checked), and putting `res_2s` back on KREA2 node 278 produces the
refusal naming the value, the node, and all 44 samplers the backend
really has. `scripts/weight-availability-probe.js` gained verdict 6 for
this, because verdict 1 alone is the sentence that printed PASS on the
run that could not render.

## 17k. The managed backend dies SILENTLY within the half hour (filed 2026-09-09, local session)

**CAUSE FOUND, AND FIXED, 2026-09-09 (local session) — see §17p, and
read it before acting on anything below.** The fix is in; a backend has
since survived the entire 85-file suite on the same pid. If a death is
measured AFTER that, it is a NEW one and the hypotheses below become
live again — until then they explain nothing that has actually happened. The killer is in this repo: the stubbed test
suite. `tests/test-comfy-install.js` runs the real `comfy-install.js
--check --stop` against a temp APPDATA that carries no
`comfyManagedPort`, so it defaults to 8288 and `stopByPort(8288)`
taskkills whatever ComfyUI is listening there — the live backend.
Measured TWICE by boot / run that one test file / read the port: a pid
listening before, nothing after, and `comfy-managed.log` ending on a
normal line, which is exactly the signature described below. Every pass
runs the suite, which is where "within the half hour" comes from. The
job-object and idle-timer hypotheses below are not needed to explain any
death measured so far; leave them unpursued unless a death survives the
§17p fix.

The successor to §17j, and the first entry written with its log in hand.
§17j is closed; this is the question it was filed to make answerable.

**Measured 2026-09-09.** Backend booted detached at 03:43 (pid 61904),
served a full KREA2 generation, and was gone from port 8288 within the
half hour — the third time in two days. `comfy-managed.log` now exists
and its last line is:

    [INFO] Prompt executed in 12.72 seconds

Nothing after it. **No traceback, no shutdown message, no atexit
output.** That is the new datum and it is worth more than it looks: a
Python-level crash, an unhandled exception, an OOM abort and a clean
shutdown would all write SOMETHING there. This process was terminated
from outside, hard.

**Ruled out.** The loop's own reaper is not it.
`Get-AellCliPassProcesses` (`scripts/lib/claude-procs.ps1`) filters
descendants by NAME to `claude*` and `node*` whose command line mentions
claude, so `python.exe` is never a candidate — and both of
`run-local-agent.ps1`'s kill sites go through it. Nothing else in
`scripts/` kills anything ComfyUI-shaped except `comfy-managed.js`'s own
`stop`/`stopByPort`, which are only reached from an explicit `--stop`.

**HYPOTHESIS, not a measurement — do not log this as fact.** Windows job
objects. Node's `detached: true` gets the child out of the LAUNCHER's
job (measured 2026-09-09, and it holds — the backend outlives
`comfy-install.js` by minutes and served two independent processes). It
does not obviously get the child out of the job the enclosing agent
session or terminal is in. Kill that job and every process in it dies at
once with no chance to log, which is exactly the signature above, and
the ~30-minute latency matches a pass ending rather than anything
ComfyUI does.

**Second death, measured 2026-09-09 (later the same day) — and it
weakens the hypothesis above.** Booted, served six sweep renders plus a
full end-to-end probe, last log line `Prompt executed in 4.45 seconds` at
**04:02:25**, nothing after it, port dead by **04:16**. Same silent
signature. But this time: the agent session that booted it **did not
end** (it was still running, and still running when the death was found),
no `--stop` was issued, the backend had already outlived its launching
process by half an hour of active use, and it died **IDLE** — every
generation it was asked for had succeeded.

So the ~30-minute latency is NOT obviously "a pass ending", which is what
the job-object story leans on. It fits an idle timer at least as well.
Step 1 below tests only the job-object story; run it, but do not read a
null result there as "no cause found". Add the cheap idle control
alongside it: boot, do ONE generation, then leave it strictly alone and
watch the port, with nothing else on the machine changing. If it dies on
a timer with no session ending, the hypothesis below is refuted rather
than unproven.

**How to test it** — cheap, and it settles the question before anyone
writes code:

1. Boot the backend, note the pid, and read its job assignment
   (`NtQueryInformationProcess` is overkill; `Get-Process`
   + a `AssignProcessToJobObject`-aware tool, or simply test the
   behaviour) — then END the session that booted it and see whether it
   dies at that moment rather than on a timer. A death that lands
   exactly on session end is the answer; a death on a timer is not.
2. If confirmed, the fix is to break job inheritance at spawn: launch
   through a detaching shim (`cmd /c start ""` or PowerShell
   `Start-Process`) so the backend is re-parented out of the tree,
   instead of `detached: true` alone.

Do NOT skip step 1. §17j is a standing lesson in this exact repo about
how a plausible mechanism gets recorded as a cause and then has to be
retracted — and about how a test can be sound and its conclusion still
too broad.

Wanted by §18: those passes need a backend that stays up between them.

## 17l. The repo's offline node definitions come from the author's install, so they cannot answer "will this run for a buyer" (filed 2026-09-09, local session)

Found while back-filling the stub for §17f. `scripts/comfy-node-defs.json`
is the only offline record of ComfyUI's INPUT_TYPES the repo has, and it
was harvested from the AUTHOR's ComfyUI. Measured 2026-09-09: its
`KSamplerSelect.sampler_name` carries **63** samplers **including
`res_2s`**; the vendor backend offers **44** and does not. So a check
written against that file would have PASSED the exact template ComfyUI
refused to run — it is a picture of the one machine where the bug is
invisible.

Its own job (recovering positional widget ORDER for
`scripts/adapt-workflow.js`) is unaffected, and it should keep doing it.
What it must not become is the reference for "does the shipped build
have this value".

**Done in this pass** — `scripts/harvest-core-enums.js` writes
`tests/fixtures/comfy-core-enums.json` from a VENDOR backend, and
`tests/test-comfy-enum-values.js` checks every literal in every shipped
API template against it, offline. Only BUILD-CONSTANT enums are pinned;
an enum populated from the user's model folders is one disk's files, so
those are detected and skipped (and the skip list is written into the
fixture, so what is NOT covered is visible). The `LoadImage.image` case
proved that necessary: the i2v template ships an author-machine PNG
filename that the panel overwrites at runtime, and pinning that enum
would have failed the test everywhere for the wrong reason.

**What is left here, and it needs a human decision** — the fixture is a
snapshot taken by hand against a running backend (`node
scripts/comfy-install.js --boot` then `node scripts/harvest-core-enums.js
--url ...`). Nothing forces it to be refreshed when the vendor build is
upgraded, so it will drift, and a stale fixture fails SAFE in one
direction (it can reject a value a newer build added) and unsafe in the
other. Options: record the vendor version it was taken from and warn when
`comfy-install.js` installs a different one; or re-harvest as part of the
install check. Not chosen tonight — the fixture does carry
`harvestedOn`/`comfyuiVersion` (0.34.0), so the drift is at least
legible.

## ~~17m. `comfy-probe.js --url` is silently ignored in managed mode~~ DONE 2026-09-09 (filed 2026-09-09, local session)

**DONE 2026-09-09 (local session), together with §17h and §17o — one rule,
six scripts.** `managed.urlOverride(url)` returns `{comfyUrl,
comfyBackend: "own"}`: an explicit URL names an INSTANCE, so it selects
the mode that means "the instance at this URL" as well as the address,
and every caller downstream (status, generate, validateGraphInputs,
freeVram) follows without `backendUrl` having to learn a special case.
Every probe resolves with `Comfy.backendUrl(s)`; nothing under `scripts/`
reads `.comfyUrl` as a target any more. Stub back-fill
`tests/test-probe-backend-url.js`, three layers, its source guard
enumerating the two files still allowed to print the SETTING. Verified on
the real machine: `--url` moves the target, and a full generation ran
through the override. No bump — nothing in `extension/` changed.

The original filing follows.

Measured 2026-09-09:

    node scripts/comfy-probe.js --no-ae --url http://127.0.0.1:8299 ...
    -- ComfyUI at http://127.0.0.1:8288  (backend: managed)

The flag was accepted, printed nothing, and the probe went somewhere
else. Cause: line 292 does `if (OPT.url) OVERRIDE.comfyUrl = OPT.url;`,
but the probe resolves its target with `Comfy.backendUrl(S)` — which in
managed mode returns the managed port and **never consults `comfyUrl`**.
That resolution is correct and deliberate (the comment above it explains
why, and it is what §17h asks the weight probe to copy); the override is
simply wired to the field the resolution ignores.

Consequence: every measurement anyone believes they took "against the
other backend" with `--url` was taken against the managed one. Every
`--url http://127.0.0.1:8288` in this workplan happens to be harmless
only because managed already resolves to 8288.

Note for §17h: it praises `comfy-probe.js` for resolving the backend
correctly, which is true, and then asks that "`--url` should stay an
override" — in comfy-probe `--url` is not an override at all yet. Fix
both together: `--url` should set the RESOLVED target, not `comfyUrl`.

## ~~17n. `comfy-probe.js` reports "ComfyUI reachable" PASS when nothing is listening, and `--boot` therefore never boots~~ DONE 2026-09-09 (filed 2026-09-09, local session)

**DONE 2026-09-09 (local session).** No bump — nothing under `extension/`
changed. `scripts/lib/comfy-managed.js` gained `reachable(Comfy, url,
settings, cb)`, which answers "is it up, and if not why not" in ONE
place; `down` is a string (the transport error, or Comfy's own hint) and
null when the backend answers. **FOUR** probes had the defect, not one —
`comfy-probe.js`, `catalog-vram-probe.js`, `handoff-probe.js` and
`oom-probe.js` all tested `if (err)` alone; all four now route through
the helper. `comfy-install.js` was already correct (`!!(st && st.online)`).

**The panel audit this filing asked for came back clean**, and is written
down so it is not repeated: `main.js:1499` (the Settings "Test" button)
already tests `st && st.online`, and `tools.js` `comfy_status` hands the
whole status object — `online`, `hint` — to the model rather than
judging it. Neither has the defect.

En route, a second inaccuracy in the same message: `comfy-probe.js` was
the only probe not loading `setup.js`, so `Comfy.status` could not ask
`Setup.findComfyInstall` anything and EVERY down verdict ended "…or
install the hidden backend" — naming as the fix a thing installed on
2026-09-09. It loads `setup.js` now, and the probe adds the lever its
own caller actually has (`--boot`) after the panel's hint.

Verified against the real machine, not only stubs: with the managed
backend genuinely down, the probe FAILS at reachability and stops, and
`--boot` reaches the boot branch it could never reach before. Stub
back-fill: `tests/test-probe-reachability.js`, in three layers (the
helper on fakes; a source guard that any script calling `Comfy.status`
must test `.online`, which is what catches the fifth probe copied from
the fourth; and comfy-probe end-to-end against an OS-allocated dead
port). Negative control run: reverting `comfy-probe.js` alone makes 7 of
its assertions fail, including both halves of the contradiction.

The original filing follows.

Measured 2026-09-09 with nothing on the port:

    == PASS ComfyUI reachable — queue running=0 pending=0
    == FAIL generation completed — ComfyUI is not running and the hidden
       backend is not installed.

Two verdicts, one run, flatly contradicting each other. `Comfy.status()`
does **not** call back with an error when the backend is down — it calls
`cb(null, {online: false, hint: ...})`, deliberately, because the panel
wants the hint text rather than an exception. `stepStatus` only tests
`if (err)`, so the down case takes the SUCCESS path and prints a PASS
built from `undefined` counts (`running=0 pending=0` is the `|| 0`, not a
reading).

**The worse half: `--boot` lives inside that same `if (err)` branch.** So
`comfy-probe.js --boot` cannot boot a backend that is down — the only
situation it exists for. It sails past into a generation failure whose
message is about installing a hidden backend.

Fix: `stepStatus` must fail (and `--boot` must trigger) on
`err || !st.online`. Then check the same pattern elsewhere — any caller
of `Comfy.status` that tests only `err` has this bug, and the panel's own
callers should be audited alongside, since a false "reachable" in the UI
is the same defect with a user in front of it.

A stubbed test belongs with the fix: a `Comfy.status` stub returning
`{online:false}` must make the probe's reachability verdict FAIL. This
pass did not write it — the fix is a probe/panel change and the item was
§17f; filing it rather than bundling it is the §17j lesson applied.

## ~~17o. `handoff-probe.js` and `oom-probe.js` ask `s.comfyUrl`, so in managed mode they measure the wrong backend~~ DONE 2026-09-09 (filed 2026-09-09, local session)

**DONE 2026-09-09 with §17m/§17h.** Both resolve with
`Comfy.backendUrl(s)` now, and each prints which backend it is about to
measure before the first verdict. Their transcript headers said
`comfyUrl:` while the run went elsewhere; they carry `backend:` with the
resolved URL and the mode.

The original filing follows.

Found while fixing §17n, in the same callbacks. Both probes do

    Comfy.status(s.comfyUrl, …)

and then hand the card to whatever ComfyUI that turns out to be. This is
§17h's defect in two more files: `comfyUrl` is the **"use my own
ComfyUI"** setting, and in managed mode `Comfy.backendUrl(s)` — not
`comfyUrl` — is the backend. `comfy-probe.js` and `catalog-vram-probe.js`
already carry the comment explaining why, verbatim; these two never got
it.

Consequence is worse here than a wrong port. Both probes exist to measure
a VRAM handoff: the chat model is stopped, ComfyUI is asked to render,
and the card is watched. Pointed at a backend that is not the one the
panel would use, the numbers are about a different process — and if
nothing is on `comfyUrl` at all, the probe now stops at reachability
(§17n) instead of quietly measuring nothing.

**Deliberately not fixed in the §17n pass**: that pass's item was the
online check, the fix here is the §17h/§17m resolution rule, and bundling
a second change into a verified one is the §17j lesson. Do all three
together — one rule, four call sites, one test.

## ~~17h. `weight-availability-probe.js` cannot see the managed backend without being told~~ DONE 2026-09-09 (filed 2026-09-09, local session)

**DONE 2026-09-09 with §17m/§17o, and verified the way the filing asked.**
A bare `node scripts/weight-availability-probe.js` in managed mode now
reports `ComfyUI URL: http://127.0.0.1:8288  (backend: managed)` and every
verdict PASSES against the live managed backend — the same command that
reported `1 verdict(s) FAILED` with ECONNREFUSED against the own-mode
port. En route: its verdict-4 fixture ("an UNREACHABLE backend refuses
nothing") was built by overriding `comfyUrl` alone, so in managed mode the
"unreachable" backend it tested was the LIVE one. It uses the shared patch
now.

The original filing follows.

Measured 2026-09-09: with `comfyBackend: "managed"` and
`comfyManagedPort: 8288`, a bare

    node scripts/weight-availability-probe.js

went to `comfyUrl` — `http://127.0.0.1:8188`, the **"own"** setting —
got ECONNREFUSED, and reported `1 verdict(s) FAILED`. In managed mode
`comfyUrl` is not the backend; `Comfy.backendUrl(settings)` is, and
`comfy-probe.js` already resolves it that way (it printed
`backend: managed`).

Small fix, real consequence: an unattended §18 pass that runs this probe
without `--url` measures nothing and reports a failure that says nothing
about the weights. It should default to the backend the settings
actually select, and `--url` should stay an override.

## ~~17p. The stubbed test suite kills the live managed backend~~ DONE 2026-09-09 (local session)

**DONE.** Fixed exactly where this filing said to — in the fixture, not
in `stopByPort`. Block 4 of `tests/test-comfy-install.js` now writes
`comfyManagedPort` into its temp `settings.json` from an OS-allocated
dead port (`net.createServer().listen(0)`, bound, read back, released),
and the fall-through that had no assertion at all is covered three ways:
`stopped the backend holding port` must not appear, the run must say it
looked at the FIXTURE's port, and the string `8288` must not appear
anywhere in the output of a run that stops. Negative control: dropping
the `settings.json` write fails all three.

**Verified against this filing's own reproduction**, not just the stub:
`comfy-install.js --boot` (pid 42796 on 8288) → all 85 test files →
`Get-NetTCPConnection -LocalPort 8288` still names **pid 42796**, and
`/queue` answers 200. The suite no longer kills the backend, and the
whole suite was run, not only the one file.

The filing's last question — whether any OTHER test can reach
`stopByPort`/`taskkill` with a defaulted port — is answered NO today
(`test-probe-reachability.js` and `test-probe-backend-url.js` both name
a dead port already, and neither passes `--stop`), and block 5 keeps the
answer true: any `tests/test-*.js` that hands a script `--stop` must
also name a port. Its first draft was satisfied by a PROSE mention of
`comfyManagedPort` in a comment — the same shape of hole this section
is about — so it requires `comfyManagedPort` followed by `:` or `=`.

The original filing follows.

## 17p (as filed). The stubbed test suite kills the live managed backend (filed 2026-09-09, local session)

**This is §17k's cause, measured rather than hypothesised.** Found while
closing §17m: a backend booted at 08:52 and still serving a full H3
generation at 08:53:53 was gone by 08:56:34, `comfy-managed.log` ending on
an ordinary line — no traceback, no shutdown message. What ran in between
was the stubbed suite.

Reproduced twice, deliberately, with nothing else running:

    node scripts/comfy-install.js --boot      # pid 20856 / 79892 on 8288
    node tests/test-comfy-install.js          # exit 0, ALL TESTS PASSED
    Get-NetTCPConnection -LocalPort 8288      # nothing

**The path.** Block 4 of that test writes a stale `comfy-managed.pid`
(`424242`) into a temp APPDATA and runs the real `comfy-install.js --check
--stop` twice. `managed.stop()` correctly refuses to kill the recycled
number and clears the record — and then falls through to
`stopByPort(port, say)`. The temp settings carry no `comfyManagedPort`, so
`Comfy.managedPort()` hands back the DEFAULT 8288, which on this machine
is the real backend. The command-line guard inside `stopByPort` cannot
save it: the process really is ComfyUI, so it is really killed, with
`taskkill /PID n /T /F` — which is exactly why nothing is written to the
log.

**It passes while doing it**, which is why this survived four deaths. The
kill prints `stopped the backend holding port 8288 (pid N)`, and the
assertion beside it only forbids `stopped the managed backend` — a
different string. The `r2` assertion that follows (`no managed backend
found to stop`) then passes BECAUSE the real backend was just killed.

**Fix the fixture, not `stopByPort`.** A test that drives a stop path must
name a port nothing owns: write `comfyManagedPort` into the temp
`settings.json`, from an OS-allocated dead port the way
`tests/test-probe-backend-url.js` does it — never a hardcoded number, or
the test starts passing for the wrong reason on one machine. Then assert
POSITIVELY that no stop-by-port was claimed, so it fails if it ever
reaches for a real process again.

Check in the same pass whether any other test runs a script that can reach
`stopByPort` or `taskkill` with a defaulted port.
`tests/test-comfy-backend.js` is stubbed and does not, but the rule is
the same one.

Consequence while it stands: every unattended pass that boots a backend
and then runs the suite loses the backend, silently — and §18's measured
blocks, which need a backend that survives between passes, cannot be
taken.

## 17q. The loop's own backend outlived the loop, and cost the owner his GPU all morning (filed 2026-09-09, local session)

**Found the way product bugs should never be found: the owner tried to
play a game and it was laggy.**

Measured 2026-09-09 at 11:31, seventy-six minutes after the overnight
loop finished at 10:15:49:

    GPU  27,844 MiB used of 32,607   utilisation 0%
    pid 42796  python.exe  10,433 MB RAM  7,040 CPU-seconds  up 380 min
    (AppData\Roaming\AE-Llama\vendor\comfy\...\python_embeded\python.exe)

85 percent of a 5090 held at zero utilisation, leaving about 4.7 GB for
anything else. `comfy-install.js --stop` released it: **27,844 -> 1,365
MiB**.

**This is NOT the shipped product's behaviour, and that distinction is
the whole of the fix.** The panel spawns the backend NON-detached, so
Windows' job object takes the child when the panel process goes; `unload`
calls `stopManaged()` on top of that, and `reapOrphan()` at init is the
net for when CEP does not fire unload. `llama.js` has no `detached`
anywhere either. Three layers, and the strongest is the OS.

The SCRIPT path is the one with no owner. `comfy-install.js --boot` opts
into `setManagedDetached(true)` deliberately, so a backend survives the
script that started it and is there for the NEXT pass. Correct during a
run. Wrong the second the run ends, and nothing was stopping it.

**Fixed 2026-09-09:** `run-local-agent.ps1` calls
`comfy-install.js --stop` in its teardown, beside the dialog watchdog it
already stops for exactly the same stated reason — nothing this loop
started for its own convenience may outlive it on a machine nobody is
driving. `--stop` verifies the recorded PID is a live ComfyUI before
killing anything and exits 0 saying `no managed backend found` when the
passes never booted one, so it is safe on every path.

**Not yet verified.** The teardown has never run at the end of a real
overnight loop. That is NEXT UP item 1: the morning log must carry a
`Backend:` line, and the card must be free. Until a night has shown it,
this is a fix that has only been reasoned about.

Worth keeping: `scripts/lib/comfy-managed.js:15` already recorded
"a backend was booted, the owner went to play a game, and --stop was a
no-op" from 2026-09-06. That was the PID RECORD not surviving, and it was
fixed. This was the same symptom from the other end — the record was fine
and nothing ever called stop. The same sentence describes both, which is
why the fix has to be a caller, not another guard.

## 17i. llama-server has the same lifetime bug the managed backend just had (filed 2026-09-09, local session)

`extension/js/llama.js:274` spawns `llama-server` with
`{ cwd, windowsHide: true }` and no `detached`, which on Windows puts it
in the parent's job object — measured 2026-09-09, such a child dies the
moment its parent exits, and `unref()` does not change that.

So `llama.js:247`'s reap, commented *"kill a survivor from an earlier
session"*, can never find one: there are no survivors. The reap is
unreachable rather than load-bearing — the same shape as the §21
watchdog rule keyed on "recover".

Deliberately NOT fixed alongside the ComfyUI one (2026-09-09): the
managed backend had a script path that needed survival, and llama has no
equivalent caller yet. Flipping it would leave a 32B model holding RAM
after AE closes, for no current benefit. The work here is to DECIDE:
either give llama the same opt-in seam, or delete the reap and say
plainly that the server dies with the panel. What must not stand is code
that reads as coverage for a case that cannot occur.

## ~~17j. The detached backend leaves no log, so its deaths are undiagnosable~~ DONE 2026-09-09 (0.12.6)

**DONE, and it was never only a logging item — the piped stdio was
BREAKING every generation.** With `detached: true` and the default piped
stdio, the child holds pipes whose reader dies with the launcher.
ComfyUI's tqdm progress bar calls `sys.stderr.flush()` the moment
sampling starts, Windows answers a dead pipe with `OSError [Errno 22]
Invalid argument`, and the prompt dies at the first sampler node. So
EVERY generation on a script-booted backend failed — the one
configuration no buyer's panel uses and every unattended pass does.

The refutation quoted below is not wrong, it is answering a different
question: the backend does keep SERVING (`/queue`, `/history`,
`/object_info` all answer 200 indefinitely, because nothing on those
paths writes to stderr). It is EXECUTION that cannot survive, and §17f
hid that — `res_2s` stopped KREA2 at validation, so until today nothing
had ever reached a sampler on a detached backend.

`bootManaged` now opens `<dataRoot>/comfy-managed.log` when
`managedDetached` is set and passes its fd as both stdout and stderr,
rotating one generation to `comfy-managed.prev.log` so the boot that
comes to investigate a death does not erase it. Boot-failure messages
read that file's tail and name its path; the panel path keeps its
in-memory `errTail` unchanged. Verified in the field: the identical
`comfy-probe` run went from `execution error [Errno 22]` at 4s to a
2.1 MB 1232x1232 PNG at 14s with only this changed. Stub back-fill is
test 4d in `tests/test-comfy-backend.js`, and `spawnRecorder` there now
models real Node (an fd stdio slot has no pipe object, so
`child.stdout` is null).

Still OPEN and NOT answered by this: whether the backend stays up for
half an hour. There is now a log to read when it does not.

<details><summary>Original filing</summary>

Measured 2026-09-09: the managed backend, booted detached by a script,
served two later independent processes and answered six polls over two
minutes — then was gone within the half hour. Twice. Cause unknown, and
unknowable as things stand.

`bootManaged` (`comfy.js`) pipes the child's stdout/stderr into a
600-byte in-memory `errTail` used only for boot-failure messages. That is
right for the PANEL, where the host process outlives the backend and can
read it. For a SCRIPT-launched backend the launcher exits within seconds,
after which ComfyUI's output has no reader and is written nowhere: the
data root holds only `comfy-managed.pid` and `settings.json`, and the
portable install carries no log of its own.

**The work.** When `setManagedDetached(true)` is in effect, point the
child's stdio at a file under `Settings.dataRoot()` (append, rotated or
truncated per boot) instead of pipes. Boot-failure reporting should then
read that file's tail, which is strictly more than the 600 bytes it keeps
today. Leave the panel path on its in-memory tail.

Do NOT bundle a survival fix into this. The obvious theory — that the
child dies writing to a pipe whose reader is gone — was TESTED on
2026-09-09 and refuted: it kept answering 200 under sustained traffic
with the launcher long dead. This item buys the evidence needed to find
the real cause; it is not itself the cause.

Wanted by §18: those passes need a backend that stays up between them,
and right now a pass that finds it gone has nothing to read.

</details>

## 23. Expansion roadmap — the six basics grow IN TANDEM (design pass, filed 2026-09-09)

**Authoritative document: `docs/proposals/expansion-roadmap.md`.** Read
it before taking anything here; it carries the reasoning, the context
pricing and the "would not build" list. This section is the queue view.
Filed by a read-only design pass at the owner's direction (no backend,
no GPU, no AE were touched). Nothing here is started. **Does not touch
NEXT UP** — items 1-15 there come first; take these when that table is
exhausted or when an item there is blocked and one here needs nothing.

The rule these items encode: a capability enters as an ARG on
`comfy_generate` plus a handler in `injectParams` (shared, every
template gains it), or as a SIBLING file under the §18 naming contract
(per-template, measured, never an edit to a basic), or in the OPT-IN
layer behind §22d (packs). The bundle stays strictly `(comfy-core)`;
§22a's pin refuses `optionalNodes` in the bundle too.

Measured today (`node tests/test-context-budget.js`): compact prompt
39,803 of 40,000, full 58,933 of 59,000. **Nothing below that touches
the prompt lands without a cut from 23a.**

### 23a. Four stale prompt lines buy a refusal — cut them (takeable, bumps, chat-probe gated)

Measured off `tools.js` 2026-09-09, all in BOTH prompt forms:

| text | chars | why it is stale |
|---|---|---|
| rules block: "Pass image: <absolute path> to give a video template a first frame; omit it for text-to-video" | 121 | no shipped template accepts an image (§18 P9a); the panel REFUSES this with a grounded error |
| rules block: "Some video templates set length in SECONDS (durationSeconds)... re-call with durationSeconds" | 126 | no shipped basic declares `procedural.durationSeconds`; all six carry a literal `length` |
| `comfy_generate` args: the parenthetical "(the size the template GENERATES at, which is not always the size it saves: a template that upscales between passes...)" | 188 | describes the authored KREA2 graph, which left the bundle in 0.12.13 |
| rules block: "Match width/height to the target comp when it makes sense" | ~55 | false once 23c lands (the panel does it) |

Cut the first three now (replace the parenthetical with "(generation
size; the result reports the size imported)"); the fourth goes with
23c. Each cut is gated on `chat-probe --variants` like every prompt
edit, and the ratchet in `tests/test-context-budget.js` moves DOWN with
it so the bytes are banked, not spent by the next unrelated addition.
The image line comes BACK, reworded to cover image AND video, in 23e.

### 23b. The modes coverage matrix, the sibling measured-block rule, and the derive rule (takeable, tests only, no bump)

Three rules in `tests/test-workflow-bundle.js`, all two-way so nothing
joins or leaves quietly:

1. **`MODES_SHIPPED`** — per catalog entry, the list of `<MODE>` tokens
   the bundle ships (`T2I`/`T2V` today for all six). The §22e matrix
   extended to modes; roadmap §4 is the target table.
2. **A non-basic sibling carries its own measured block** in its
   manifest (`measuredVramMB`, `measuredSeconds`, `measuredAt`,
   `measuredOn`), and `workflowFacts.fits` (`tools.js`) reads an
   optional manifest `minVramGB` that may only be HIGHER than the
   entry's. A sibling may raise its entry's floor, never lower it.
3. **`derivedFrom: {workflow, differs: ["<nodeId>.<input>", ...]}`** —
   a manifest key whose consumer is a rule asserting the two graphs are
   identical outside the listed inputs. Generalises the §18 P10 "H3
   siblings differ in exactly the encoder and the prefix" pin. This is
   what lets a fp8 Wan entry (§18 P7c) inherit Wan's siblings without
   hand-authoring, and what stops a derived file drifting.

Needs nothing. Lands before 23f's first sibling.

### 23c. Generation lands in the COMP, at the comp's size (takeable, bumps)

Roadmap group A. `comfy_generate` imports via `import_file`, which its
own doc says puts the file "into the PROJECT PANEL only". Usefulness
test G2 flags "the known gap is stopping at the project panel"; it was
filed nowhere until now.

- `comp?: string` on `comfy_generate` (+14 chars, paid by 23a's fourth
  cut). When present, import through `import_as_layer` (reuse + reload,
  fit to comp — §5.8 measured) instead of `import_file`.
- When no `width`/`height` is named and a comp is known: IMAGE
  templates get the comp's size snapped to the width/height input's
  declared `step` from the backend's `/object_info` (fetched already by
  `validateGraphInputs`); VIDEO templates get the template's AUTHORED
  pixel count at the comp's ASPECT — the measured seconds were taken at
  the authored size and time is the adherence constraint on video.
  Convert the spec, never recompute it.
- One selftest step for the placement; one chat-probe variant, G2
  verbatim. The snap rule is checked against a running backend for all
  six templates in one `comfy-probe --no-ae` pass (overnight, this
  machine).

### 23d. A pre-queue time line, labelled by card (takeable after 23c, bumps)

Roadmap group B's one addition. Before the POST, say "about N s on an
RTX 5090 at this size" from the entry's `measuredSeconds` scaled by
pixels and frames. That scaling is REASONING from one reading, so it is
labelled "on the reference card", never used to refuse, and on an
unmeasured card the line says so. Zero prompt bytes (progress sink).
§18 P3c (NEXT UP 4) and P3a(b) (owner) are the rest of group B and are
not re-filed here.

### 23e. "Start from a frame": the shared plumbing (takeable, bumps, needs backend for one measurement)

Roadmap group C, shared half. One pass:

1. `denoise?: number` on `comfy_generate` (+38, paid by 23a). Try the
   GENERIC walk first — `KSampler.denoise` and `BasicScheduler.denoise`
   are literal numerics like `seed`; add `procedural.denoise` (the hook
   §18 named) only for a graph where the walk provably cannot land it.
   Bundle test replays it.
2. Reword the rules-block image line (23a) to cover image AND video at
   the same byte count.
3. **The §18 P9a placeholder measurement:** a `LoadImage` in an API
   graph must name a file that exists in the backend's input folder or
   `validateGraphInputs` refuses the template before it is queued. Find
   a placeholder a FRESH managed install actually has. Measured, not
   guessed; gates every sibling in 23f.
4. `catalog-vram-probe` needs to measure a template by NAME, not only
   by `--entry` (which runs the entry's `workflowTemplate`). Check
   whether a `--workflow` flag already exists before writing one.

### 23f. "Start from a frame": one sibling per pass, each measured (takeable after 23b + 23e; backend + disk; each bumps)

In this order, one per pass, proven end to end, the §18 P9 rule:

| # | sibling | shape | note |
|---|---|---|---|
| 1 | `AE_LLAMA_SD15_I2I_V1` | sd15 basic + `LoadImage -> VAEEncode` into `KSampler.latent_image`, denoise 0.6 | proves the whole sibling mechanism at 4 s per render |
| 2 | `AE_LLAMA_H3_I2V_V1` | H3 basic + `LoadImage` into `MiniMaxH3ImageToVideo.first_frame` (OPTIONAL, measured §18 P9a) | §9 item 5 "animate this frame" |
| 3 | `AE_LLAMA_WAN22_5B_I2V_V1` | Wan basic + `LoadImage` into `Wan22ImageToVideoLatent.start_image` (OPTIONAL, measured §18 P9a) | — |
| 4 | `AE_LLAMA_SDXL_I2I_V1` | derived from #1, ckpt swap | `derivedFrom` |
| 5 | `AE_LLAMA_KREA2_I2I_V1` | krea2 basic + `VAEEncode` into `SamplerCustomAdvanced.latent_image`, denoise on `BasicScheduler` | 4-step distilled at partial denoise: quality unmeasured too |
| 6 | `AE_LLAMA_H3_INT8_I2V_V1` | derived from #2, encoder swap | `derivedFrom`; the P10 pattern |

Every class name is confirmed against a RUNNING backend's
`/object_info` at authoring time — not from the roadmap, not from
`scripts/comfy-node-defs.json` (§17l). **All six are UNMEASURED
today.** Two `catalog-vram-probe` runs each at the authored size and
length, the reading into the sibling's manifest (23b rule 2), the
`IMAGE_CAPABLE_SHIPPED` list in `test-workflow-bundle.js` grows by one
per pass with its reason, `MODES_SHIPPED` with it. Closes §18 P9a
(NEXT UP 10) as a side effect of #2 — do not also take P9a separately.

### 23g. "Fix just this part": inpainting, core-only, siblings for the image entries (after 23f; backend, AE)

Roadmap group D. The plan is `docs/SELF-VERIFY-PLANS.md` §3 and §9
item 9; this item PLACES it and settles two costs:

- **The mask comes from `snapshot_frame`, not a new tool, if AE lets
  it.** An `alpha?: bool` (+13 chars) writing the comp's alpha as the
  mask costs ~200 chars less than an `export_mask` tool definition.
  Measure in real AE whether `saveFrameToPng` carries alpha for a comp
  with a transparent background — §5.8 did not ask. If it does not,
  `export_mask` as planned.
- **`repaint_region` is built only if measured necessary.** Ship the
  plumbing (`mask?: string`, +30, paid by 23a; second upload;
  `procedural.maskImage`; mask-landed fail-fast; width/height stripped
  when a mask is present) and the siblings `AE_LLAMA_SD15_INPAINT_V1`
  -> `_SDXL_` -> `_KREA2_`, each measured; then put the three-call
  chain in front of `chat-probe --variants`. The compound tool (~240
  compact chars) lands only if the chain fails there, with its cut
  named in the same commit. PLAN §8's `kind?` rule, applied again.

Video inpainting is not built (roadmap §5).

### 23h. The opt-in layer's first siblings (after §22d and 23c-23g; each measured or dropped)

Roadmap group E. Packs, therefore never in the bundle; seeded into the
opt-in folder only after §22d installs the pack; degrade through
`resolveOptionalNodes`, the machinery that already ships. In order:

1. `AE_LLAMA_H3_T2V_FAST_V1` — the five model-chain patches the H3
   basic DROPPED (SageAttention / first-block cache / scheduled
   attention). UNMEASURED against the basic at one seed and size; if
   the delta is not a real fraction of 253 s, not shipped.
2. Frame interpolation for the video entries (RIFE/FILM class packs).
   UNMEASURED, and AE's Timewarp does this on the timeline; ship only
   if the ComfyUI path measures faster end to end.
3. `AE_LLAMA_SDXL_CTRL_V1` — ControlNet + preprocessor pack, "keep my
   layout" from a `snapshot_frame`. UNMEASURED; a 2-3 GB control weight
   to pin.

### 23i. Stale copy the roadmap found, filed so it is not found again (takeable, docs/tests, no bump except tiers.js)

- `tiers.js` TIERS copy: T3/T4 promise "short Wan clips" (Wan gates at
  32, measured), T4 promises "Flux/Krea at 1024px" (krea2 gates at 24,
  measured), T5-T7 promise "Wan 14B" (not a catalog entry). §16 knows;
  §22b/§22c will put this copy in front of a buyer on first run, so it
  becomes wrong the day §22c ships. Rewrite from the measured catalog
  and pin a test that the copy names no entry the catalog lacks.
- `docs/CAPABILITIES.md` curated half still says "the remaining blocker
  is P4 ... measured on real hardware" and "the Krea 2 workflow now
  ships adapted and runnable with a dependency manifest". P4 is done
  (`ALLOW_UNMEASURED` is empty); the authored KREA2 left the bundle.
- `docs/proposals/README.md` lists the templates plan as "not built".
- Three manifests say `resolutionCeilingFrom: tier ceilings` and
  `COMFY_TIERS_PLAN.md` says templates read per-kind ceilings; nothing
  in `tools.js` or `comfy.js` reads one. Delete the manifest lines or
  the plan sentence; 23c is the size rule that actually exists.
