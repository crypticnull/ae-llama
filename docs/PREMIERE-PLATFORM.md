# Premiere platform — what is measured, and what is not

Companion to `docs/PREMIERE_PLAN.md`. That file is the plan; this file is
the **evidence ledger**. Nothing may be promised in a tool doc, a system
prompt, a README, a release note or store copy unless it has a MEASURED
row here.

Grades used throughout:

| Grade | Meaning |
|---|---|
| **MEASURED** | Run on the owner's machine; the result file is committed under `docs/measured/`. |
| **ADOBE-SRC** | Quoted verbatim from an Adobe documentation-source repository. Believed accurate, not executed. |
| **SNIPPET** | Web-search summary of a page nobody here could open. Treat as a lead, never as a fact. |
| **UNVERIFIED** | Nobody has checked. |

> A missing measurement is never a pass. `scripts/ppro-probe-report.js`
> enforces the same rule mechanically: every row it prints is
> MEASURED / MISSING / FAILED, and Gate G0 can only pass on MEASURED
> rows. This exists because the panel already shipped one failure of
> exactly that shape — an unattended probe read pure defaults with no
> `APPDATA` and filed them as the owner's configuration, and two
> sessions repeated the claim before anyone checked.

## 1. Platform horizon (ADOBE-SRC — confirm once in P0 step 6)

- `docsforadobe/premiere-scripting-guide` `docs/index.md`: "ExtendScript-based
  integrations are still supported, and the plan is for them to remain so,
  **through September 2026**."
- `docsforadobe/premiere-scripting-guide` changelog, Premiere 23.0: "No
  further changes or improvements to Premiere Pro's ExtendScript API are
  planned or scheduled."
- `Adobe-CEP/Samples` `PProPanel/ReadMe.md` (Nov 2025): "As of Premiere Pro
  25.6, CEP extensions to Premiere Pro have been superseded by UXP
  Extensibility. If you are starting new development, start in UXP. CEP
  extensions continue to be supported; the plan is to support both CEP and
  UXP **for a calendar year**, after which we will remove support for CEP
  extensibility."
- `AdobeDocs/uxp-premiere-pro`: UXP has no `child_process` (`launchProcess`
  only opens files/apps; `network` permission allows fetch/WebSocket);
  packaging is `.ccx`; there is no After Effects UXP host; UXP Hybrid (C++)
  plugins arrived in 26.2.

**The dated tripwire** (`PREMIERE_PLAN.md` P5): the UXP decision is due at
the first Premiere release after P3, or **2026-11-01**, whichever comes
first. No Premiere work beyond the MVP starts after the first Premiere
release in which the P0 probe fails, or after **2026-11-30** without a
fresh Adobe statement extending CEP.

## 2. What Adobe ships natively (P0 step 6 — NOT YET MEASURED)

This section gates every "Adobe does not do X" phrase anywhere in the
product. It is empty on purpose: the research pass's competitive read was
true in April 2026 and stale by June, when Adobe's cloud, credit-metered
**Premiere AI Assistant** entered public beta covering bins, labels,
markers, transcripts and stringouts.

Fill it from the owner's own install: open the AI Assistant, record what
it does, what it refuses, whether media is uploaded, and how credits are
consumed. Until then, no tier heading, prompt line or listing may claim
a native gap.

| Capability | Native? | Cloud/credits? | Measured on | Notes |
|---|---|---|---|---|
| _(unmeasured)_ | | | | |

## 3. Unverified, with the step that measures each

