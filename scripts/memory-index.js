#!/usr/bin/env node
/*
 * memory-index.js — generate docs/MEMORY.md, the routing table into
 * docs/WORKPLAN-LOG.md.
 *
 *   node scripts/memory-index.js          # rewrite the index
 *   node scripts/memory-index.js --check  # exit 1 if it is stale
 *
 * WHY THIS EXISTS
 *
 * Every unattended pass is a fresh session with no memory of the last
 * one, and the loop's brief has always said "read docs/WORKPLAN-LOG.md".
 * Measured 2026-09-05: that file is 1,047,226 bytes — roughly 262,000
 * tokens — against a panel default context of 16,384. It cannot be read.
 * It could not be read weeks ago. So "read the log" has quietly meant
 * "read some arbitrary part of the log", and no pass has known what it
 * was missing.
 *
 * That is the difference between an archive and a memory. A directory
 * of history is not memory if the reader cannot work out which three
 * pages to open. The fix is not a smaller log — the log is a good audit
 * trail and should stay append-only — it is a ROUTING TABLE that is
 * small enough to be always resident, and precise enough to retrieve
 * from.
 *
 * The index is GENERATED for the same reason CAPABILITIES.md is: a
 * hand-maintained index of a file that grows every night is stale by the
 * second night, and a stale index is worse than none because it is
 * believed. tests/test-memory-index.js runs --check, so CI fails when
 * the log grows without the index following.
 *
 * WHAT IT SOLVES, SPECIFICALLY
 *
 * 1. Retrieval. Every entry gets a line range, so a pass reads exactly
 *    one entry with `sed -n 'START,ENDp'` instead of guessing.
 * 2. Contradiction rot. The log holds 38 corrections and retractions
 *    INTERLEAVED with the claims they overturn — a pass that greps for a
 *    fact can hit the dead version and never see the correction. Those
 *    entries are lifted into their own always-resident section, so a
 *    superseded claim can no longer be read as current.
 * 3. Subsystem routing. 200-odd entries, but a pass working on masks
 *    needs about ten of them. Tagging by subsystem turns "grep and hope"
 *    into a short candidate list.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOG = path.join(ROOT, "docs", "WORKPLAN-LOG.md");
const DOC = path.join(ROOT, "docs", "MEMORY.md");
const BEGIN = "<!-- BEGIN GENERATED INDEX (scripts/memory-index.js) -->";
const END = "<!-- END GENERATED INDEX -->";

// How many of the most recent entries to list in full. The budget this
// whole file exists to respect is the always-resident one, so this is
// deliberately small; everything older is reachable by subsystem or by
// grep, which is the point.
const RECENT = 12;

// Subsystem tags. Order matters — the first match wins, so the more
// specific patterns come first. These are matched against an entry's
// TITLE AND BODY, because a title like "the no-op that waited to be
// asked" names no subsystem at all.
const TAGS = [
  ["premiere",  /\bpremiere\b|\bppro\b|\bmogrt\b|\b12b\b/i],
  ["mask",      /\bmask\b|\bparade\b|\bellipse\b|\bfeather\b/i],
  ["prompt",    /\bprompt\b|paraphrase|\brouting\b|phrase list|\bcompact\b/i],
  ["harness",   /\bharness\b|self-?test|\bselftest\b|\bstub\b/i],
  ["loop",      /overnight|run-local-agent|\bwatchdog\b|\bdialog\b|\bmodal\b/i],
  ["comfy",     /\bcomfy\b|\bvram\b|\btier\b|sage|triton/i],
  ["expr",      /expression|link_property|set_expression/i],
  ["effects",   /\beffect\b|apply_effect|set_effect_param/i],
  ["keyframes", /keyframe|\bease\b|stagger|\baudio\b/i],
  ["render",    /\brender\b|export|\bffmpeg\b|\bwhisper\b/i],
  ["setup",     /\bsetup\b|\binstall\b|\bmodel\b|download/i],
];

// An entry that overturns an earlier one. These get their own section:
// a correction that is only findable by reading the whole log is not a
// correction, it is a second opinion sitting next to the first.
const RETRACTION =
  /\bretract|\bsupersed|CORRECTION|was wrong|is now simply WRONG|no longer true|I had it backwards/i;

function read(p) { return fs.readFileSync(p, "utf8"); }

/** Parse the log into entries with line ranges. */
function parseLog(text) {
  const lines = text.split("\n");
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i])) heads.push(i);
  }
  return heads.map((start, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] - 1 : lines.length - 1;
    const head = lines[start].replace(/^##\s*/, "").trim();
    const body = lines.slice(start, end + 1).join("\n");
    const dm = head.match(/^(\d{4}-\d{2}-\d{2})/);
    const vm = head.match(/\((\d+\.\d+\.\d+)\)/);
    // Strip the date and any parenthetical origin, leaving the claim.
    let title = head
      .replace(/^\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2})?/, "")
      .replace(/^\s*\((?:local|remote)[^)]*\)/i, "")
      .replace(/^\s*[—-]\s*/, "")
      .trim();
    if (!title) title = head;
    const e = {
      line: start + 1,          // 1-indexed, for sed
      endLine: end + 1,
      date: dm ? dm[1] : "",
      version: vm ? vm[1] : "",
      title: title,
      body: body,
      tags: tagsFor(head, leadOf(body)),
      retracts: false,
    };
    e.retracts = isRetraction(e);
    return e;
  });
}

