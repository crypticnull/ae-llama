// Regression test: scripts/lib/vram-curve.js — the SHAPE of a VRAM trace.
//
// The bug class this exists to catch is not an arithmetic one. It is a
// measurement that cannot be re-interpreted: `catalog-vram-probe.js`
// streamed nvidia-smi at 250 ms, reduced the series to its maximum, and
// dropped the samples on exit. So when §18 P7c step 2c asked whether
// ltx-small's 13 921 MiB peak still held the 4 918 MiB text encoder — a
// question that decides whether the gate is 16 or lower, and therefore
// whether a 12 GB card gets video at all — the transcript said
// "samples 61 over 14s" and nothing else, and the only way to answer was
// to re-run the job on the machine the owner does paid work on.
//
// The probe needs a GPU, a backend and 11 GB of real weights to run one
// line of this logic. The logic itself is pure, so it lives in a lib and
// is tested here from synthetic traces whose right answer is known.
"use strict";
const curve = require("../scripts/lib/vram-curve");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}
function eq(got, want, msg) {
  assert(got === want, msg + " (got " + JSON.stringify(got) +
                       ", want " + JSON.stringify(want) + ")");
}

/* Build {t, mb} the way startWitness() does: 250 ms apart, in order. */
function trace(values) {
  return values.map(function (mb, i) { return { t: i * 250, mb: mb }; });
}

// --------------------------------------------------------------- peakOf

eq(curve.peakOf(trace([4188, 9000, 17884, 12000])), 17884,
   "peakOf returns the maximum reading");
eq(curve.peakOf([]), 0, "peakOf of an empty trace is 0, not NaN");
eq(curve.peakOf(null), 0, "peakOf tolerates no samples at all");

// ---------------------------------------------------------------- humps

/* LOAD AND HOLD. Encoder in, diffusion on top of it, VAE spike, release
 * at the end. Everything the job touched is resident at the peak, so the
 * delta really is what a card of that size must hold. One hump. */
const hold = trace([4188, 4190, 9106, 9106, 9110, 15153, 15153, 17884,
                    17800, 4188]);
eq(curve.humps(hold).length, 1, "a load-and-hold staircase is ONE hump");
eq(curve.releaseBeforePeak(hold), null,
   "load-and-hold: nothing was released before the peak");

/* LOAD, EVICT, LOAD — what ComfyUI was measured doing with MiniMax H3's
 * encoder. The encoder's 4 918 MiB come and go BEFORE the diffusion
 * model is loaded, so the peak never holds both and a gate written from
 * the peak is a gate for the larger half only. Two humps. */
const evict = trace([4188, 9106, 9106, 4200, 4190, 12000, 13921, 13900,
                     4188]);
const evicted = curve.humps(evict);
eq(evicted.length, 2, "load-evict-load is TWO humps");
eq(evicted[0].peakMB, 9106, "first hump tops out where the encoder did");
eq(evicted[1].peakMB, 13921, "second hump tops out at the global peak");
const rel = curve.releaseBeforePeak(evict);
assert(rel !== null, "load-evict-load: a release before the peak is found");
eq(rel.fromMB, 9106, "the release starts at the first hump's top");
eq(rel.toMB, 4190, "the release bottoms out at the deepest trough");
eq(rel.fellMB, 9106 - 4190, "the release depth is the full fall");

/* ORDER MATTERS. The same readings, evicting AFTER the peak instead of
 * before it, is a load-and-hold with a tidy-up: that peak DID hold
 * everything and the gate stands. A summariser that just looked for "a
 * big fall somewhere" would call these two traces the same. */
const tidy = trace([4188, 9106, 13921, 13900, 9106, 4190, 4188]);
eq(curve.releaseBeforePeak(tidy), null,
   "a release AFTER the peak does not count as one before it");
eq(curve.humps(tidy).length, 1,
   "a single climb followed by the final release is one hump");

/* JITTER IS NOT A RELEASE. Two identical ltx-small runs came in 225 MiB
 * apart, so nothing under a gigabyte may be read as an eviction. */