| Claim | Grade | Measured by |
|---|---|---|
| CEP panels list and open in Premiere 26.x | **MEASURED: yes, 26.3.2** | done |
| …and in the 27.0 beta | UNVERIFIED | P0 step 3 |
| aescripts ZXP/UXP Installer accepts a two-extension bundle | UNVERIFIED | P0 step 1 |
| One aescripts licence can back two host listings | UNVERIFIED | P4 (ask aescripts) |
| Exact `appName` string Premiere reports | **MEASURED: `PPRO`** | done |
| CEP API version Premiere 26 uses | **MEASURED: 12.0.1, i.e. CEP 12** (the CSXS.13/14 claim is not borne out) | done |
| `localStorage` scoping across hosts for one extension id | **MEASURED: per-host, isolated BOTH directions** | done |
| `AutoVisible` actually opens a panel in Premiere | SNIPPET (reported not to) | P0 step 1 |
| `$.engineName` per host | **MEASURED: `main` (AE), `NewWorld` (Premiere)** | done |
| ExtendScript engine degradation over a long session | **MEASURED: 500 round-trips survived in both hosts** | done at this size |
| Undo grouping exists in Premiere ExtendScript | **MEASURED: NO** (beginUndoGroup/endUndoGroup/executeCommand/findMenuCommandId all undefined) | done |
| BridgeTalk AE→Premiere delivery | target `premierepro` is LISTED from AE (measured); delivery still unproven | P0 step 4, door 1 |
| `/C es.processFile` + `extendscriptprqe.txt` on 26.x | SNIPPET (confirmed only CC2019 / 2024) | P0 step 4, door 2 |
| Invisible `StartOn` extension fires in Premiere | ADOBE-SRC (sample) + SNIPPET; Adobe's own manifest comments the event as firing on **every OS focus gain** | P0 step 4, door 3 |
| `importMGT` still works on 26.x; text set blanks the value | **MEASURED: works, and the text does NOT blank** — 4 controllers read back by name, Source Text still `HELLO` | done |
| A TrackItem carries a stable `nodeId` on 26.3.2 | **MEASURED: yes** (`000f4241`), and it survives the clip being pushed down the track | done |
| `exportAsMediaDirect` on 26.x | SNIPPET (a "not working on 2025" thread title, unread) | P1 |
| QE mutates (razor/ripple/effect params) on 26.3.2 | QE is reachable and lists 236 effects (**measured**); whether it MUTATES is not | P1 |
| A hybrid `.uxpaddon` can spawn a process | UNVERIFIED | P2 spike |
| Transcript export formats that carry timecode | SNIPPET (sources disagree) | P0 step 6 |
| The exact Premiere version that drops CEP | Nobody states it | every release |

## 4. Measured results

### 2026-09-02 — the probe did not load: an illegal XML comment

**MEASURED.** All four probe manifests contained `--` inside an XML
comment. XML 1.0 §2.5 forbids it, so the file does not parse, and CEP
reports a parse failure nowhere a user can see: the extension is simply
absent from `Window > Extensions`.

Environment on the owner's machine was correct throughout, and this is
what makes the failure mode worth writing down: `install-probe.ps1`
reported a clean run, the junction resolved, `PlayerDebugMode` was
already 1 on CSXS.10/11/12, and the AE Llama panel itself loads from the
same folder. Nothing was wrong except one character.

**A retraction.** Before `scripts\probe-doctor.ps1` existed, the first
diagnosis was "shape A (per-extension `HostList`) does not load" — a
claim about Adobe — and the default was switched on that basis. That
was wrong. Both shapes were malformed, so **neither has ever been
parsed, and the manifest-shape question is still completely open.**

Shape B remains the default, on the original evidence rather than on
this failure: every shipped multi-host CEP manifest anyone found uses
one `HostList`. Shape A stays in `manifest-shape-a.xml` and deserves a
real test now that a manifest actually parses.

The generalisable lesson, and the reason it cost a round trip: a
malformed manifest and a rejected-but-valid one are **indistinguishable
from the Extensions menu**. `tests/test-manifest-xml.js` now refuses
either kind of unparseable XML in this repo, in milliseconds, without an
Adobe app.

### 2026-09-02 — the probe panel loads in After Effects (AE 26.3)

**MEASURED**, first successful run, `runtime-AEFT.json`:

| Fact | Value |
|---|---|
| `appName` / `appId` | `AEFT` (so the string host.js branches on is confirmed for AE) |
| `appVersion` | `26.3` |
| CEP API version | **12.0.1** — Adobe's table said "AE 25.0 = CEP 12"; 26.3 is still CEP 12 |
| CEP user agent | Chrome 99.0.4844.84, `AdobeCEP/12.0.1` |
| Node in CEP | **17.7.2**, with `fs`, `path`, `http`, `child_process`, `os`, `process` all requirable |
| `cep.fs.showOpenDialogEx` | present |
| Manifest shape installed | **B** (one `HostList`, both hosts) — it parses and lists |
| `localStorage` | AE wrote `aell.probe.AEFT`; the cross-host half needs Premiere's panel opened next |

