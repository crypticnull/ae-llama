# Handoff to the local session — 2026-09-09

Written by the remote (cloud) session that has been building this repo
from a container with no access to the owner's machine. That session is
being retired in favour of a LOCAL Claude Code session with direct access
to After Effects, llama.cpp and ComfyUI. This file is the state transfer.

**Read order for a fresh session:** `CLAUDE.md` (the standing brief and
the hard-won AE/ExtendScript facts — do not relearn those), then
`docs/MEMORY.md` (the generated index into the 260k-token
`WORKPLAN-LOG.md`), then this file, then the section of
`docs/WORKPLAN.md` you are actually working in.

**Do not read `docs/WORKPLAN-LOG.md` whole.** It is ~1 MB / ~262k
tokens. `MEMORY.md` carries a corrections table and line ranges; retrieve
with `sed -n 'START,ENDp' docs/WORKPLAN-LOG.md`.

---

## 1. What the product is

**AE Llama** — a commercial After Effects CEP panel (Windows 11, AE 2024+,
field-tested on AE 2026; destined for aescripts.com). It drives After
Effects through a LOCAL llama.cpp model using JSON tool-calling, with a
hidden ComfyUI backend for image and video generation. The user types
plain English; the model calls tools; the panel executes them in AE.

- `extension/jsx/hostscript.jsx` — ALL AE-side tools (`AELL_TOOLS`), ES3
- `extension/js/tools.js` — tool docs, system prompt, panel-side tools
- `extension/js/{main,llama,comfy,setup,settings,visualizer,selftest}.js`
- `tests/` — 79 stubbed-AE regression suites; CI runs exactly these
- `docs/CAPABILITIES.md` — the whole product in one place; the tool table
  is GENERATED (`node scripts/capability-report.js`) and CI-enforced fresh

**Current version: 0.12.3.** Branch: `claude/ae-plugin-llama-cpp-f13g3x`.
Suite is 78/79 green — the one failure, `test-ffmpeg-export.js`, is
genuinely Windows-absolute-path-bound and passes on the owner's machine.
It failed in the container only. **Verify that locally and, if it passes,
say so in the log** — it has been carried as a "known container failure"
for weeks and nobody has confirmed it from Windows.

### Shipping — BUMP OR IT DOES NOT SHIP

CI runs on every push to `main` AND `claude/**`, and the feed-publish step
has no branch condition, so **a push to the dev branch already ships**.
Merging to `main` is bookkeeping. The one real gate is the version: the
panel updates only when `compareVersions(feed.panelVersion, VERSION) > 0`,
so an unbumped push reaches the repo and never reaches a panel.

    node scripts/bump-version.js patch    # one command, all four files

Bump exactly when `extension/` changed; skip exactly when it did not (a
bump with no panel change makes every test user pay a reinstall for
nothing). Never push tags — branch-scoped credentials reject them. Model
identity strings must never appear in committed artifacts.

---

## 2. The arrangement is changing — you are now both agents

`CLAUDE.md` describes two agents: a remote session that builds features
and owns merges, and a local session that runs the real-AE suite. **That
split was a workaround for the remote session's blindness, and it is
collapsing into you.** You have what the remote session never had: a
shell on the machine, real AE, the real backend.

Practical consequences:

- **You own patch bumps AND minor/major**, and merges to `main`. The
  remote session is no longer there to batch them.
- **The loop is still worth keeping**, but for a different reason than
  before. It was partly a workaround for remote blindness; what remains
  is genuinely valuable — unattended passes while the owner sleeps. That
  is about *time*, not access.
- **Interactive debugging should no longer go through the loop.** If you
  want to know whether something works, run it.

---

## 3. LIVE WORK — the loop is mid-repair. Start here.

This is the only actively-broken thing in the repo, it is `NEXT UP` item
0, and it is filed as **§20** in `docs/WORKPLAN.md`.

### What happened

`scripts/run-local-agent.ps1` runs unattended overnight passes: pull → one
headless `claude -p` pass → commit → repeat. It worked on 2026-09-06
(that night produced §18 P0–P2 and P4). Then **three nights produced
nothing**:

1. **2026-09-07** — lost to a communication failure, not a bug. The
   remote session buried the loop command under other work and the owner
   ran the wrong thing before bed.
2. **2026-09-08** — every pass came back READ-ONLY. `Read`, `Grep` and
   `Glob` worked; every `Edit`, `Write`, `Bash` and `git` call was
   auto-denied. Passes could not run the harness, run a test, append to
   the log, or commit. The loop logged "produced no commit" and started
   the next one.
3. **2026-09-09** — nothing ran; the session was spent diagnosing.

