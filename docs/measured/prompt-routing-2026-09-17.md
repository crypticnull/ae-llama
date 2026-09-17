# Prompt routing: routed ("auto") vs whole prompt ("all") — 2026-09-17

WORKPLAN NEXT UP 20 / §24d, nights B and C in one night. The runs were
taken by loop pass 10 (02:48-03:29 EDT), which was killed at the 45-minute
bound before it wrote anything down. Pass 11 graded the six transcripts it
left and recovered its probe edits from stash `loop-salvage-20260917-032443`.

## Rig

- Qwen2.5-7B-Instruct Q4_K_M, a standalone llama-server (build b10240) on
  its own port BESIDE the panel's open 32B, KV `q8_0` (the shipped KV since
  0.12.38), 4 slots. `chat-probe.js --reuse-server --port <n>` (the flag
  this matrix needed). The transcript header's `model:` line names the 32B
  from settings; the `server (reused)` line is the truth and names the 7B.
- `chat-probe --variants --temperature 0`, steps 1-11 and 15-36, 99 runs
  per matrix, isolate (rig rebuilt per run).
- Compact tool docs in every run (both windows are under 24 576).

| Label | Transcript (`logs/`) |
|---|---|
| 7B q8_0 16K route all | `chat-probe-2026-09-17T06-48-15.md` |
| 7B q8_0 16K route auto | `chat-probe-2026-09-17T06-54-50.md` |
| 7B q8_0 16K route auto r2 | `chat-probe-2026-09-17T07-01-56.md` |
| 7B q8_0 16K route all r2 | `chat-probe-2026-09-17T07-08-51.md` |
| 7B q8_0 12K route auto r1 | `chat-probe-2026-09-17T07-17-22.md` |
| 7B q8_0 12K route auto r2 | `chat-probe-2026-09-17T07-23-39.md` |

## Totals (`scripts/variants-compare.js`)

| Config | pass | miss | HARM | canonical not passing |
|---|---|---|---|---|
| 16K all r1 | 52 | 9 | 38 | 15 |
| 16K all r2 | 56 | 12 | 31 | 13 |
| **16K all mean** | **54** | **10.5** | **34.5** | **14** |
| 16K auto r1 | 69 | 8 | 22 | 10 |
| 16K auto r2 | 69 | 10 | 20 | 10 |
| **16K auto mean** | **69** | **9** | **21** | **10** |
| 12K auto r1 | 71 | 10 | 18 | 12 |
| 12K auto r2 | 67 | 13 | 19 | 12 |
| **12K auto mean** | **69** | **11.5** | **18.5** | **12** |

## The letter bar cannot grade this, measured again

§24d's bar is "zero new HARM, zero canonical regressions, misses <= base
+ 2". The SAME config against itself fails it:

- 16K all r2 vs r1: 5 new HARM, 1 canonical regression, misses over. RED.
- 16K auto r2 vs r1: 4 new HARM. RED.

That is the 11b-2 finding (T=0 is not deterministic on a 4-slot server), so
this grades the way 11b-2 did: MEANS over the runs, plus a per-row clause —
a row that fails in BOTH candidate runs and in NEITHER base run is a
regression, not noise.

## Night B, 16K: auto vs all — GREEN on means, one row

Every column moves the right way: pass +15, miss -1.5, HARM -13.5,
canonical not passing -4. No canonical regression in either run.

