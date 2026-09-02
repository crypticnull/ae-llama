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
| CEP panels list and open in Premiere 26.x | SNIPPET (sources conflict) | P0 step 1 |
| …and in the 27.0 beta | UNVERIFIED | P0 step 3 |
| aescripts ZXP/UXP Installer accepts a two-extension bundle | UNVERIFIED | P0 step 1 |
| One aescripts licence can back two host listings | UNVERIFIED | P4 (ask aescripts) |
| Exact `appName` string Premiere reports (`PPRO` expected) | SNIPPET | P0 step 2 |
| CEP API version / which `CSXS.*` key Premiere 26 reads | SNIPPET (13/14 is a third-party installer claim; Adobe's table stops at "Premiere 25.0 = CEP 12") | P0 steps 1–2 |
| `localStorage` scoping across hosts for one extension id | UNVERIFIED | P0 step 2 (open AE's probe first, then Premiere's) |
| `AutoVisible` actually opens a panel in Premiere | SNIPPET (reported not to) | P0 step 1 |
| `$.engineName` per extension and per door | UNVERIFIED | P0 step 2 |
| ExtendScript engine degradation over a long session ("InternalError: Stack overrun", third party, 26.2.2) | SNIPPET | P0 step 2 (500-round-trip soak) |
| Undo grouping exists in Premiere ExtendScript | ADOBE-SRC says **no** (0 hits for undo/beginUndoGroup) | P0 step 2 (History panel after 3 scripted mutations) |
| BridgeTalk AE→Premiere delivery | UNVERIFIED (no in-the-wild example found) | P0 step 4, door 1 |
| `/C es.processFile` + `extendscriptprqe.txt` on 26.x | SNIPPET (confirmed only CC2019 / 2024) | P0 step 4, door 2 |
| Invisible `StartOn` extension fires in Premiere | ADOBE-SRC (sample) + SNIPPET; Adobe's own manifest comments the event as firing on **every OS focus gain** | P0 step 4, door 3 |
| `importMGT` still works on 26.x; text set blanks the value | SNIPPET | P0 step 5 |
| `exportAsMediaDirect` on 26.x | SNIPPET (a "not working on 2025" thread title, unread) | P1 |
| QE silently ignores razor/ripple **and vanilla effect-parameter writes** on some 26.3 installs | SNIPPET (third-party MCP project) | P1 |
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