### What is ESTABLISHED (measured, not inferred)

The passes were running without `--dangerously-skip-permissions` in
effect. After changing the invocation so the prompt goes in on **stdin**
(`claude -p` with no value reads it there) and the **flags come first**, a
pass launched `AfterFX.exe` 18 seconds after starting — measured, PID
51048 at 10:20:39 against a pass that began at 10:20:21. **The denied
passes could never do that.** The bypass reaches the CLI now.

Which of the two changes fixed it is unpinned; they landed together and
it was not worth an experiment on the owner's nights. **You can settle it
in one minute locally** — that is exactly the kind of thing this move
exists for.

### Candidates RULED OUT (do not re-investigate)

| candidate | how it died |
|---|---|
| the flag missing from the script | present at `66e9b9f:49` and `:314` |
| an elevated / admin shell | measured `False` |
| a `permissions` block in user settings | none — only `outputStyle`, `autoUpdatesChannel`, `theme`, `agentPushNotifEnabled` |
| managed policy | `C:\ProgramData\ClaudeCode\managed-settings.json` does not exist |
| the CLI gating the flag | a manual headless call from the repo root wrote a file AND ran node |
| the WMI detach | the 01:25 run was WMI-detached, the 01:44 run was in-window; both failed identically |
| PS 5.1 quoting alone | the prompt already carried **8** double quotes at `e7aecab`, the version that ran the WORKING 09-06 nights (12 after the §19 edit) |

### What is NOT established

**That a pass finishes and commits.** No pass has committed since the
repair. Three single-pass runs were started and all three were killed
before reaching a verdict. **Do this first (§20c).** Until you have seen
one pass print `Pass committed <sha>` or `Pass produced no commit`, the
loop is not known to work end to end and no overnight run should start.

### The diagnostic trap — please do not fall in it again

The remote session twice read a pass's health off **CPU**, and was wrong
both times in opposite directions:

- **`claude -p` is API-bound and burns almost no CPU while working.**
  8.66 CPU-seconds over ten minutes is a NORMAL working pass, not a hang.
- **The harness deliberately leaves AE open and idle between steps**, so a
  flat `AfterFX` CPU counter is the designed state, not a stall.

CPU cannot distinguish working from hung here. That is why §20a asks for
a **heartbeat built on evidence of progress** — the pass process still
existing, elapsed time, and the repo's dirty-file count
(`git status --porcelain | Measure-Object -Line`), which rises once a
pass starts editing. Explicitly **not** CPU.

### The deeper defect

`claude -p` returns its output in ONE block at the end, so a working pass
writes no log line for its entire 6–10 minute run. Neither the owner nor
the loop can tell "working" from "hung". §20a (heartbeat) and §20b (a
per-pass timeout — there is none today beyond `run-ae-selftest.ps1`'s own
`-TimeoutSec 240`) close that.

### Guards already added this week (they work, keep them)

- **A preflight write-probe before pass 1** — one small CLI call with the
  same flags a pass gets, which must leave a file on disk. Exits 3 with
  the flags used and what to check. Note the lesson attached to it: the
  FIRST version used a quote-free prompt passed on the command line, so
  it sailed through while every real pass failed. **A preflight that
  exercises an easier path than the thing it clears is worse than none —
  it converts "broken" into "verified working".** It now carries double
  quotes and goes in the same way a pass does.
- **A mid-run denial guard** — a no-commit pass whose output carries
  "requires approval" / "denied automatically" breaks the loop.
- **`-PreflightOnly`** — runs the probe and stops, taking the same path a
  real run takes (detach included).
- **The flags are logged** (`flags  : ...`). The first question anyone
  asks — did the bypass flag reach the CLI? — was unanswerable from the
  log for two days.
- **`--settings <file>` pinning `{"outputStyle":"default"}`**. The owner's
  global settings carry `"outputStyle": "Learning"`, which asks the
  session to hand design decisions back as `TODO(human)` blocks — fine
  for a human at a keyboard, exactly wrong for a pass whose brief says
  nobody is watching. Passed as a FILE, not inline JSON: PS 5.1 mangles
  embedded double quotes when building a native command line. **The
  owner's global setting was deliberately NOT modified** — a loop that
  edits a user's own configuration to suit itself is a worse bug than the
  one it fixes.

---

## 4. The ComfyUI arc — §17 → §18 → §19

This is the main product work in flight, and it rests on one finding.

### The finding that started it (§17a)

`comfyUrl` defaulted to `http://127.0.0.1:8188` — **ComfyUI's own default
port**. So every buyer who already had ComfyUI installed silently became
"bring your own backend", and every buyer who did not got nothing. Nobody
had ever verified the shipped path, because the owner's machine has its
own ComfyUI on port 8000 and that is what got tested.