// Tag against the entry's TITLE and its opening paragraphs only, and
// keep the two strongest.
//
// The first version matched the whole body and gave almost every entry
// six to eight tags ("premiere, mask, prompt, harness, loop, comfy,
// expr, setup"). These entries are long enough to mention every
// subsystem in passing, so a tag that fires on four fifths of them
// carries no routing information at all — which is the only thing a tag
// is for here. An entry's own opening is where it says what it is
// about; the rest is working.
function tagsFor(title, lead, exclude) {
  const scored = [];
  for (const [name, re] of TAGS) {
    if (exclude && exclude.indexOf(name) !== -1) continue;
    const g = new RegExp(re.source, "gi");
    const t = (String(title).match(g) || []).length;
    const l = (String(lead).match(g) || []).length;
    // The title is the entry's own claim about itself; weight it.
    const score = t * 4 + l;
    if (score > 0) scored.push([name, score]);
  }
  if (!scored.length) return ["other"];
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, 2).map(x => x[0]);
}

/** An entry's opening prose — its own summary, before the working. */
function leadOf(body) {
  return body.split("\n").slice(1, 14).join("\n");
}

/**
 * The sentence a correction is actually making.
 *
 * Extracted per PARAGRAPH, not per line. Markdown here is hard-wrapped
 * at ~72 columns, so a line-by-line reader returns fragments like
 * "keeps. The first half was wrong, in both hosts:" — which is not a
 * summary of anything and cannot be acted on.
 */