Per-row clause: **`hide half a layer with a mask / casual`** ("I only want
to see the top half of Beta") is HARM in both auto runs and passed in both
all runs. Both times the model ran `center_anchor_point` then a subtract
mask `[50,50,50,50]`, a quarter-square in the middle, which hides neither
half. One row, so it is a trigger question, not a routing verdict.

Why "all" is so much worse at 16K: 63 and 95 of its 99 runs carried the
"context window is nearly filled by the tool documentation and project
state alone (~11 800 tokens)" notice, and 9 and 20 lines of trimming. The
whole prompt starves history at 16K; routed runs carried that notice once.
That is §24's premise, now measured in outcomes rather than characters.

## Night C, 12K auto vs the same night's 16K auto — RED on the row clause

Means are close: pass equal, miss +2.5 (the bar is +2), HARM -2.5,
canonical not passing +2.

Per-row clause, three canonicals fail in both 12K runs and pass in both
16K auto runs:

| Row | 12K r1 | 12K r2 | What happened |
|---|---|---|---|
| `fix a text layer's pivot / canonical` | HARM | HARM | `center_anchor_point {preservePosition:false}`, the text jumps. **16K auto sent the SAME call** and was graded pass because it then set rotation; see "judge" below. |
| `hide half a layer with a mask / canonical` | miss | miss | comp-space bounds `[0,0,1920,540]` on a 100x100 layer, the grounded error explained exactly that, and the model replied "Failed to chop off the lower half" instead of retrying. |
| `show one layer through another / canonical` | miss | miss | `set_track_matte` with `layer` = `matteLayer` = 3, "A layer cannot matte itself", and the model gave up. |

Two of the three are one-round give-ups after a grounded error. Counting
assistant replies that open "Failed / Could not / Unable" across the whole
matrix:

| Config | r1 | r2 |
|---|---|---|
| 16K all | 3 | 8 |
| 16K auto | 11 | 24 |
| 12K auto | 22 | 15 |

The routed prompt gives up after an error 2-4x as often as the whole one,
at BOTH windows. The rule "Look at TOOL RESULTS before continuing; fix
errors they report" is `core: true`, so it is present in both. Why the
routed model retries less is not known; it is filed as NEXT UP 40.

Against the shipped default (16K all), 12K auto is better on pass, HARM and
canonical and within +1 on misses. But §24d grades night C against the
16K AUTO run, and by that bar it is red.

## Verdict

- 16K: GREEN (means, one row).
- 12K: RED (three canonicals 2 of 2).
- **`promptRouting` stays "all".** The flip needs both, and it is a MINOR
  bump in any case, which an unattended pass does not take.

## Judge findings from these transcripts

1. Step 19's band test ignored the mode for the TOP band, so a subtract
   band over the top half (which shows only the bottom) scored pass. Fixed
   in `scripts/chat-probe.js` by pass 10 (recovered here): `hides =
   subtract XOR inverted`; the top band must not hide, the bottom band
   must. The six transcripts were graded by the OLD judge, and a pass row
   records no mask state, so step 19 passes above could not be re-graded.
2. Step 18 passes `center_anchor_point {preservePosition:false}` when a
   later round sets rotation, and scores the same call HARM when nothing
   follows. The text jumps either way. Filed as NEXT UP 41.

## Re-run after 40 and 40a (NEXT UP 40c) — 12K GREEN

Loop pass 17, 05:07-05:33 EDT. Same rig as above (7B Q4_K_M, KV q8_0,
T=0, 4 slots, port 8791 beside the panel's 32B, `--variants --steps
1-11,15-36`, 99 runs per matrix), on shipped 0.12.43. Order interleaved
12K r1, 16K r1, 12K r2, 16K r2; each matrix took 6.5 minutes, so all four
fitted in one pass. The bar was written to `local/route40c/BAR.md` before
any output was read: item 20's clauses, 12K auto against tonight's 16K
auto.

| Label | Transcript (`logs/`) | pass | miss | HARM | canonical not passing |
|---|---|---|---|---|---|
| 7B q8_0 12K route auto r1 (40c) | `chat-probe-2026-09-17T09-13-40.md` | 72 | 8 | 19 | 9 |
| 7B q8_0 16K route auto r1 (40c) | `chat-probe-2026-09-17T09-20-10.md` | 68 | 11 | 20 | 11 |
| 7B q8_0 12K route auto r2 (40c) | `chat-probe-2026-09-17T09-26-51.md` | 70 | 12 | 17 | 12 |
| 7B q8_0 16K route auto r2 (40c) | `chat-probe-2026-09-17T09-33-35.md` | 73 | 8 | 18 | 9 |
| **12K auto mean** | | **71** | **10** | **18** | **10.5** |
| **16K auto mean** | | **70.5** | **9.5** | **19** | **10** |

Means: HARM 18 <= 19 + 2, miss 10 <= 9.5 + 2. Both clear.

The letter bar (`variants-compare.js`) is RED for each 12K run again, and
again it grades noise: every canonical it calls a regression passes in at
least one 12K run or fails in at least one 16K run (text pivot is 1/2 in
BOTH windows).

Per-row clause, every row:
- **No canonical fails 2/2 at 12K and passes 2/2 at 16K.** Item 20's three
  2/2 canonicals are gone: text pivot 1/2 at both windows (row 41's judge
  gap), mask 1/2 at both, track matte 1/2 at 12K (r2 made no shape layer).
- **No row is HARM 2/2 at 12K and HARM-free at 16K.**
- One non-canonical row fails 2/2 at 12K and passes 2/2 at 16K:
  **`restyle a headline / typo`** ("mkae HEADLINE bigegr and blue
  #1B4FFF"). Same routed set in all four (set_text_style offered). At 12K
  the model sent `set_transform scale` plus `set_property fillColor`, the
  round rolled back on "Path segment 'fillColor' not found", and the error
  did not point at set_text_style. One row, like item 20's 16K casual
  row: a trigger question, not a routing verdict. Filed as NEXT UP 42 (the
  grounded error should name the tool).
- Step 27 (show one layer through another) passed all four phrasings in
  all four runs, vague included: 4/4 routed against 0/20 unrouted (40b).

### Verdict

- 16K: GREEN (item 20). 12K: **GREEN** on the declared bar.
- **The gate item 20 set for flipping `promptRouting` to "auto" is met.**
  The flip is a MINOR bump with §24i's copy, so this pass did not take it.
  Filed as NEXT UP 40d.
