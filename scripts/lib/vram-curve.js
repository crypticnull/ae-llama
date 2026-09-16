/*
 * vram-curve.js — read the SHAPE of a VRAM trace, not just its maximum.
 *
 * Why this exists (§18 P7c step 2c, 2026-09-16). `catalog-vram-probe.js`
 * has streamed nvidia-smi at 250 ms since it was written, precisely so a
 * VAE spike cannot fall between two samples. It then reduced the whole
 * series to ONE number — the peak — and threw the samples away when the
 * process exited. So when the workplan asked "does ltx-small's 13 921 MiB
 * peak even HOLD the text encoder, or had ComfyUI already evicted it?",
 * the item said "re-read the trace for two humps" and there was no trace
 * to re-read: the transcript carries `samples 61 over 14s` and the peak,
 * and nothing in between. A measurement that cannot be re-interpreted has
 * to be re-RUN, on a machine the owner uses for paid work.
 *
 * That question is not ltx-small's alone. 45 percent of that entry's
 * resident weights are the T5 encoder; ComfyUI was separately measured
 * evicting the encoder before sampling for MiniMax H3. Whether the peak
 * contains one model or two decides whether a gate is right, and it is
 * readable straight off the curve: a load-then-evict looks like two
 * humps, a load-and-hold looks like one staircase.
 *
 * So: the probe keeps its samples and hands them here. This module is
 * pure — an array of {t, mb} in, a description out — which is the whole
 * reason it is a separate file: `catalog-vram-probe.js` needs a GPU, a
 * backend and real weights to run at all, and a stubbed test can exercise
 * none of it.
 *
 * It DESCRIBES and does not conclude. "Two humps 4.9 GB apart" is a
 * measurement; "therefore the gate is 12" is a judgement about what this
 * machine can prove, and §18 P7c step 3 reserves those for a human
 * reading the transcript.
 */
"use strict";

/* A fall this deep says something was RELEASED, not that a buffer moved.
 * The smallest thing whose eviction would matter here is a text encoder,
 * and the smallest encoder in the catalog is t5xxl_fp8 at 4 918 MiB, so
 * 1 GiB is well under anything load-bearing while staying clear of the
 * ±25 MiB of jitter two identical runs showed (13 696 vs 13 921). */
const DROP_MB = 1024;

function peakOf(samples) {
  return (samples || []).reduce(function (a, s) {
    return s.mb > a ? s.mb : a;
  }, 0);
}

/* Split the series at every point where it falls DROP_MB below the
 * highest reading since the last such fall. Each piece is one "hump":
 * where it topped out, when, and how far it then fell.
 *
 * Deliberately a single forward pass with no smoothing. A smoother would
 * decide which spikes are real, and this file's job is to report what
 * nvidia-smi said. */
function humps(samples, dropMB) {
  const drop = typeof dropMB === "number" ? dropMB : DROP_MB;
  const out = [];
  let top = null;      // highest sample of the hump being built
  let bottom = null;   // lowest sample since that top
  let fallen = false;  // the hump is over; we are in the valley after it

  (samples || []).forEach(function (s) {
    if (top === null) { top = s; bottom = s; return; }
    if (!fallen) {
      if (s.mb > top.mb) { top = s; bottom = s; return; }
      if (s.mb < bottom.mb) bottom = s;
      if (top.mb - s.mb >= drop) fallen = true;
      return;
    }
    // In the valley. Keep following it down; only a climb of `drop` back
    // out of it starts the next hump — otherwise the noise at the bottom
    // of a release would each count as its own.
    if (s.mb < bottom.mb) { bottom = s; return; }
    if (s.mb - bottom.mb >= drop) {
      out.push({ peakMB: top.mb, peakT: top.t,
                 troughMB: bottom.mb, troughT: bottom.t });
      top = s;
      bottom = s;
      fallen = false;
    }
  });

  if (top !== null) {
    out.push({ peakMB: top.mb, peakT: top.t,
               troughMB: bottom === null ? top.mb : bottom.mb,
               troughT: bottom === null ? top.t : bottom.t });
  }
  return out;
}