**The redesign, at the owner's direction:** portable/managed is the
DEFAULT; the user's own install is an explicit bypass. Settings gained
`comfyBackend: "managed"` and `comfyManagedPort: 8288`.
`Comfy.backendMode(s)` / `managedPort(s)` / `backendUrl(s)` are the single
place the backend choice is decided. Migration reads `saved`, not the
merged value, against `LEGACY_COMFY_URL`.

**§17c — dogfood the shipped backend on the dev machine.** Owner-approved
2026-09-06. This is `NEXT UP` item 1 and it gates most of §18:
`node scripts/comfy-install.js --boot` (~2 GB download, ~10 GB free).
`scripts/comfy-install.js` and `scripts/download-gen-weight.js` exist
precisely so an unattended pass can do this — before them,
`Setup.bootstrapComfy` and `Setup.downloadGenWeight` each had exactly ONE
caller, a button in Settings, so every §18 pass contained a human click.

**§17e, still open:** `pickComfyAsset` hands every non-NVIDIA machine the
AMD build, because ComfyUI ships no CPU asset and the test fixture
invented one. Found by reading the owner's own `curl` of the real release.

### §18 — a basic working graph for EVERY catalog model

Full plan: `docs/proposals/comfy-templates-PLAN.md`. Owner decisions were
answered 2026-09-06 and two of them change the plan's shape:

| Q | answer |
|---|---|
| Q5 backend route | **Build the portable first.** The owner's own ComfyUI is REFUSED for unattended work. §17a → §17c gate everything. |
| Q1 ltx-small | **Postpone** — not pinned, not dropped. Stays in `ALLOW_NO_TEMPLATE` indefinitely. |
| Q2 minimax-h3-int8 | **Yes** — download the 26 GB encoder and prove it. |
| Q3 refinement round-trip | **Yes** — a refined graph is a NEW file, never an edit of a shipped one. |
| Q4 KREA2 `enhancerInstruction` | **Strip** the machine-specific lines. |
| Q6 core-only siblings | **Build basics for every entry** — see the reframe. |

**The reframe, in the owner's words:** *"build basic ones and redefine my
supplied one as alternate custom additions just for me for now. I want to
fully build the user's environment and think of mine as another level on
top of that that's separate."*

So the product's baseline is the **core-only basic set**, and the owner's
authored graphs (`AE_LLAMA_KREA2_V1`, `AE_LLAMA_H3_I2V_V1`) become a
personal layer. Four measured consequences:

1. **Per-entry, never wholesale.** An authored graph leaves the bundle
   only once that entry's basic is shipped AND rendered.
2. **The owner keeps his.** `ensureDataDirs` (`setup.js:84-116`) seeds,
   refreshes and preserves — it has **no delete path** (verified), so a
   file already in `%APPDATA%\AE-Llama\comfy-workflows` survives removal
   from the bundle.
3. **`package-zxp.ps1:72-77`** excludes only `.debug`, `vendor`,
   `models`, `generated` — so ~200 KB of the owner's authored graphs
   ships inside every buyer's ZXP today and is never read. Add
   `workflows` to `$excludeDirs` (pass P11).
4. **The resolver needs a deliberate baseline tiebreak** — prefer the
   template the catalog entry's `workflowTemplate` points at, before
   falling through to name order.

**Done so far:** P0 (two-way allowlists `ALLOW_NO_TEMPLATE` /
`ALLOW_UNMEASURED` — "existence is not proof" — plus a bundle ratchet and
a manifests walk), P1 (`Comfy.resolveWorkflow` — the alphabet no longer
chooses which template runs; grounded refusals when the pool empties),
P2 (probe flags, the headless downloader, `scripts/lib/comfy-managed.js`),
P4 (Settings → ComfyUI → Workflows rows that say what a template NEEDS:
VRAM floor, architecture gate, needs-an-image, count of missing weights —
all from data one hop away through the manifest's `catalogEntry` link).

**§18 has no remote passes left.** P3 and P5–P10 are local and need only
§17c.

### §19 — "I already have models"

The owner asked for a wizard letting a user with an existing ComfyUI say
where their models are. **Checking first found the plumbing is already
complete** and already inherits their configuration.
`comfyModelRoots(s)` (`tools.js:1274`) searches, most specific first:

1. `comfyModelsDir`
2. each **Extra model folders** line, with per-type `kind=path`
3. the **Comfy-Desktop shared store**, auto-detected, no config needed
4. `<comfyDir>\models`
5. every root parsed out of the user's OWN `extra_model_paths.yaml` and
   the Desktop's `extra_models_config.yaml` (`tools.js:1200-1221`,
   `parseComfyPathsYaml`)

