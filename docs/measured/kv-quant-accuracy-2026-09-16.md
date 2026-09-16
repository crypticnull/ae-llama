# KV-cache quantization, accuracy half (NEXT UP 11b) - 2026-09-16

Qwen2.5-7B-Instruct Q4_K_M, llama-server build 10240, RTX 5090, ctx 16384,
temperature 0.7 (the panel's), routing all, COMPACT docs. Server started by
`scripts/kv-quant-probe.js --serve --models 7B --ctx 16384 --kv <type>`,
matrix by `scripts/chat-probe.js --variants --reuse-server` (steps 1-11,
15-36). Graded with `scripts/variants-compare.js`, the three generation rows
that only run 1 took skipped on both sides.

The runs were made by loop pass 24, which was killed at its 45-minute bound
before it wrote anything down. Which KV config each transcript measured
was recovered from that pass's runner output (`[time] <kv>-<ctx>-r<n> exit=0
transcript: <file>`), not from the transcripts, which did not record it.
Shipped r1 is INFERRED from run order (the runner's line for it was not
found); the other three are recorded.

| run | transcript | runs | pass | miss | HARM | canonical not passing |
|---|---|---|---|---|---|---|
| shipped r1 (inferred) | chat-probe-2026-09-16T16-25-01.md | 99 | 56 | 13 | 30 | 13 |
| shipped r2 | chat-probe-2026-09-16T16-53-16.md | 99 | 51 | 23 | 25 | 15 |
| q8_0 r1 | chat-probe-2026-09-16T16-46-33.md | 99 | 54 | 20 | 25 | 13 |
| q8_0 r2 | chat-probe-2026-09-16T17-00-03.md | 99 | 54 | 20 | 25 | 17 |
| q4_0 r1 | none - void, see below | | | | | |

## Reading

- **The §24d bar cannot certify a config at this temperature.** Shipped
  r2 held against shipped r1 is RED: 12 new HARM, 3 canonical regressions,
  misses 23 vs a bar of 15. The same config fails its own gate.
- **q8_0 held against both shipped runs is RED too**, with 2 and 3 new HARM
  and 2 and 5 canonical regressions. That is inside the noise the line
  above measures, so it is not evidence that q8_0 hurts.
- **Totals:** q8_0 passed 54 and 54 against shipped's 56 and 51, with
  HARM 25 and 25 against 30 and 25. Nothing here says q8_0 at 16K is worse
  than shipped. Nothing here proves it is equal either, at n=2 and T=0.7.
- q4_0 r1 is void. Its matrix shared one server with this pass's
  one-step header checks, two clients on one 16 384-cell unified KV, and
  llama-server answered both with "Context size has been exceeded". Its
  chat-probe was killed before it wrote a transcript. 32K rows never ran.

## What would answer it

Either temperature 0 (`chat-probe --temperature 0`, added this pass), so
one run per config compares decoding and not sampling, or a rate bar over
N runs per config instead of per-row set differences. Filed as 11b-2.

## 11b-2, shipped 16K at temperature 0 (loop pass, 14:00-14:40 EDT)

Same server command (`--kv shipped`), nothing else on 8737, steps as above,
`--temperature 0 --variants`, one label per run.

| run | transcript | pass | miss | HARM | canonical not passing |
|---|---|---|---|---|---|
| T0 r1 (dirty project) | chat-probe-2026-09-16T18-06-40.md | 55 | 16 | 28 | 14 |
| T0 r2 (dirty project) | chat-probe-2026-09-16T18-13-34.md | 60 | 12 | 27 | 14 |
| T0 clean-a | chat-probe-2026-09-16T18-32-45.md | 56 | 17 | 26 | 12 |
| T0 clean-b | chat-probe-2026-09-16T18-39-16.md | 53 | 18 | 28 | 14 |

- **T=0 is not deterministic run to run.** r1 vs r2: RED (5 new HARM, 1
  canonical regression). clean-a vs clean-b: RED (6 new HARM, 3 canonical
  regressions), with the tool sequence itself differing on rows the AE
  state cannot explain. A two-step sanity pair (steps 1-2) WAS identical.
- **Part of the drift was the probe's own leak, now fixed:** the sweep
  kept neither the comps the model makes with `create_comp` nor the rigs'
  BG / Icon N / Beta solids or add_null's Null N sources. 2 055 unused
  items sat in the open project and READ_COMP's project listing put the
  growing count into every prompt. r2's "Squares 3" HARM was a leftover
  "Squares" comp from r1. Fixing it did not make runs agree (clean pair
  above), so the rest is the server: 4 slots on one unified KV with
  prompt caching, whose logits are not batch-invariant.
- **So 11b-2 uses the rate bar.** Shipped T=0 spread over 4 runs: pass
  53-60, miss 12-18, HARM 26-28, canonical not passing 12-14. A candidate
  is green if its pass/HARM/canonical totals fall inside that (n=2 per
  candidate, clean project).

## 11b-2, q8_0 16K at temperature 0 (loop pass, 14:41-14:55 EDT)

Server `node scripts/kv-quant-probe.js --serve --models 7B --ctx 16384 --kv q8_0`
(`-ctk q8_0 -ctv q8_0`), nothing else on 8737, `chat-probe --rig-check`
first, then the same steps as the shipped runs. Graded against all four
shipped T=0 transcripts above.

| run | transcript | pass | miss | HARM | canonical not passing |
|---|---|---|---|---|---|
| q8_0 T0 r1 | chat-probe-2026-09-16T18-48-20.md | 57 | **20** | **22** | 13 |
| q8_0 T0 r2 | chat-probe-2026-09-16T18-55-05.md | 54 | 14 | **31** | **11** |
| shipped T0 bar (4 runs) | | 53-60 | 12-18 | 26-28 | 12-14 |

- **Not green by the bar as written** ("both runs inside the spread"): r1
  misses 20 (> 18) and r2 has HARM 31 (> 28). But the excursions go BOTH
  ways: HARM 22 is better than any shipped run, canonical 11 is better
  than any shipped run. Candidate means (pass 55.5, miss 17, HARM 26.5,
  canonical 12) sit inside shipped's range on every column.
- **Reading:** the 4-run shipped range is narrower than the run-to-run
  noise it is meant to bound (the q8_0 pair alone spans HARM 22-31), so a
  2-run candidate can land outside it by chance in either direction. This
  is inconclusive, not evidence that q8_0 hurts.
- **Two rows moved against q8_0 in BOTH runs**, which is the one signal
  worth keeping: `parenting / canonical` regressed, and
  `hide half a layer with a mask / typo` became HARM. Check these in r3/r4.
- **Bar for r3/r4, declared BEFORE those runs exist** so it cannot be
  fitted to them: with q8_0 16K at n=4, green if the 4-run MEANS satisfy
  pass >= 53, miss <= 18, HARM <= 28, canonical not passing <= 14, AND
  neither of the two rows above fails in 3 or more of the 4 runs.

## 11b-2, q8_0 16K r3+r4, and a judge bug that moved r1/r2 (loop pass, 15:00-15:30 EDT)

Same server and recipe as r1/r2 (`--rig-check` before each run). The
`--steps` flag takes a comma list only; `1-11,15-36` silently ran steps 1
and 15, so that run was thrown away and the literal list used.

**The step-19 judge ("hide half a layer with a mask") was wrong, fixed in
`scripts/chat-probe.js`.** It scored the mask's bounding box UNCLIPPED. The
model's usual final answer, `bounds [0,50,100,100]` subtract on the 100x100
Beta, spans y 50-150; AE ignores the overhang (the tool's own note says so),
so it hides exactly the bottom half, but its unclipped area read as "covers
the whole layer" -> HARM. Comp-wide bands (`[0,50,1920,100]`) failed the
same way. The judge now clips to the layer, and also fails a turn that
rescales or moves Beta on top of masking it (r3's typo run set scale 0.5
percent). `tests/test-chat-probe.js` covers both; the new cases fail on
the old judge.

Re-graded by hand from each transcript's recorded mask state. Only step-19
rows with a recorded mask can flip; a PASS row carries no state line, so a
collateral transform on a passing row is not visible after the fact.

| run | transcript | pass | miss | HARM | canonical not passing | step 19 change |
|---|---|---|---|---|---|---|
| shipped T0 r1 | 18-06-40 | 55 | 16 | 28 | 14 | none |
| shipped T0 r2 | 18-13-34 | 60 | 12 | 27 | 14 | none |
| shipped clean-a | 18-32-45 | **57** | 17 | **25** | 12 | vague HARM->pass |
| shipped clean-b | 18-39-16 | 53 | 18 | 28 | 14 | none |
| q8_0 T0 r1 | 18-48-20 | **59** | 20 | **20** | 13 | vague, typo HARM->pass |
| q8_0 T0 r2 | 18-55-05 | **55** | 14 | **30** | 11 | typo HARM->pass (vague `[0,50,100,0]` stays HARM) |
| q8_0 T0 r3 | 19-05-55 | 58 | 12 | 29 | 12 | none (vague `[0,0,100,100]` HARM; typo HARM, now for the rescale) |
| q8_0 T0 r4 | 19-12-46 | **55** | 18 | **26** | 14 | vague, typo HARM->pass |

- Shipped bar, re-graded: pass 53-60, miss 12-18, HARM **25-28**,
  canonical not passing 12-14.
- **q8_0 16K 4-run means: pass 56.75, miss 16, HARM 26.25, canonical 12.5.**
  Inside the declared means bar on every column (>=53, <=18, <=28, <=14).
  Unregraded they were 55.5 / 16 / 27.5 / 12.5, also inside.
- `hide half a layer with a mask / typo`: HARM in 4 of 4 under the old
  judge, **1 of 4** re-graded (r3, the rescale). Clause met.
- `parenting / canonical`: fails in 3 of 4 q8_0 runs (miss, HARM, pass,
  HARM). **Shipped fails the same row in 3 of 4** (HARM, HARM, miss,
  pass). The clause as declared is failed, but its premise ("regressed in
  both runs" against shipped) was false: those shipped transcripts existed
  before r3/r4 and show the same rate.

**Verdict: q8_0 16K GREEN**, with the parenting clause read as its intent
("no worse than shipped"), not its letter. That reading is a judgement made
after seeing r3/r4. It rests on shipped data that predates them, not on
r3/r4's values, and it is written here so it can be overturned.

**Bar for q8_0 32K, declared before any 32K run:** 4 runs at
`--ctx 32768` (server AND probe), graded with the fixed judge against the
re-graded shipped 16K range. Green if the 4-run means give pass >= 53, miss
<= 18, HARM <= 28, canonical not passing <= 14, AND no row fails in more
of the 4 runs than it fails in the 4 shipped runs plus 1.

## 11b-2, q8_0 32K r1+r2: RED by the declared bar, but the bar mixed two prompts (loop pass, 15:20-15:45 EDT)

Server `kv-quant-probe.js --serve --models 7B --ctx 32768 --kv q8_0` (n_ctx
32768, 4 slots, build b10240), probe `--ctx 32768 --temperature 0
--variants --steps 1-11,15-36`, `--rig-check` before each run, nothing
else on 8737, server stopped by PID after. Counted from each transcript's
`## N. scenario — verdict` headings (the same count reproduces r4's
53/18/28/14).