This settles the two load-bearing assumptions under the whole plan: a
CEP panel from a junction lists and opens in a current Adobe host, and
CEP's Node can spawn processes — which is what the llama-server,
ComfyUI, ffmpeg and whisper stack all rest on.

### 2026-09-02 — GATE G0 PASSED: the panel loads and works in Premiere 26.3.2

**MEASURED**, `runtime-PPRO.json`. This is the answer the whole plan was
gated on.

| Fact | Premiere | After Effects | Note |
|---|---|---|---|
| `appName` / `appId` | **`PPRO`** | `AEFT` | the strings `host.js` branches on, both confirmed |
| `appVersion` | **26.3.2** | 26.3 | |
| CEP API version | **12.0.1** | 12.0.1 | Premiere 26.x is **CEP 12**. The third-party "CSXS.13/14 required for Premiere 2026" claim is not borne out; Adobe's own table was right. |
| CEP Node | **17.7.2**, `child_process` / `fs` / `http` / `os` / `path` / `process` all requirable | same | the llama-server, ComfyUI, ffmpeg and whisper stack is viable in Premiere |
| `cep.fs` | present | present | |
| ExtendScript | **4.5.6, build 80.1060872** | 4.5.6, build 80.1060872 | **identical engine build** — every ES3 rule in CLAUDE.md (no `JSON`, left-associative `?:`) binds Premiere code too |
| `$.engineName` | **`NewWorld`** | `main` | different per host; never key state on it |
| `$.os` | `Windows 7/64 6.2` | `Windows/64 10.0` | Premiere's ExtendScript reports a **stale OS**; do not branch on `$.os` there |
| 500-round-trip soak | **survived**, 6.7 s | survived, 5.5 s | no engine degradation in either host at this size |
| Manifest shape B | parses, lists, opens in BOTH hosts from ONE bundle | | the "one ZXP, two hosts" mechanism is proven |

**No undo API in Premiere — confirmed by measurement, not just docs.**
`app.beginUndoGroup`, `app.endUndoGroup`, `app.executeCommand` and
`app.findMenuCommandId` are all `undefined` in Premiere and all
`function` in AE. So AE's one-Ctrl+Z-per-round design does not transfer,
and **STOPPED AT #k is the permanent batch contract** for Premiere. The
plan already deleted the `Host.supportsRollback` branch; this is why.

**QE is alive on 26.3.2.** `app.enableQE` is a function, `qe.project`
resolves, `qe.version` is `26.3.2`, and `getVideoEffectList()` returned
**236 effects**. That contradicts the third-party report that 26.3
installs have QE broken — but note carefully what is measured: QE can be
entered and can LIST. Whether `addVideoEffect`, `razor` and
`rippleDelete` actually mutate is a different question and is still
unmeasured (P1).

**BridgeTalk sees both hosts from both sides.** From AE and from
Premiere, `BridgeTalk.getTargets()` returned the same list:
`aftereffects, bridge, photoshop, illustrator, indesign, premierepro,
ame`. Specifiers are `aftereffects-26.0` and `premierepro-26.0`;
`BridgeTalk.appName` is `aftereffects` / `premierepro`. So door 1 has a
real target name to aim at — though a listed target proves addressing,
not delivery, which is what `ppro-door-probe.ps1` measures.
`BridgeTalk.getStatus("ame")` returned `ISNOTRUNNING` (installed, not
running) in both hosts, so the gate Adobe's own sample uses before
queueing an export works here.

**Premiere DOM sanity:** `app.project` is an object,
`app.project.name` = `Untitled.prproj` with a real `path`,
`rootItem.children.numItems` = 0. `app.appName` is `null` in Premiere
(AE returns `After Effects`), and `app.project.numItems` is `null` — an
AE-only property. `importMGT` and `exportAsMediaDirect` threw
`null is not an object` because **no sequence was open**; both need a
sequence and are still to be measured.

**`localStorage` is PER-HOST, not shared per extension id.** AE's panel
wrote `aell.probe.AEFT` at 20:31:51; Premiere's panel opened at 20:32:42
and saw only its own `aell.probe.PPRO`. Two consequences, and they point
opposite ways:

- The cross-kill risk is smaller than feared: one panel's orphan reaper
  cannot read the other's PID record, so it cannot kill the other's
  llama-server or ComfyUI through that path.