function retractionText(entry) {
  const paras = entry.body.split(/\n\s*\n/);
  for (const para of paras) {
    const flat = para.replace(/\s*\n\s*/g, " ")
                     .replace(/^[\s>*\-#]+/, "")
                     .replace(/\*\*/g, "").replace(/`/g, "").trim();
    // The ANNOUNCING paragraph, matching isRetraction: a marker in the
    // opening clause, not anywhere in a long note.
    if (flat.length < 40) continue;
    if (!MARKER.test(para) && !RETRACTION.test(flat.slice(0, 90))) continue;
    // First sentence or two, whole — never cut mid-word.
    const m = flat.match(/^.{40,200}?[.:](\s|$)/);
    const out = (m ? m[0] : flat.slice(0, 200)).trim();
    return out.length < flat.length ? out.replace(/[.:]$/, "") : out;
  }
  return "";
}

/**
 * Does this entry actually CORRECT something?
 *
 * UNDER-LISTING IS SAFE HERE; OVER-LISTING IS NOT. A correction index
 * that also contains design statements and receipt descriptions teaches
 * the reader to skim past it, and then the one entry that really does
 * overturn a fact goes unread — which is the exact failure the section
 * exists to prevent. So this is deliberately strict, and entries it
 * misses are still reachable by grep (the section says so).
 *
 * Two ways in, both requiring the entry to ANNOUNCE the correction
 * rather than merely contain the word:
 *   1. an explicit marker line, which is the forward-looking contract
 *      (see docs/MEMORY.md — passes are asked to write one);
 *   2. the correction is in the entry's own TITLE, or opens a paragraph.
 * A "was wrong" buried in the ninth paragraph of a working note is not
 * an announcement and is not indexed.
 */
const MARKER = /^(?:>\s*)?(?:SUPERSEDES|CORRECTION|RETRACTION)\s*[:—-]/im;

function isRetraction(entry) {
  if (MARKER.test(entry.body)) return true;
  if (RETRACTION.test(entry.title)) return true;
  for (const para of entry.body.split(/\n\s*\n/)) {
    const flat = para.replace(/\s*\n\s*/g, " ")
                     .replace(/^[\s>*\-#]+/, "")
                     .replace(/\*\*/g, "").trim();
    // Announced: the correction is in the paragraph's opening clause.
    if (flat.length > 30 && RETRACTION.test(flat.slice(0, 90))) return true;
  }
  return false;
}

function esc(s) { return String(s).replace(/\|/g, "\\|"); }

/**
 * A tag on a third of the corpus cannot route anything.
 *
 * "harness" landed on 110 of 211 entries, not because those entries are
 * about the harness but because every pass reports its harness score in
 * its opening lines. A universal is not a category. Drop such tags and
 * let those entries fall to their next-best one, so the section keeps
 * its only job: turning 200 entries into a short candidate list.
 */
function dropBroadTags(entries) {
  const LIMIT = Math.max(8, Math.floor(entries.length / 3));
  const count = {};
  for (const e of entries) for (const t of e.tags) count[t] = (count[t] || 0) + 1;
  const broad = Object.keys(count).filter(t => t !== "other" && count[t] > LIMIT);
  if (!broad.length) return [];
  for (const e of entries) {
    const kept = e.tags.filter(t => broad.indexOf(t) === -1);
    if (kept.length) { e.tags = kept; continue; }
    // Re-tag from the strongest tag that is not over-broad.
    const next = tagsFor(e.title, leadOf(e.body), broad);
    e.tags = next;
  }
  return broad;
}

function build(entries, logBytes, broad) {
  const out = [];
  const total = entries.length;
  const recent = entries.slice(-RECENT).reverse();

  out.push("");
  out.push("_Generated by `node scripts/memory-index.js` — CI fails if " +
           "stale (tests/test-memory-index.js). Do not hand-edit below " +
           "this line._");
  out.push("");
  out.push("`docs/WORKPLAN-LOG.md` holds **" + total + " entries, " +
           (logBytes / 1048576).toFixed(2) + " MB (~" +
           Math.round(logBytes / 4000) + "k tokens)**. It is the audit " +
           "trail, not something to read. Retrieve from it by line " +
           "range:");
  out.push("");
  out.push("```");
  out.push("sed -n '<START>,<END>p' docs/WORKPLAN-LOG.md   # one entry, exactly");
  out.push("grep -n '<term>' docs/WORKPLAN-LOG.md          # when the index has no lead");
  out.push("```");
  out.push("");

  // --- superseded claims ------------------------------------------------
  const rets = entries.filter(e => e.retracts).reverse();
  out.push("## Superseded / corrected — read these before trusting an older entry");
  out.push("");
  out.push("A correction sits next to the claim it overturns, so a grep " +
           "can land on the dead version and never see this. " +
           rets.length + " entries ANNOUNCE one (in their title, in a " +
           "paragraph's opening clause, or with an explicit marker). " +
           "Entries that merely mention being wrong somewhere in the " +
           "middle are deliberately not listed — a section padded with " +
           "those gets skimmed, and then the real correction goes " +
           "unread. `grep -niE 'retract|supersed|CORRECTION'` for the " +
           "long tail.");
  out.push("");
  out.push("| Date | Lines | What changed |");
  out.push("|---|---|---|");
  for (const e of rets.slice(0, 14)) {
    const what = retractionText(e) || e.title;
    out.push("| " + e.date + " | `" + e.line + "," + e.endLine + "` | " +
             esc(what) + " |");
  }
  if (rets.length > 14) {
    out.push("");
    out.push("_" + (rets.length - 14) + " older corrections not listed — " +
             "`grep -niE 'retract|supersed|CORRECTION' docs/WORKPLAN-LOG.md`._");
  }
  out.push("");

  // --- recent ------------------------------------------------------------
  out.push("## Most recent " + recent.length + " entries");
  out.push("");
  out.push("| Date | Lines | Ver | Entry | Tags |");
  out.push("|---|---|---|---|---|");
  for (const e of recent) {
    out.push("| " + e.date + " | `" + e.line + "," + e.endLine + "` | " +
             (e.version || "—") + " | " + esc(e.title) + " | " +
             e.tags.join(", ") + " |");
  }
  out.push("");

  // --- by subsystem ------------------------------------------------------
  out.push("## By subsystem");
  out.push("");
  out.push("Working on one of these? These are the entries to retrieve, " +
           "newest first — not the whole log.");
  if (broad && broad.length) {
    out.push("");
    out.push("_Not listed as tags: **" + broad.join("**, **") + "** — each " +
             "appears in over a third of entries, so it cannot narrow " +
             "anything. Grep for those._");
  }
  out.push("");
  const byTag = {};
  for (const e of entries) {
    for (const t of e.tags) (byTag[t] = byTag[t] || []).push(e);
  }
  const names = Object.keys(byTag).sort(
    (a, b) => byTag[b].length - byTag[a].length);
  for (const t of names) {
    const list = byTag[t].slice().reverse();
    const shown = list.slice(0, 8)
      .map(e => "`" + e.line + "`&nbsp;" + e.date.slice(5))
      .join(" · ");
    out.push("- **" + t + "** (" + list.length + ") — " + shown +
             (list.length > 8 ? " · …" : ""));
  }
  out.push("");
  return out.join("\n");
}

const SHELL = `# Memory index

**This file is the map. \`docs/WORKPLAN-LOG.md\` is the territory, and it
is far too large to read.**

Read this first, then retrieve the two or three log entries it points at.
A pass that reads the log top-to-bottom, or greps it blind, is the
failure this index exists to prevent: it will find a superseded claim as
readily as a current one and cannot tell them apart.

**The memory tiers, and what each is for:**

| Tier | File | Size | How it is used |
|---|---|---|---|
| Pinned facts | \`CLAUDE.md\` | ~2.7k tok | Always resident. Never evicted. The facts that must survive everything. |
| Orientation | \`docs/ORIENTATION.md\` | ~2.8k tok | Read once by a session new to the repo. |
| The queue | \`docs/WORKPLAN.md\` | ~46k tok | Read the SECTION you are working in, not the file. |
| **This index** | \`docs/MEMORY.md\` | small | **Always resident.** The routing table below. |
| Audit trail | \`docs/WORKPLAN-LOG.md\` | ~262k tok | **Never resident.** Retrieved by line range. |

**A fact that implies WORK belongs in \`docs/WORKPLAN.md\`, not only
here.** Writing a finding into the log alone puts it in the tier nothing
reads for work, so the loop never acts on it. That has already happened
once (2026-09-03: a finding was logged with the words "Filed in
WORKPLAN" while no such filing existed), and it is the routing failure
this whole structure is meant to make impossible.

${BEGIN}
${END}
`;

function main() {
  const check = process.argv.includes("--check");
  const logText = read(LOG);
  const entries = parseLog(logText);
  const broad = dropBroadTags(entries);
  const generated = build(entries, Buffer.byteLength(logText), broad);

  let shell = SHELL;
  if (fs.existsSync(DOC)) {
    const cur = read(DOC);
    if (cur.indexOf(BEGIN) !== -1 && cur.indexOf(END) !== -1) shell = cur;
  }
  const a = shell.indexOf(BEGIN);
  const b = shell.indexOf(END);
  if (a === -1 || b === -1) {
    console.error("markers missing in " + DOC);
    process.exit(2);
  }
  const next = shell.slice(0, a + BEGIN.length) + "\n" + generated +
               shell.slice(b);

  if (check) {
    const cur = fs.existsSync(DOC) ? read(DOC) : "";
    if (cur !== next) {
      console.error("docs/MEMORY.md is STALE — run: node scripts/memory-index.js");
      process.exit(1);
    }
    console.log("docs/MEMORY.md is up to date (" + entries.length +
                " entries indexed)");
    return;
  }
  fs.writeFileSync(DOC, next);
  console.log("wrote docs/MEMORY.md — " + entries.length + " entries, " +
              entries.filter(e => e.retracts).length + " corrections, " +
              Math.round(Buffer.byteLength(next) / 4) + " tokens");
}

main();
