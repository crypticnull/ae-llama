// Regression test: scripts/mogrt-foreign-probe.js — reading capsules
// this project did not write.
//
// The probe's value is that its corpus comes from Adobe, so its GRADER
// is the part that can rot in this repo. Every capsule below is built
// here, byte by byte, with its own CRC (the same independence rule
// tests/test-mogrt-read.js states), and each one pins a verdict the
// probe must reach on a file nobody here authored:
//
//   - a Premiere-shaped roster reads, and is NOT provisional
//   - a controller GROUP reads to its leaves, flagged nested (the plan
//     lists groups as unmeasured; this is how they get measured)
//   - a non-en_US locale picks the English string, not the tag
//   - the 0.11.5 bug — names coming back as LOCALE TAGS — is a FAIL
//     with the tags named, never a pass
//   - a shape the key list does not know reads through the fallback and
//     says so, because a fallback answering for an Adobe file means the
//     key list is missing something real
//   - a capsule that is not a zip FAILS; one that cannot be opened at
//     all is SKIPPED, not counted against the reader
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const probe = require("../scripts/mogrt-foreign-probe.js");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

// ------------------------------------------------- independent builder
function le16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function le32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zip(entries) {
  const parts = [], cent = [];
  let off = 0;
  entries.forEach(function (e) {
    const data = Buffer.from(e.data);
    const body = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const nb = Buffer.from(e.name);
    const loc = Buffer.concat([le32(0x04034b50), le16(20), le16(0), le16(8),
      le16(0), le16(0), le32(crc), le32(body.length), le32(data.length),
      le16(nb.length), le16(0), nb]);
    parts.push(loc, body);
    cent.push(Buffer.concat([le32(0x02014b50), le16(20), le16(20), le16(0),
      le16(8), le16(0), le16(0), le32(crc), le32(body.length),
      le32(data.length), le16(nb.length), le16(0), le16(0), le16(0), le16(0),
      le32(0), le32(off), nb]));
    off += loc.length + body.length;
  });
  const cdOff = off;
  const cd = Buffer.concat(cent);
  return Buffer.concat(parts.concat([cd, Buffer.concat([le32(0x06054b50),
    le16(0), le16(0), le16(entries.length), le16(entries.length),
    le32(cd.length), le32(cdOff), le16(0)])]));
}
const S = (s) => ({ strDB: [{ localeString: "en_US", str: s }] });
const PROJECT = "RIFX" + "x".repeat(300);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aell-foreign-"));
function capsule(name, definition) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, zip([
    { name: "definition.json", data: JSON.stringify(definition) },
    { name: "project.aegraphic", data: PROJECT }
  ]));
  return p;
}

// ---------------------------------------------- a Premiere-shaped file
{
  const g = probe.gradeCapsule(capsule("Plain.mogrt", {
    capsuleName: "Untitled",
    clientControls: [{ uiName: S("Headline"), type: 4, id: 1 },
                     { uiName: S("Colour"), type: 5, id: 2 }]
  }));
  assert(g.ok && g.controllers === 2, "a Premiere-shaped roster reads: " + g.note);
  assert(g.provisional === false && g.rosterVia === "clientControls",
         "and is not provisional — the known key answered");
  assert(g.names.join(",") === "Headline,Colour",
         "with the controller NAMES, not their wrappers: " + g.names.join(","));
}

// ------------------------------------------------- a controller GROUP
{
  const g = probe.gradeCapsule(capsule("Grouped.mogrt", {
    capsuleName: "Untitled",
    clientControls: [
      { uiName: S("Headline"), type: 4, id: 1 },
      { uiName: S("Group A"), type: 9, id: 2,
        controls: [{ uiName: S("Inner Size"), type: 4, id: 3 },
                   { uiName: S("Inner Tint"), type: 5, id: 4 }] }]
  }));
  assert(g.ok && g.controllers === 3,
         "a group reads to its LEAVES, not the group row: " + g.controllers);
  assert(g.names.indexOf("Inner Size") !== -1 &&
         g.names.indexOf("Group A") === -1,
         "the leaves are named and the group is not: " + g.names.join(","));
  assert(g.provisional === true && /nested/.test(String(g.rosterVia)),
         "flagged nested, which is what makes groups MEASURED here");
  assert(/known key, nested/.test(g.note) && !/FALLBACK/.test(g.note),
         "and the note says known-key-nested, never 'fallback': " + g.note);
}

// -------------------------------------------------- a foreign locale
{
  const g = probe.gradeCapsule(capsule("German.mogrt", {
    capsuleName: "Untitled",
    clientControls: [{ uiName: { strDB: [
      { localeString: "de_DE", str: "Farbe" },
      { localeString: "en_US", str: "Colour" }] }, type: 5, id: 1 }]
  }));
  assert(g.ok && g.names[0] === "Colour",
         "a de_DE-first capsule still yields the en_US string: " + g.names[0]);
}

// ------------------------- the 0.11.5 bug: names that are locale tags
{
  const g = probe.gradeCapsule(capsule("Tagged.mogrt", {
    capsuleName: "Untitled",
    // The shape the reader INVENTED before it met a real file: value and
    // tag swapped. If a future edit reintroduces it, every name becomes
    // "en_US" and this capsule is how we hear about it.
    clientControls: [{ uiName: { strDB: [{ localeString: "Headline",
                                           str: "en_US" }] },
                       type: 4, id: 1 }]
  }));
  assert(!g.ok, "names that come back as LOCALE TAGS are a FAIL, not a pass");
  assert(/LOCALE TAGS/.test(g.note) && /en_US/.test(g.note),
         "and the note names the tags it saw: " + g.note);
}

// ------------------------------------------- a shape the keys miss
{
  const g = probe.gradeCapsule(capsule("Unknown.mogrt", {
    capsuleName: "Untitled",
    essentialProperties: [{ uiName: S("Odd One"), type: 4, id: 1 }]
  }));
  assert(g.ok && /FALLBACK/.test(g.note),
         "an unknown roster key reads through the fallback and says so: " +
         g.note);
  assert(g.provisional === true,
         "and is provisional — a fallback answering an Adobe file means " +
         "the key list is missing something real");
}

// --------------------------------------------- not a capsule at all
{
  const p = path.join(TMP, "Broken.mogrt");
  fs.writeFileSync(p, Buffer.from("this is not a zip"));
  const g = probe.gradeCapsule(p);
  assert(!g.ok && !g.skipped, "a file that is not a zip FAILS");
}
{
  const g = probe.gradeCapsule(path.join(TMP, "Absent.mogrt"));
  assert(!g.ok && g.skipped === true,
         "a capsule that cannot be opened is SKIPPED, not counted as a " +
         "reader defect: " + g.note);
}

// ------------------------------------------------------ the scan itself
{
  const found = probe.capsulesIn(TMP);
  assert(found.length >= 6, "capsulesIn finds the .mogrt files in a root");
  assert(found.every(function (f) { return /\.mogrt$/i.test(f); }),
         "and only .mogrt files");
  assert(probe.capsulesIn(path.join(TMP, "nope")).length === 0,
         "an absent root yields nothing rather than throwing");
  const roots = probe.candidateRoots();
  assert(Array.isArray(roots), "candidateRoots returns a list on any OS");
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