| run | transcript | pass | miss | HARM | canonical not passing |
|---|---|---|---|---|---|
| q8_0 32K T0 r1 | 19-27-51 | 55 | 14 | 30 | 12 |
| q8_0 32K T0 r2 | 19-35-30 | 56 | 15 | 28 | 10 |

- 2-run means: pass 55.5, miss 14.5, **HARM 29** (bar <= 28), canonical 11.
- **Per-row clause already failed, so r3/r4 cannot make it green.** Three
  rows fail in 2 of 2 here and in 0 of 4 shipped runs (allowed: 1):
  `take a mask off again / typo` (miss, miss: mask mode/feather changed,
  mask left), `un-animate the squares / canonical` (HARM, miss: keyed
  opacity 100 instead of removing keys), `an effect on everything except
  one layer / casual` (HARM, miss: built a null + slider rig, no drop
  shadow). Transcripts read; the judges are right on all six. None of the
  three failed in any q8_0 16K run except un-animate once (r2).
- **But this does not say q8_0 hurts at 32K.** The transcript headers
  differ: every 16K run says `tool docs: COMPACT (Tools.promptModeFor)`,
  both 32K runs say `tool docs: FULL`. The panel does the same switch, so
  the 32K runs graded a different system prompt as well as a different
  KV type and window, against a baseline that had neither. The bar
  declared above compared across prompt modes and could not isolate the
  KV type. That is my miss in declaring it.
