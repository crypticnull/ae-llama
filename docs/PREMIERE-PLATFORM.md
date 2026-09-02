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
| `localStorage` scoping across hosts for one extension id | **MEASURED: per-host, isolated** | done (one direction; re-open AE's panel to confirm both) |
| `AutoVisible` actually opens a panel in Premiere | SNIPPET (reported not to) | P0 step 1 |
| `$.engineName` per host | **MEASURED: `main` (AE), `NewWorld` (Premiere)** | done |
| ExtendScript engine degradation over a long session | **MEASURED: 500 round-trips survived in both hosts** | done at this size |
| Undo grouping exists in Premiere ExtendScript | **MEASURED: NO** (beginUndoGroup/endUndoGroup/executeCommand/findMenuCommandId all undefined) | done |
| BridgeTalk AE→Premiere delivery | target `premierepro` is LISTED from AE (measured); delivery still unproven | P0 step 4, door 1 |
| `/C es.processFile` + `extendscriptprqe.txt` on 26.x | SNIPPET (confirmed only CC2019 / 2024) | P0 step 4, door 2 |
| Invisible `StartOn` extension fires in Premiere | ADOBE-SRC (sample) + SNIPPET; Adobe's own manifest comments the event as firing on **every OS focus gain** | P0 step 4, door 3 |
| `importMGT` still works on 26.x; text set blanks the value | SNIPPET | P0 step 5 |
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

(One direction is measured. Re-open AE's panel now that Premiere has
written its key: if AE also cannot see `aell.probe.PPRO`, isolation is
confirmed both ways.)

### 2026-09-02 — `$.fileName` in a CEP `ScriptPath` is not a path

**MEASURED in both hosts.** The manifest's `ScriptPath` *is* evaluated,
but `$.fileName` inside it is not a path:

| Host | `$.fileName` returned | `new File(that).parent.fsName` |
|---|---|---|
| After Effects 26.3 | `"7"` | `C:\Program Files\Adobe\Adobe After Effects 2026\Support Files` |
| Premiere 26.3.2 | `""` (empty) | `C:\Program Files\Adobe\Adobe Premiere Pro 2026` |

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
