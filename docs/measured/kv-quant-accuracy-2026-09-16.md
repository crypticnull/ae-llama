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