- **What the 32K runs do say:** at 32K with q8_0 KV, the model this panel
  ships behaves no better than at 16K and has three new failure rows. A
  shipped (f16) 32K pair on the same FULL prompt is the only thing that
  separates "q8_0 at 32K" from "FULL docs at 32K"; if f16 32K fails the
  same rows, the regression is `promptModeFor`'s FULL mode, which is the
  mode a user gets by raising Context size.
- r3/r4 not run: no result could turn this bar green.

## 11b-2, q4_0 16K r1: RED and final, the K cache at q4_0 breaks the model outright (loop pass, 15:43-16:05 EDT)

Server `kv-quant-probe.js --serve --models 7B --ctx 16384 --kv q4_0`
(`-ctk q4_0 -ctv q4_0`, n_ctx 16384, 4 slots, build b10240), `--rig-check`
first (rigs OK), probe `--reuse-server --temperature 0 --variants --steps
1-11,15-36 --label "q4_0 16K T0 r1"`, nothing else on 8737, server stopped
by PID after.

| run | transcript | pass | miss | HARM | canonical not passing |
|---|---|---|---|---|---|
| q4_0 16K T0 r1 | 19-55-52 | 0 | 99 | 0 | 33 |

Every turn is `Model returned unparseable output: { "reply" :"<< 3 1 1 1
5 ...`: numbers and spaces until the token cap, so no tool ever ran. r2
was not run, because no second run can move a 0-pass row.

