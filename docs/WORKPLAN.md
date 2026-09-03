# Work queue — local (real-AE) session

Ordered priorities for the agent running on the AE machine. Work top to
bottom; commit small, tested fixes to the dev branch
(`claude/ae-plugin-llama-cpp-f13g3x`) with clear messages. Big features
and releases stay with the remote session — flag them instead of
building them.

**Before picking anything, read `docs/WORKPLAN-LOG.md`** — it records
what earlier passes already finished. Unattended passes are fresh
sessions with no memory of each other, so without the log every pass
would restart at item 1. Append your entry before you stop.

Unattended runs are driven by `scripts/run-local-agent.ps1` (pull -> one
item -> commit -> repeat). One item per pass, then stop.

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
- **Templates for the template-less entries.** sd15, sdxl and wan22-5b
  have no `workflowTemplate`, which both blocks the probe and lets
  `recommendGen` offer models `comfy_generate` cannot render (the open
  "smaller, for the remote session" item above — fix it HERE, the
  running backend is what makes a template verifiable). Author minimal
  API-format graphs (checkpoint -> sampler -> vae -> save; wan22 per its
  repackaged workflow docs), name them `AE_LLAMA_SD15_V1` /
  `AE_LLAMA_SDXL_V1` / `AE_LLAMA_WAN22_V1`, set `workflowTemplate` on
  the catalog entries, and give each a models manifest with `file`+`dir`
  so the arbiter can price it from the disk. Verify one real render each
  through `comfy_generate` before calling the template shipped.
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
alongside the model downloads and the ComfyUI install that already
happen at first run. Environment paths get exposed in Advanced Settings
for someone with a niche setup, but reaching for them must never be
necessary.

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