- But neither can a second panel DISCOVER a running server that way. So
  the lease file under `Settings.dataRoot()` is **required**, not an
  optional nicety — `localStorage` cannot carry cross-host state at all.

**Confirmed both directions.** AE's panel was reopened at 20:44:18,
twelve minutes after Premiere wrote `aell.probe.PPRO` at 20:32:42, and
still saw only `aell.probe.AEFT`. Neither host can see the other's
storage for the same extension id.

### 2026-09-02 — `importMGT` fails SILENTLY on a bad capsule

**MEASURED**, and it is the strongest argument in the plan for making
read-back receipts mandatory.

The panel auto-filled the MOGRT path with the newest `.mogrt` in
`logs\mogrt-verify\` and picked **`truncated.mogrt`** — a deliberately
damaged fixture that lives there because the reader tests need one.
`sequence.importMGT()` was called with it and **did not throw**. It
returned normally, and the V1 clip count went `1 -> 1`.

So the only thing separating "Premiere accepted our graphic" from
"Premiere silently ignored it" was the read-back:

```
importMGT returned without throwing but the track's clip count did not
grow (1 -> 1) -- accepted by API, state unchanged
```

A tool that try/catches `importMGT` and reports success on no exception
would have reported a successful import of a corrupt file. This is the
same failure shape the third-party reports describe for QE
`razor`/`rippleDelete`, now measured on a **vanilla, documented** API —
which is why the plan's rule is "a mutator's return value is never the
receipt", for native tools as much as QE ones.

Two repairs followed: the picker now validates a candidate is really a
zip with a `definition.json` before choosing it (and records every
candidate with its verdict), and `tests/test-probe-bundle.js` drives
that validator against a good capsule, a truncated one, a non-zip and a
zip without a definition — each rejected by its own rule rather than by
the size floor.

**Still owed:** the actual acceptance measurement, against a real AE
export. What is measured so far is the failure path, not the success
path.

### 2026-09-02 — `$.fileName` in a CEP `ScriptPath` is not a path

**MEASURED in both hosts.** The manifest's `ScriptPath` *is* evaluated,
but `$.fileName` inside it is not a path:

| Host | `$.fileName` returned | `new File(that).parent.fsName` |
|---|---|---|
| After Effects 26.3 | `"7"`, then `"8"` on the next launch | `C:\Program Files\Adobe\Adobe After Effects 2026\Support Files` |
| Premiere 26.3.2 | `""` (empty) | `C:\Program Files\Adobe\Adobe Premiere Pro 2026` |

Note the AE column: the value **changed between launches**, so it is a
small counter of some kind, not even a stable token. Anything that
parses or caches it is building on sand.

The trap is the second column. Neither return value is a path, but
`new File()` treats both as **relative**, resolves them against the
host's working directory, and hands back something that reads exactly
like a real answer — the host's own install folder. The first write-up
here recorded that folder as the measurement; it was an inference from
the symptom, and this table replaces it.

So shape B's loader looked for `probe.jsx` next to the executable, found
nothing, and every probe call returned an empty string because
`AELLP_call` was never defined.

Once the file is loaded properly, `$.fileName` inside it is correct
(measured: `/c/Users/.../jsx/probe.jsx` in both hosts), so this is
specific to ScriptPath evaluation.

Consequences, and they reach past the probe:

- **A `ScriptPath` loader cannot locate its own siblings.** Shape B's
  whole premise was "point `ScriptPath` at a loader that branches on
  host and `$.evalFile`s the right body". That premise is now measured
  false as written; a loader would need the path from somewhere else.
- The fix is what `extension/js/main.js` has always done: the PANEL
  calls `$.evalFile` with the absolute path from
  `getSystemPath("extension")`. The probe page does that now.
- So a dual-host panel does not actually need `ScriptPath` to branch —
  each host's page can load its own jsx. That weakens the argument for
  shape A (two extensions purely so each gets its own `ScriptPath`) and
  is worth re-weighing before the P2 seam is designed.

Also fixed as a result: the soak reported `DEGRADED at round 1` when the
truth was that `probe.jsx` had never been evaluated. It refuses to run
now rather than blame the engine, and the grader treats a skipped soak
as unmeasured instead of failed.

### 2026-09-03 - a project on the command line is NOT a way to open one

Four unattended runs of `scripts\run-ppro-probe.ps1` on **26.3.2 / CEP
12.0.1**, artifacts in `docs/measured/ppro-probe-2026-09-03-*.json`.
They were a controlled comparison, run by run:

| run | scratch `.prproj` on disk | launched with it | `project` step |
|---|---|---|---|
| 0311 | yes (left by a killed instance) | yes | FAIL |
| 0314 | no (moved aside) | no | **ok** - created + saved |
| 0316 | yes (written by a CLEAN close) | yes | FAIL |
| 0320 | yes, archived by the fix | no | **ok** - created + saved |

Measured, all MEASURED-grade:

- **Premiere does not open a project handed to it as its only
  command-line argument.** `app.project.name` was still empty after the
  full 30 s `waitForReady`, and `app.project.rootItem` threw
  `null is not an object` - it sits on the Home screen. Runs 0311 and
  0316 differ only in who wrote the file, so a damaged or half-written
  project is NOT the explanation.
- **What it does instead is raise a modal that is wrong on its face:**
  `This file path does not exist on disk at this location.` naming a
  path that holds a 14216-byte valid-gzip `.prproj`. It carries no
  answerable button the dialog harvester can match, so an unattended
  close times out and the instance has to be forced.
- **`app.newProject(path)` refuses a path that is already taken** -
  returns `false`, leaves `app.project.name` empty, and drops a
  `AELL_PROBE_SCRATCH<guid>` sidecar next to the target. Against a FREE
  path it creates the project, and `app.project.save()` then writes it.
- **`app.openDocument` exists on this build** (`typeof` is `function`;
  `hostFacts` records it and `app.newProject` from 2026-09-03 on). It
  is the only project-opening call with suppress-the-dialog flags, so
  it is what the probe uses when the path is already taken.
- **`app.project.rootItem.createBin` works** - `history` measured for
  the first time on 0314 (three bins created, cleanup removed them).
  Whether three `createBin` calls make one History entry or three is
  still unmeasured: it needs a human at the History panel.

Consequence for anything that has to drive Premiere unattended: get the
project from ExtendScript, never from the command line, and never
inherit the last run's project file.

### 2026-09-03 - a sequence WITHOUT a dialog, and how the route was lost

Unattended run `docs/measured/ppro-probe-2026-09-03-0413.json`, **26.3.2
/ CEP 12.0.1**. MEASURED:

- **`importFiles` + `createNewSequenceFromClips` makes a sequence with
  no dialog and no preset.** Importing one still
  (`extension/icons/icon-normal.png`) and handing that project item to
  `createNewSequenceFromClips("AELL PROBE SEQ", [item])` produced an
  active sequence with **3 video tracks**, first try. This is the route
  to use unattended: `createNewSequence(name, "")` opens the New
  Sequence dialog and `newBarsAndTone` answered `Illegal Parameter type`
  at every timebase tried.
- **The bars route was never the problem.** The step's earlier
  `Illegal Parameter type` was attributed to
  `createNewSequenceFromClips`; with a real imported clip that same call
  succeeds, so the rejected parameter was whatever `newBarsAndTone`
  returns (or does not return) on this build, not the sequence call.
- **How it stayed unmeasured for a day:** the job carried `seedMedia`,
  and BOTH doors built the battery's arguments from a hand-maintained
  whitelist that did not name it. The route never ran, and because the
  guard is `if (args.seedMedia)` it did not appear in the step's own
  `tried` list either - so the evidence said "not applicable" where the
  truth was "never delivered". Both doors now forward every job field
  they do not own themselves; `tests/test-probe-bundle.js` §8 fails if
  either one goes back to a list.
- **`mogrt` is measured for the first time and FAILS**: `importMGT`
  landed (track clip count 1 -> 2) but the probe read back
  `clips[after - 1]` and got **`icon-normal.png`**, the seed still - so
  the last index is not the clip just added, and `getMGTComponent`
  returned null on the wrong clip. Next 12b pass; controller read-back
  on this build stays UNMEASURED until then.

### 2026-09-03 - Premiere ACCEPTS what AE writes, and the last clip is not the new one

Unattended run `docs/measured/ppro-probe-2026-09-03-0510.json`, **26.3.2
/ CEP 12.0.1**. **Every battery step passed** - the first fully green
unattended run. MEASURED:

- **The MOGRT round-trip is readable.** A `.mogrt` written by AE
  (`logs/mogrt-verify/AELL MOGRT Probe.mogrt`) imported with
  `seq.importMGT(path, "0", 0, 0)`, and `getMGTComponent()` on the
  landed clip returned **4 controllers, all named**: `Headline Size`,
  `Card Position`, `BG Opacity`, `Headline Text`. The Source Text is
  NOT blanked, which the snippet sources warned of - it reads back as a
  text-run JSON blob still carrying `"textEditValue":"HELLO"` and
  `"fontEditValue":["PowerCentra-Book"]`, so the controller a panel
  would drive is intact. That retires `docs/SELF-VERIFY-PLANS.md` step 7
  on this build: Premiere accepts what AE writes.
- **`clips[after - 1]` is not the clip that was just added**, and this
  is the fact the previous run got wrong. The graphic lands at its
  INSERTION TIME, so it can take any index and push the rest down.
  Measured here, track 0:

  | | before | after |
  |---|---|---|
  | index 0 | `icon-normal.png` @ `0` (node `000f4241`) | **`Untitled` @ `0` (node `000f4242`)** - the graphic |
  | index 1 | - | `icon-normal.png` @ `1008604396800` (node `000f4241`) - the seed, MOVED |

  The old code read index 1 and asked the SEED for its MOGRT
  component; null there reads exactly like "this build cannot read
  controllers back". The probe now diffs the track: `AELLP_clipSnap`
  photographs it before and after, `AELLP_newClip` returns the one clip
  the BEFORE picture cannot account for, and the receipt records
  `pickedBy` so a reader can tell a clean diff from a fallback. It was
  `pickedBy: "diff"` on this run.
- **`nodeId` exists on a TrackItem on 26.3.2** and is the identity to
  use: `000f4241` named the same clip before and after it moved.
  `name` + `start.ticks` is the fallback for a build without it, and it
  is compared as a MULTISET so a clip that merely shares a name with an
  existing one is not called new.
- **The graphic's clip name is `Untitled`, not the .mogrt's file name.**
  Anything that tries to find an imported graphic BY NAME will not find
  it.

### 2026-09-03 - the grader reads the unattended run too

The paragraph the run above filed - **the grader does not grade an
unattended run at all** - is closed. `scripts/ppro-probe-report.js` now
reads BOTH artifacts a probes folder can hold, per ROW and by DATE:

- `job-result.json` (the whole battery, written by an unattended
  `run-ppro-probe.ps1` through the invisible door-3 runner) is
  re-shaped into the same keys the visible panel writes to
  `runtime-<HOST>.json`, so one grader reads either.
- Every row takes the NEWEST source that actually HAS its value, and
  prints which file that was: `[job]` or `[pnl]`, with a `*` when the
  value could only come from the older artifact. A `sources:` line
  above each host block dates both. The merge is by date in both
  directions - a fresh click beats an old battery exactly as an old
  click loses to a fresh one.
- What the runner cannot see is left ABSENT rather than guessed. It
  never enumerates Node modules, `APPDATA`, the CEP API version, the
  manifest shape, `localStorage` scoping or the soak, so those rows
  still come from the panel file and are marked stale when they do.

Graded against the 05:10 all-green run and the 2026-09-02 click that
had been outvoting it, the PPRO block went from **13 of 23 rows
unmeasured - including the stale `FAIL MOGRT ... clip count did not
grow (1 -> 1)`** - to **3 of 27**, with the MOGRT row now reading
`landed, 4 controllers, names readable: true`. The four new rows are
the battery's own steps, which had no grader representation at all:
`9/9 steps ok`, the scratch project, the sequence, the cleanup. The
three still unmeasured for PPRO are the `ScriptPath` `$.fileName`, the
installed manifest shape, and the soak.

Gate G0 also stopped reporting an ABSENT reading as a measured FAIL. It
used to print `FAIL evalScript reaches Premiere's ExtendScript engine
envelope parsed` when there was no evalScript result at all - wrong in
both halves of one line. Absent is UNMEASURED now, for the evalScript,
Node and CEP-present rows alike, which is what this file's standing
rule said all along.

**G0 now stands at three of four rows ok, and NOT MEASURED on the
fourth: the soak.** The 500-round-trip soak is a BUTTON in the visible
panel (`probe/com.cptk.aellama.probe/index.html`), not a step in
`probe.jsx`'s battery, so no unattended run can ever supply it and the
loop cannot close G0 by itself.

*(Closed the same day - but NOT the way this paragraph proposed. "Make
the soak a battery step" would have measured the wrong thing; see the
next entry.)*

The grader is the authority for an unattended run from here; the note
that pointed at the runner's own printout instead is withdrawn.

### 2026-09-03 - GATE G0 PASSES UNATTENDED: the soak, measured where it has to be

**G0: PASS.** All four rows ok, three of them from `job-result.json` -
a run nobody watched. This is the first time the gate closed without a
human clicking anything.

The row that had been structurally unclosable was the soak, and the
obvious fix was the wrong one. **A soak inside `probe.jsx`'s battery
would measure nothing.** What degrades is the engine across evalScript
ENTRIES - the reported failure mode is `InternalError: Stack overrun`
on a long-lived engine, after which every call dies opaquely - and 500
iterations inside ONE evalScript return to the same stack depth every
time. A battery step called `soak` would therefore have reported
"survived 500 round-trips" while never crossing the boundary once: a
false pass on the last row the gate was still honest about, which is
the exact failure class this whole grader exists to refuse.

So the loop lives on the CEP side, in a block both doors keep
byte-identical (`SOAK-SHARED-BEGIN` in
`probe/com.cptk.aellama.probe/index.html` and
`probe/com.cptk.aellama.harness/index.html`), the same rule the
`battArgs` block learned. The door-3 runner drives it from
`job.soakRounds`, AFTER the battery on purpose - an engine that has
just built a project, a sequence and a MOGRT is the long-lived one the
report is about, not a fresh one.

**Measured, Premiere 26.3.2, run `-0630`:**

| | |
|---|---|
| rounds | **500 of 500, survived, `failedAt` null** |
| payload | 2000 bytes echoed and checked each round |
| elapsed | **8190 ms** (~16 ms per round trip, engine + CEP) |
| when | after the full 9-step mutating battery, in the same engine |
| AE 26.3 for comparison | 500/500 in 6607 ms (panel click, 2026-09-02) |

So Premiere's ExtendScript engine does NOT degrade over 500 round trips
of a realistic payload on this build. The third-party "Stack overrun"
report is not reproduced here.

Three things about the shape of the answer, each of which was a way to
get it wrong:

- **A SHORT reply is a degraded engine, not a passing round.** The
  round is graded on the payload coming back whole, not on the call
  failing to throw.
- **A soak that ran out of wall clock is SKIPPED, never survival.** The
  claim being graded is "500 round-trips"; 137 of them does not support
  it. `-SoakBudgetSec` (120 by default) caps it so it can never outlast
  `-TimeoutSec` and turn a green run into "no result", and a run it
  stops reports `STOPPED at round N of 500` with a `skipped` reason -
  which the grader reads as unmeasured.
- **A run that never ASKED for a soak writes no soak reading at all.**
  The grader takes the newest source that HAS a value, so an unattended
  run recording `{skipped: "we did not ask"}` would displace a real
  measurement from the panel file with its own silence. The reason goes
  in `soakNote`, which no row grades. `-SoakRounds 0` therefore leaves
  the row unmeasured rather than answering it.

A soak that hangs also names itself now: it runs after the battery's
last flush, so it writes `job-soak-progress.json` every 25 rounds and
`run-ppro-probe.ps1` reads that file when no result arrives. Without
it, a hang at round 300 would have printed an all-ok battery and no
reason at all.

`tests/test-probe-bundle.js` section 11 drives the real shared loop out
of the page and holds every one of these without Premiere.

### 2026-09-03 - the two rows only a CLICK could answer, and why one of them stays that way

Run `-0902`, Premiere 26.3.2, CEP 12.0.1, unattended. The battery was
green, the soak was green, G0 was PASS - and the PPRO table still showed
two gaps, **neither of them about Premiere**: `manifest shape installed`
and `$.fileName inside the manifest's ScriptPath` were read by the
VISIBLE panel and by nothing else, so no unattended run could answer
them however green it was, and the report printed them exactly like
something the host had refused to say.