**The step-1 fixture is not the cause, and neither is the probe.** A plain
chat request with no tools and no grammar ("What is the capital of
France?", T=0, 40 tokens) answered `The capital capital of pérdida`.
Then the same prompt on a throwaway server (port 8791, same model and
flags, only the cache types changed):

| `-ctk` | `-ctv` | extra | answer |
|---|---|---|---|
| f16 | f16 | | The capital of France is Paris. |
| q4_0 | f16 | | The capital capital of France is Paris Paris Paris Paris Paris Paris. |
| q8_0 | q4_0 | | The capital of France is Paris. |
| q4_0 | q4_0 | `-fa on` | The capital capital of France is Paris Paris Paris Paris Paris Paris. |
| q4_0 | q4_0 | `-np 1` | The capital capital of France is Paris Paris Paris Paris Paris Paris. |

- **The KEY cache at q4_0 is what breaks it.** With V alone at q4_0 (K at
  q8_0) this one prompt stays correct. Forcing flash attention on, or using
  one slot, does not help.
- This fails SILENTLY. The server loads, reports healthy and answers every
  request. 11c's detect-and-fallback only catches a server that REJECTS
  the flag, so it would never catch this. q4_0 on K must never be a value
  the panel can pass.
- A `q8_0` K + `q4_0` V mix is the one smaller cache left that this
  measurement does not rule out. It is one sentence, not a matrix; filed
  as NEXT UP 11d, lower priority.

## 11b-2, shipped (f16) 32K r1+r2: separating KV type from prompt mode (loop pass, 16:00- EDT)

**Question, declared before either run (16:05 EDT):** do the three rows
q8_0 32K failed 2 of 2 (`take a mask off again / typo`, `un-animate the
squares / canonical`, `an effect on everything except one layer / casual`)
also fail on f16 KV at 32K, i.e. on the same FULL prompt?

- Each of the three fails in **at least 1 of 2** f16 32K runs, and f16 32K
  means are within noise of q8_0 32K (HARM within 3, pass within 4, the
  width of shipped 16K's 4-run range): the 32K regression belongs to FULL
  mode / the 32K window, not to q8_0. q8_0 32K is then NOT RED on KV
  grounds, and a §24 row is filed for FULL mode.
- All three pass in **2 of 2** f16 32K runs AND f16 32K HARM mean <= 27:
  q8_0 is implicated at 32K; 11c still ships q8_0 at 16K only, and any
  future raise of the default must not carry q8_0 without its own gate.
- Anything between: inconclusive at n=2, r3/r4 next pass.

**Ran 16:00-16:13 EDT.** Server `kv-quant-probe.js --serve --models 7B
--ctx 32768 --kv shipped` (no `-ctk/-ctv`, n_ctx 32768, 4 slots, build
b10240), `--rig-check` before each run, probe `--reuse-server --ctx 32768
--temperature 0 --variants --steps 1-11,15-36`, nothing else on 8737,
server stopped by PID after. Both transcripts say `tool docs: FULL`.

| run | transcript | pass | miss | HARM | canonical not passing |
|---|---|---|---|---|---|
| shipped 32K T0 r1 | 20-06-36 | 53 | 14 | 32 | 13 |
| shipped 32K T0 r2 | 20-13-36 | 56 | 14 | 29 | 13 |
| (q8_0 32K r1/r2, above) | | 55 / 56 | 14 / 15 | 30 / 28 | 12 / 10 |

- 2-run means f16 32K: pass 54.5, miss 14, **HARM 30.5**, canonical 13.
  q8_0 32K: 55.5 / 14.5 / 29 / 11. HARM within 1.5, pass within 1.
- The three rows on f16 32K: `take a mask off again / typo` HARM, HARM
  (2 of 2); `un-animate the squares / canonical` pass, HARM (1 of 2);
  `an effect on everything except one layer / casual` miss, miss (2 of 2).
- **By the declared bar: the 32K regression is NOT q8_0's.** f16 KV at
  32K fails the same rows and is, if anything, slightly worse on HARM.
  q8_0 is not RED on KV grounds at 32K either.
- **What remains real:** FULL docs at a 32K window score HARM ~30 against
  shipped COMPACT 16K's 25-28, with the same pass rate. That is what a
  user gets by raising Context size to 24576 or more. This pair cannot
  say whether the FULL prompt or the larger window is responsible, because
  `chat-probe` has no way to force the prompt mode. Filed as NEXT UP 11e.