So §19 is UX over existing search logic: **19a** `Setup.scanForModelRoots()`
probing a NAMED SHORTLIST (**never scan drives** — slow, alarming in a
commercial product, and it would claim other applications' models),
**19b** a Scan button plus per-line validation of typed roots, **19c** a
first-run prompt which is commercial copy and stays **OWNER-GATED**.

One defect worth remembering: §17a relabelled the install-folder field
"only used with 'Use my own ComfyUI'" — **wrong**. `comfyDir` is read at
`tools.js:1205` and `:1311` with no backend-mode gate at all, and it is
the single field that unlocks inheriting a user's config. A label written
while thinking about one subsystem described a field owned by another.
Nothing tested it, because a label is not behaviour — but it is the only
instruction most users will ever read.

---

## 5. The queue

`docs/WORKPLAN.md` has a **NEXT UP** block at the top (before §1). It
exists because the brief tells a pass NOT to read the whole 46k-token
file, and all live work is in §17–20 — the last four of twenty sections,
behind sixteen sections of struck-through work. Without it a fresh pass
reads finished work and never learns §17c exists.

| # | item | where | needs |
|---|---|---|---|
| 0 | Loop heartbeat, then verify one pass commits | §20 | nothing |
| 1 | `node scripts/comfy-install.js --boot` | §17c | ~10 GB free, 2 GB download |
| 2 | H3 t2v regression + VRAM probe | §18 P3 | item 1, AE |
| 3–8 | sd15, sdxl, wan22-5b, krea2, H3, H3-int8 basics | §18 P5–P10 | item 1, disk |

Plus a fallback table of items needing nothing but the repo (§19a/b, four
§15 prompt deletions, §16f 1–4), so a night with no disk, no network or
no AE still produces work.

**Gate 0 for anything touching settings or downloads:** print
`Settings.origin()` and refuse when `appdata` is empty. A pass that finds
it missing is reading someone else's defaults.

---

## 6. How the owner wants to be worked with

These are explicit, repeated, and were violated enough times this week to
cost real nights. They are not style preferences.

1. **Commands go at the BOTTOM of the message**, after the explanation.
   Not the top, not buried in the middle.
2. **Every command block starts with**
   `cd X:\_CLAUDE\26_08_19_AE_Llama\cptk_claude`. A diagnostic issued
   without it ran in `C:\WINDOWS\system32`, hit an ACL wall, and cost a
   round trip.
3. **Be explicit about WHERE a command goes** — plain PowerShell vs the
   Claude CLI vs a second window.
4. **Steps in order, concisely.** Do not bury commands inside
   paragraphs. One command per message when a command is the point.
5. **Function over conversation.** Also a design principle here, not just
   a tone note — see CLAUDE.md on the context budget.
6. **The ComfyUI port is 8000.** Never instruct changing it.
7. When work is finished, say what shipped and where. "Merged" is not
   "shipped" — see the version gate.

---

## 7. Mistakes this week, so they are not repeated

- **A finding that implies WORK goes in `docs/WORKPLAN.md`, not only the
  log.** The loop takes work from the queue; a finding written only to
  the log is one nothing will ever act on.
- **Do not diagnose from an instrument that cannot answer.** CPU, twice,
  in opposite directions.
- **Do not let your own just-finished work set the headline.** The 09-07
  night was lost because the reply led with what had just been built
  instead of the owner's next action.
- **A test that exercises an easier path than the real thing is worse
  than no test.** The first preflight.
- **Confidence must match evidence.** The stdin fix was pushed with a
  cause claim ("PS 5.1 quoting ate the flag") that the 8-quotes-worked
  data point contradicts. The fix is good; the stated reason was not
  established.
- **Check the whole conversation's standing constraints before writing a
  command block.** Two of the rules in §6 were broken after being
  acknowledged in the same session.

---

## 8. First actions for the local session

1. Read `CLAUDE.md` and `docs/MEMORY.md`.
2. **§20c** — run `-Iterations 1` and let it finish untouched. Confirm a
   pass reaches a verdict. This is the gate on everything else.
3. **§20a/20b** — heartbeat and per-pass timeout.
4. Settle which of the two invocation changes fixed the bypass (one
   minute locally; two days remotely).
5. Confirm `test-ffmpeg-export.js` passes on Windows and log it.
6. Then **§17c** — install the managed backend, which unblocks §18.

Everything below §20 in the queue is unchanged and still correct.