/* The one question §18 P7c step 2c asks: was the card ever DROPPED from
 * before the global peak? If it was, whatever was released is not part of
 * the peak, and the peak is not "everything this job loads".
 *
 * Returns the deepest such release strictly before the peak sample, or
 * null when the curve only ever climbs to its maximum. */
function releaseBeforePeak(samples, dropMB) {
  const drop = typeof dropMB === "number" ? dropMB : DROP_MB;
  const ss = samples || [];
  if (!ss.length) return null;
  let peakI = 0;
  for (let i = 1; i < ss.length; i++) if (ss[i].mb > ss[peakI].mb) peakI = i;

  let best = null;
  let top = null;
  for (let i = 0; i < peakI; i++) {
    const s = ss[i];
    if (top === null || s.mb > top.mb) { top = s; continue; }
    const fell = top.mb - s.mb;
    if (fell >= drop && (best === null || fell > best.fellMB)) {
      best = { fromMB: top.mb, fromT: top.t, toMB: s.mb, toT: s.t, fellMB: fell };
    }
  }
  return best;
}

/* One line a human reads in the transcript without expanding anything. */
function describe(samples, dropMB) {
  const ss = samples || [];
  if (!ss.length) return "no samples";
  const hs = humps(ss, dropMB);
  const rel = releaseBeforePeak(ss, dropMB);
  const peak = peakOf(ss);
  const parts = [hs.length + (hs.length === 1 ? " hump" : " humps")];
  parts.push("peak " + peak + " MiB");
  if (rel) {
    parts.push("released " + rel.fellMB + " MiB before it (" +
               rel.fromMB + " -> " + rel.toMB + " MiB at " +
               (rel.toT / 1000).toFixed(1) + "s)");
  } else {
    parts.push("no release of " +
               (typeof dropMB === "number" ? dropMB : DROP_MB) +
               "+ MiB before it");
  }
  return parts.join("; ");
}

/* The series itself, for the transcript. Every sample, because the point
 * of keeping it is that the next question is not this question: a run
 * decimated to one reading a second cannot answer "did the VAE spike",
 * which is the reason the probe samples at 250 ms in the first place. */
function seriesLines(samples, perLine) {
  const n = perLine || 12;
  const ss = samples || [];
  const lines = [];
  for (let i = 0; i < ss.length; i += n) {
    lines.push(ss.slice(i, i + n).map(function (s) {
      return s.t + ":" + s.mb;
    }).join(" "));
  }
  return lines;
}

/* The number to publish from N runs of one entry: the HIGHEST, never the
 * mean or the last (NEXT UP 7e, 2026-09-16). sdxl-fp8's 1024x1024 VAE
 * decode spikes ~2 100 MiB above its sampling plateau for less than one
 * 250 ms sample, and four identical runs read delta 4 730, 6 906, 6 906,
 * 4 826 depending on whether a sample landed in the spike. A sampler can
 * only ever MISS a peak, never invent one, so every reading is a lower
 * bound and the max over runs is the best of them. `spread` is how far
 * apart the runs landed: a large one says the sampler is still missing
 * something and more runs (or a faster -lms) are owed.
 *
 * runs: [{delta, peak, ...}] for ONE entry. Returns null for no runs. */
function maxOverRuns(runs) {
  const rs = (runs || []).filter(function (r) {
    return r && typeof r.delta === "number" && !isNaN(r.delta);
  });
  if (!rs.length) return null;
  let best = rs[0];
  rs.forEach(function (r) { if (r.delta > best.delta) best = r; });
  const deltas = rs.map(function (r) { return r.delta; });
  return {
    runs: rs.length,
    delta: best.delta,
    peak: rs.reduce(function (a, r) { return r.peak > a ? r.peak : a; }, 0),
    bestRun: rs.indexOf(best),
    deltas: deltas,
    spread: best.delta - Math.min.apply(null, deltas)
  };
}

module.exports = { DROP_MB, peakOf, humps, releaseBeforePeak, describe,
                   seriesLines, maxOverRuns };