**The manifest shape is MEASURED unattended now.** The manifest is a
file and the door-3 runner has `fs`; there was never a reason for that
row to need a click. It finds the bundle by `ExtensionBundleId` under
every CEP extensions root (`%APPDATA%`, both `CommonProgramFiles`
folders) rather than by folder name, and records where it read:

    B (one HostList, loader)
    readFrom  C:\Users\mr\AppData\Roaming\Adobe\CEP\extensions\
              com.cptk.aellama.probe\CSXS\manifest.xml

Two installed copies is a finding, not a tie to break - which root CEP
loads from is not measured, so when the copies disagree the shape is
withheld and both paths are named.

**`$.fileName` inside `ScriptPath` is CLICK-ONLY, and that is now
measured rather than assumed.** `loader.jsx` is the PROBE bundle's
`ScriptPath`; CEP evaluates it when that panel LOADS, and an unattended
run opens no panel. Read from the engine door 3 talks to, the global is
simply absent:

    $.global.AELLP_LOADER_FILENAME is undefined in this engine

Door 3 was NOT given a `ScriptPath` of its own to close the row. "No
ScriptPath: nothing auto-loads into the host's ExtendScript engine" is
the invariant that keeps the invisible runner inert in the owner's AE
and Premiere at every launch, `tests/test-probe-bundle.js` section 5
holds it, and it is worth more than one table cell. What changed is the
REPORT: a row the newest run could not take and SAID SO now grades
**EXPLAINED** and prints `n/a` with the reason, because "nobody has run
this" and "this run cannot answer this, here is why" are different
reports and printing them identically is how a gap that was never about
Premiere sat in the PPRO table looking like one.