const jitter = trace([4188, 9106, 9000, 9106, 8900, 13921, 13800, 4188]);
eq(curve.humps(jitter).length, 1, "sub-GiB wobble does not split a hump");
eq(curve.releaseBeforePeak(jitter), null,
   "sub-GiB wobble is not a release before the peak");

/* The threshold is a parameter, so a future question can ask a sharper
 * one without editing the probe. */
eq(curve.humps(jitter, 100).length, 3,
   "a 100 MiB threshold does split the same wobble");

// ------------------------------------------------------------- describe

assert(/2 humps/.test(curve.describe(evict)),
       "describe() names the hump count");
assert(/released 4916 MiB before it/.test(curve.describe(evict)),
       "describe() states how much was released before the peak");
assert(/no release of 1024\+ MiB before it/.test(curve.describe(hold)),
       "describe() says plainly when nothing was released");
eq(curve.describe([]), "no samples", "describe() of an empty trace");

// ---------------------------------------------------------- seriesLines

const lines = curve.seriesLines(trace([1, 2, 3, 4, 5]), 2);
eq(lines.length, 3, "seriesLines wraps at the requested width");
eq(lines[0], "0:1 250:2", "seriesLines writes t_ms:MiB pairs");
eq(curve.seriesLines(trace([1, 2, 3, 4, 5]), 2).join(" ").split(" ").length,
   5, "seriesLines keeps EVERY sample — the 250 ms cadence is the point");

// ---------------------------------------------------------- maxOverRuns
//
// NEXT UP 7e. sdxl-fp8's four identical runs read 4 730 / 6 906 / 6 906 /
// 4 826 MiB because a <250 ms VAE decode spike fell between samples in two
// of them. Publishing any one run (or a mean) under-states the card.

function runOf(values) {
  const ss = trace(values);
  return { delta: curve.peakOf(ss) - 2434, peak: curve.peakOf(ss), samples: ss };
}
const caught = runOf([2434, 7164, 7200, 9340, 7100, 2434]);  // sampled the spike
const missed = runOf([2434, 7164, 7200, 7260, 7100, 2434]);  // stepped over it
const mx = curve.maxOverRuns([missed, caught, missed]);
eq(mx.delta, 6906, "maxOverRuns publishes the run that caught the spike");
eq(mx.peak, 9340, "maxOverRuns carries the highest peak");
eq(mx.bestRun, 1, "maxOverRuns names which run it was");
eq(mx.runs, 3, "maxOverRuns counts the runs");
eq(mx.spread, 2080, "maxOverRuns reports how far apart the runs landed");
eq(curve.maxOverRuns([missed, missed]).delta, 4826,
   "with no run catching it, the max is still the best lower bound");
eq(curve.maxOverRuns([]), null, "maxOverRuns of no runs is null, not 0");
eq(curve.maxOverRuns([{ delta: NaN, peak: 1 }, missed]).runs, 1,
   "a run with no reading is not averaged in as a number");

// ------------------------------------------------ the probe actually uses it

/* Guard the wiring, not just the lib: the probe kept a peak-only report
 * for as long as it did because nothing tied its transcript to the
 * samples it was already collecting. */
const fs = require("fs");
const path = require("path");
const probe = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "catalog-vram-probe.js"), "utf8");
assert(/require\(["']\.\/lib\/vram-curve["']\)/.test(probe),
       "catalog-vram-probe.js requires the curve lib");
assert(/samples: w\.samples/.test(probe),
       "the measurement carries its samples, so the transcript can print them");
assert(/"## curve"/.test(probe),
       "the transcript has a curve section");
assert(/curve\.describe\(/.test(probe),
       "the console line states the shape while the run is still on screen");
assert(/"--repeat"/.test(probe) && /curve\.maxOverRuns\(/.test(probe),
       "--repeat exists and the probe reports the max over its runs (7e)");
const lmsDefault = /argValue\("--sample-ms", "(\d+)"\)/.exec(probe);
assert(lmsDefault && parseInt(lmsDefault[1], 10) < 250,
       "the generation witness samples faster than 250 ms by default (7e)");
assert(/String\(ms \|\| OPT\.sampleMs\)/.test(probe),
       "startWitness streams at the configured cadence, not a literal 250");

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
process.exit(failed ? 1 : 0);