**A third defect turned up inside the second.** Premiere's answer for
`$.fileName` in a `ScriptPath` is the EMPTY STRING (measured 2026-09-02,
recorded in section 3 above). Both doors stored it as
`(fname && fname !== "undefined") ? fname : null` - an expression that
throws that answer away, because `""` is falsy - and the grader's picker
skips `""` exactly as it skips a missing key. So the one host the row
exists for would have graded itself unmeasured **while holding the
answer**. The reading is taken in three states now (`unset` / `empty` /
`named`), by one shared block both doors keep byte-identical, and the
empty one is printed as `(the empty string)`. The character count is
taken in the HOST, so a value that did not survive the CEP round trip
is a transport finding rather than a measurement of an empty
`$.fileName`.

Also fixed in the same rule: an unreadable manifest used to grade
`B (one HostList, loader)` - zero HostLists is not more than one - so a
read that found nothing came back as a measurement.

**PPRO now has no `----` row at all**: 26 measured, 1 `n/a` with its
reason. Held without Premiere by `tests/test-probe-bundle.js` section 12
(33 assertions; 10 of them go red against the reverted doors and
grader).

### The rest

Not yet run. P0 writes into `%APPDATA%\AE-Llama\probes\`:

| File | Written by |
|---|---|
| `runtime-AEFT.json`, `runtime-PPRO.json` | the probe panel, per host |
| `csxs-keys.json` | `scripts\install-probe.ps1` (which CEP runtimes were registered **before** it wrote anything) |
| `doors.json` | `scripts\ppro-door-probe.ps1` |
| `door1-bridgetalk.json`, `door1-touch.txt` | door 1 |
| `door2-cli.json` | door 2 |
| `job.json` / `job-result.json` | door 3 |
| `premiere-window-census.txt` | `ppro-door-probe.ps1 -Census` |

When a panel does not appear in a host's `Window > Extensions`, run
`scripts\probe-doctor.ps1` before changing anything. It separates the
six causes that look identical from the menu — not pulled, not
installed, junction wrong, manifest rejected, PlayerDebugMode unset,
host not restarted — and prints what CEP itself logged.

Grade them with:

```
node scripts/ppro-probe-report.js
node scripts/ppro-probe-report.js --out docs/measured/ppro-probe-2026-09-02.json
```

Exit 0 = G0 PASS, 1 = G0 FAIL (measured), 2 = nothing measured.

## 5. Standing rule

Re-run the P0 runtime probe on **every Premiere release** before any
Premiere-side push, and record the result here with its date and build.
A probe that used to pass and now fails is the tripwire firing — that is
the moment the UXP decision in `PREMIERE_PLAN.md` §6.5 stops being
optional.
