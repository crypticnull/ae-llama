// Regression test: the .mogrt reader (extension/js/mogrt-read.js) proven
// against PLANTED defects — docs/SELF-VERIFY-PLANS.md section 1, "checker
// self-test".
//
// Independence rules, per the plan's refutation:
//   - Fixtures are hand-assembled here: local headers, central directory
//     and EOCD are laid out byte by byte by THIS file, never by the
//     reader's own writer (it has none) and never by a zip library the
//     reader might share code with. Only the deflate bodies come from
//     zlib.deflateRawSync — the reader inflates, it does not deflate.
//   - The CRC-32 used to stamp fixtures is a bitwise, table-free
//     implementation written below and checked against the published
//     check value (CRC32("123456789") = 0xCBF43926) before any fixture is
//     built. The reader carries its own table-driven one; agreement
//     between the two is measured, not assumed.
//   - A second, unrelated implementation (Python 3 zipfile) was run once
//     over the "all forms" fixture (2026-09-01, Linux container, Node
//     22): testzip() -> None; per entry, method / flag bits / CRC /
//     compressed and uncompressed sizes were identical to this reader's
//     entries; read('definition.json') began EF BB BF and decoded to the
//     same template name. That run is recorded here, not depended on.
//     Set AELL_MOGRT_FIXTURE_OUT=<path> to have this test write the same
//     fixture again for a re-check (PowerShell System.IO.Compression on
//     the Windows measure pass, per the plan).
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

const MogrtRead = require("../scripts/lib/mogrt-read.js");

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}
function has(list, re) {
  return list.some(function (s) { return re.test(String(s)); });
}

// ------------------------------------------------- independent CRC-32
// Bitwise, no table: a different implementation from the reader's.
function testCrc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
    }
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
assert(testCrc32(Buffer.from("123456789")) === 0xCBF43926,
  "the test's own CRC-32 matches the published check value");

// ------------------------------------------------- synthetic zip builder
//
// buildZip([{name, data, method, descriptor, utf8, methodField, body,
//            crcField, encrypted}], {comment})
// Returns {buf, layout: [{name, local, data, central, bodyLength}],
//          eocd}. `methodField` writes a different method number into
// BOTH headers; `body` substitutes the compressed bytes; `crcField`
// substitutes the stamped CRC (both headers). Byte offsets in `layout`
// let a case flip one specific byte.
function le16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF, 0); return b; }
function le32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function buildZip(specs, opts) {
  opts = opts || {};
  const parts = [];
  const layout = [];
  let offset = 0;
  const centrals = [];
  specs.forEach(function (s) {
    const data = Buffer.isBuffer(s.data) ? s.data : Buffer.from(String(s.data), "utf8");
    const method = s.method === undefined ? 8 : s.method;
    const body = s.body ? s.body :
      (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = s.crcField !== undefined ? s.crcField : testCrc32(data);
    const flags = (s.descriptor ? 0x0008 : 0) | (s.utf8 ? 0x0800 : 0) |
                  (s.encrypted ? 0x0001 : 0);
    const methodField = s.methodField === undefined ? method : s.methodField;
    const nameBytes = Buffer.from(s.name, s.utf8 ? "utf8" : "latin1");
    const localOffset = offset;
    const local = Buffer.concat([
      le32(0x04034b50), le16(20), le16(flags), le16(methodField),
      le16(0), le16(0),
      le32(s.descriptor ? 0 : crc),
      le32(s.descriptor ? 0 : body.length),
      le32(s.descriptor ? 0 : data.length),
      le16(nameBytes.length), le16(0), nameBytes
    ]);
    parts.push(local);
    const dataOffset = offset + local.length;
    parts.push(body);
    offset = dataOffset + body.length;
    if (s.descriptor) {
      const desc = Buffer.concat([le32(0x08074b50), le32(crc),
                                  le32(body.length), le32(data.length)]);
      parts.push(desc);
      offset += desc.length;
    }
    centrals.push(Buffer.concat([
      le32(0x02014b50), le16(20), le16(20), le16(flags), le16(methodField),
      le16(0), le16(0), le32(crc), le32(body.length), le32(data.length),
      le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0), le32(0),
      le32(localOffset), nameBytes
    ]));
    layout.push({ name: s.name, local: localOffset, data: dataOffset,
                  bodyLength: body.length });
  });
  const cdOffset = offset;
  let cdPos = cdOffset;
  centrals.forEach(function (c, i) {
    layout[i].central = cdPos;
    parts.push(c);
    cdPos += c.length;
  });
  const cdSize = cdPos - cdOffset;
  const comment = Buffer.from(opts.comment || "", "latin1");
  parts.push(Buffer.concat([
    le32(0x06054b50), le16(0), le16(0), le16(specs.length), le16(specs.length),
    le32(cdSize), le32(cdOffset), le16(comment.length), comment
  ]));
  return { buf: Buffer.concat(parts), layout: layout, eocd: cdPos };
}

// Offsets inside a local header / central record, for byte surgery.
const LOCAL_METHOD = 8, LOCAL_CRC = 14;
const CENTRAL_METHOD = 10, CENTRAL_CRC = 16, CENTRAL_CSIZE = 20;

function flip(buf, at) {
  const b = Buffer.from(buf);
  b[at] = b[at] ^ 0xFF;
  return b;
}

// ------------------------------------------------- definition fixtures
// The Adobe shape, MEASURED 2026-09-02 out of three templates AE 2026
// wrote (scripts/mogrt-verify-probe.js; the capture is
// tests/fixtures/ae2026-definition.json). These helpers used to build an
// INVENTED shape — `{localeString: <value>, localeStr: "en_US"}` and a
// `controlType` key — that matched the reader's equally invented guess.
// 105 checks passed against a reader that could not read one real file:
// every controller in every real export came back as the string "en_US".
// A fixture is only evidence when something outside this repo produced it.
function strDB(s) { return { strDB: [{ localeString: "en_US", str: s }] }; }
function adobeDef(name, controllers) {
  return JSON.stringify({
    // capsuleName is a PLAIN string in a real export (and always the
    // literal "Untitled" — see the AE_DEFAULT_TEMPLATE_NAME block).
    capsuleName: name,
    capsuleNameLocalized: strDB(name),
    capsuleVersion: 1,
    sourceInfoLocalized: { en_US: { name: name + " Comp" } },
    clientControls: controllers.map(function (c, i) {
      return { uiName: strDB(c[0]), type: c[1], id: i + 1 };
    })
  });
}
// The old key, kept alive on purpose: `controlType` was never measured in
// any AE build, but it is still a fallback and a fallback nobody exercises
// is a fallback nobody knows is broken.
function legacyTypeDef(name, controllers) {
  return JSON.stringify({
    capsuleName: name,
    clientControls: controllers.map(function (c, i) {
      return { uiName: strDB(c[0]), controlType: c[1], id: i + 1 };
    })
  });
}
function flatDef(name, controllers) {
  return JSON.stringify({
    name: name,
    controls: controllers.map(function (c) { return { name: c[0], type: c[1] }; })
  });
}
const ROSTER = [["Title", 4], ["Color", 5], ["Color", 5]];
const EXPECTED = ["Title", "Color", "Color"];

const PROJECT = Buffer.concat([Buffer.from("RIFX"), Buffer.alloc(600, 0x41)]);
const MEDIA = Buffer.alloc(3000);
for (let i = 0; i < MEDIA.length; i++) MEDIA[i] = (i * 7919) & 0xFF;

function baseSpecs(defText) {
  return [
    { name: "definition.json", data: defText, method: 8 },
    { name: "project.aep", data: PROJECT, method: 0 },
    { name: "media/still.png", data: MEDIA, method: 8 }
  ];
}

function verify(buf, extra) {
  const req = Object.assign({ path: "<synthetic>.mogrt", buffer: buf,
                              expectedControllers: EXPECTED }, extra || {});
  return MogrtRead.verifyExport(req);
}

// =========================================================== baseline
{
  const z = buildZip(baseSpecs(adobeDef("Brand Card", ROSTER)));
  const v = verify(z.buf, { templateName: "Brand Card" });
  assert(v.zipValid && v.errors.length === 0,
    "baseline: hand-built zip is valid, no errors (" + v.errors.join("; ") + ")");
  assert(v.entryCount === 3, "baseline: three entries walked");
  assert(v.entries.every(function (e) { return e.crcOk === true; }),
    "baseline: every entry inflated and CRC-agreed with the test's CRC");
  assert(v.definitionFound && v.templateNameInFile === "Brand Card" &&
         v.templateNameMatches === true,
    "baseline: definition parsed, template name read through strDB");
  assert(JSON.stringify(v.controllersInFile) === JSON.stringify(EXPECTED),
    "baseline: controller names read through uiName.strDB in order");
  assert(v.missing.length === 0 && v.extra.length === 0,
    "baseline: multiset parity holds");
  assert(v.duplicateCounts.Color === 2,
    "baseline: duplicate controller name counted (Color x2)");
  assert(JSON.stringify(v.controllerTypes) === "[4,5,5]",
    "baseline: control type codes read from type");
  assert(v.compNameInFile === "Brand Card Comp",
    "baseline: comp name read from sourceInfoLocalized.en_US.name");
}

{
  // The unmeasured alternate key still reads.
  const z = buildZip(baseSpecs(legacyTypeDef("Legacy", ROSTER)));
  const v = verify(z.buf);
  assert(JSON.stringify(v.controllersInFile) === JSON.stringify(EXPECTED) &&
         JSON.stringify(v.controllerTypes) === "[4,5,5]",
    "the legacy controlType key is still read when `type` is absent");
}

{
  const z = buildZip(baseSpecs(flatDef("Flat", ROSTER)));
  const v = verify(z.buf);
  assert(v.errors.length === 0 &&
         JSON.stringify(v.controllersInFile) === JSON.stringify(EXPECTED),
    "flat definition shape (name/controls/type) reads the same roster");
  assert(v.templateNameInFile === "Flat", "flat shape: template name via name");
}

{
  // Fallback: no known array key; the first array whose objects ALL carry
  // a name-like AND a type-like key. A fonts list sits before it and
  // must not be taken for the roster.
  const def = JSON.stringify({ header: { v: 2 },
    fonts: [{ name: "Arial" }, { name: "Inter" }, { name: "Inter" }],
    widgets: [{ label: "Title", type: 4 }, { label: "Color", type: 5 },
              { label: "Color", type: 5 }] });
  const z = buildZip(baseSpecs(def));
  const v = verify(z.buf);
  assert(v.errors.length === 0 &&
         JSON.stringify(v.controllersInFile) === JSON.stringify(EXPECTED),
    "unknown array key: fallback finds the typed name-bearing array, not the fonts list");
  assert(v.rosterVia === "fallback:widgets" && v.rosterProvisional === true,
    "fallback roster: rosterVia names the path, rosterProvisional true");
  assert(has(v.warnings, /roster read via fallback:widgets \(provisional/),
    "fallback roster: warning says the read is provisional");
  const ctl = MogrtRead.extractControllers(JSON.parse(def));
  assert(ctl.length === 3 && ctl[0].via === "fallback:widgets",
    "extractControllers reports which key it took the roster from");
}

{
  // Only a fonts list (name, no type): NOT a roster. Before the type
  // requirement this read three "controllers" named Arial/Inter/Inter.
  const def = JSON.stringify({ fonts: [{ name: "Arial" }, { name: "Inter" }] });
  const v = verify(buildZip(baseSpecs(def)).buf, { expectedControllers: ["Arial", "Inter"] });
  assert(Array.isArray(v.controllersInFile) && v.controllersInFile.length === 0 &&
         v.rosterVia === null,
    "a name-only list is not mistaken for controllers (controllersInFile stays [])");
  assert(has(v.errors, /"Arial" expected 1 time, measured 0/),
    "a name-only list: expected controllers reported missing, not matched");
}

{
  // Known key, flat: a FACT read.
  const v = verify(buildZip(baseSpecs(adobeDef("K", ROSTER))).buf);
  assert(v.rosterVia === "clientControls" && v.rosterProvisional === false,
    "known key clientControls: rosterVia is the key, rosterProvisional false");
  assert(!has(v.warnings, /provisional/),
    "known key: no provisional warning");
}

{
  // Nested Essential Graphics group: leaves are the roster, the group
  // name is not, and the read is flagged provisional.
  const def = JSON.stringify({
    capsuleName: strDB("Nested"),
    clientControls: [
      { uiName: strDB("Text Group"), clientControls: [
          { uiName: strDB("Title"), controlType: 4 },
          { uiName: strDB("Inner Group"), controls: [
              { uiName: strDB("Color"), controlType: 5 }] }] },
      { uiName: strDB("Color"), controlType: 5 }
    ]
  });
  const v = verify(buildZip(baseSpecs(def)).buf);
  assert(JSON.stringify(v.controllersInFile) === JSON.stringify(EXPECTED),
    "nested groups: leaf controllers in document order, group names dropped");
  assert(v.rosterVia === "clientControls (nested)" && v.rosterProvisional === true,
    "nested groups: rosterVia says nested, rosterProvisional true");
  assert(v.errors.length === 0 && v.missing.length === 0,
    "nested groups: multiset parity holds on the leaves");
  const r = MogrtRead.readRoster(JSON.parse(def));
  assert(r.nested === true && r.controllers.length === 3 && r.controllers[1].type === 5,
    "readRoster reports nested:true and the leaf types");
}

{
  const v = verify(buildZip(baseSpecs(adobeDef("Bare", []))).buf,
                   { expectedControllers: [] });
  assert(Array.isArray(v.controllersInFile) && v.controllersInFile.length === 0 &&
         v.errors.length === 0,
    "empty roster both sides: controllersInFile is [] and parity holds");
}

{
  const v = verify(buildZip(baseSpecs(JSON.stringify({ nothing: 1 }))).buf);
  assert(v.errors.length === 2 && JSON.stringify(v.missing) === '["Title","Color","Color"]' &&
         has(v.errors, /"Title" expected 1 time, measured 0/) &&
         has(v.errors, /"Color" expected 2 times, measured 0/),
    "definition with no roster: every expected controller reported missing " +
    "(one sentence per name, the multiset count in it)");
  assert(has(v.warnings, /no controller array located.*keys tried: clientControls\/controls\/controllers/),
    "definition with no roster: warning names the keys tried");
}

// ====================================================== container forms
{
  const z = buildZip(baseSpecs(adobeDef("C", ROSTER)),
    { comment: "trailing archive comment 0123456789" });
  const v = verify(z.buf);
  assert(v.zipValid && v.errors.length === 0 && v.entryCount === 3,
    "EOCD followed by an archive comment: PASS");
  assert(has(v.warnings, /35-byte trailing comment/),
    "EOCD comment length reported (35 bytes)");
}

{
  // A comment that itself contains the EOCD signature: the scan must
  // settle on the record whose comment length reaches end-of-file.
  const trap = Buffer.concat([Buffer.from("x"), le32(0x06054b50),
    Buffer.alloc(18, 0), Buffer.from("tail")]);
  const z = buildZip(baseSpecs(adobeDef("C", ROSTER)),
    { comment: trap.toString("latin1") });
  const v = verify(z.buf);
  assert(v.zipValid && v.entryCount === 3,
    "EOCD signature planted inside the comment: real EOCD still found");
}

{
  const specs = baseSpecs(adobeDef("S", ROSTER)).map(function (s) {
    return Object.assign({}, s, { method: 0 });
  });
  const v = verify(buildZip(specs).buf);
  assert(v.zipValid && v.errors.length === 0 &&
         v.entries.every(function (e) { return e.method === 0 && e.crcOk; }),
    "all entries stored (method 0): PASS with CRCs verified");
}

{
  const specs = baseSpecs(adobeDef("D", ROSTER)).map(function (s) {
    return Object.assign({}, s, { descriptor: true });
  });
  const v = verify(buildZip(specs).buf);
  assert(v.zipValid && v.errors.length === 0 &&
         v.entries.every(function (e) { return e.dataDescriptor && e.crcOk; }),
    "bit-3 data descriptors (zero local CRC/sizes): PASS via central directory");
}

{
  const specs = baseSpecs(adobeDef("U", ROSTER));
  specs[2] = { name: "média/ünïcode-中.png", data: MEDIA, method: 8, utf8: true };
  const v = verify(buildZip(specs).buf);
  assert(v.zipValid && v.errors.length === 0,
    "UTF-8 name flag (bit 11): PASS");
  assert(v.entries[2].name === "média/ünïcode-中.png" && v.entries[2].utf8,
    "UTF-8 flagged name decoded as UTF-8");
}

{
  const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]),
                             Buffer.from(adobeDef("BOM", ROSTER))]);
  const v = verify(buildZip(baseSpecs(bom)).buf);
  assert(v.zipValid && v.definitionFound && v.errors.length === 0,
    "definition.json with a UTF-8 BOM: parses");
  assert(has(v.warnings, /byte-order mark/), "BOM reported as a warning");
}

{
  // The four forms at once — this is the fixture handed to Python's
  // zipfile for the one-time independent agreement noted at the top.
  const specs = [
    { name: "definition.json",
      data: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]),
                           Buffer.from(adobeDef("All", ROSTER))]),
      method: 8, descriptor: true },
    { name: "project.aep", data: PROJECT, method: 0, descriptor: true },
    { name: "média/ünïcode.png", data: MEDIA, method: 8, utf8: true }
  ];
  const z = buildZip(specs, { comment: "all forms" });
  const v = verify(z.buf, { templateName: "All" });
  assert(v.zipValid && v.errors.length === 0 && v.templateNameMatches,
    "all forms together (comment + stored + descriptors + UTF-8 + BOM): PASS");
  if (process.env.AELL_MOGRT_FIXTURE_OUT) {
    fs.writeFileSync(process.env.AELL_MOGRT_FIXTURE_OUT, z.buf);
    console.log("     all-forms fixture written to " +
                process.env.AELL_MOGRT_FIXTURE_OUT);
  }
}

// ===================================================== planted defects
{
  const z = buildZip(baseSpecs(adobeDef("T", ROSTER)));
  const v = verify(z.buf.slice(0, z.buf.length - 40));
  assert(!v.zipValid && has(v.errors, /no end-of-central-directory record/),
    "truncated file (EOCD cut): FAIL, grounded");
}

{
  // Directory intact, body missing: compressedSize in both headers points
  // past the end of the file.
  const z = buildZip(baseSpecs(adobeDef("T2", ROSTER)));
  const b = Buffer.from(z.buf);
  b.writeUInt32LE(0x7FFFFFF0, z.layout[2].central + CENTRAL_CSIZE);
  b.writeUInt32LE(0x7FFFFFF0, z.layout[2].local + 18);
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /"media\/still.png": data spans \d+-\d+ but the file is \d+ bytes \(truncated by \d+\)/),
    "entry data declared past end-of-file: FAIL names the entry and the shortfall");
}

{
  const z = buildZip(baseSpecs(adobeDef("F", ROSTER)));
  const b = flip(z.buf, z.layout[1].data + 10); // stored project body
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /"project.aep": CRC32 of the data is 0x[0-9a-f]+, central directory declares 0x[0-9a-f]+/),
    "one body byte flipped (stored entry): CRC FAIL with both values");
  assert(v.entries[1].crcOk === false && v.entries[0].crcOk === true,
    "CRC verdict is per entry");
}

{
  const z = buildZip(baseSpecs(adobeDef("F2", ROSTER)));
  let b = flip(z.buf, z.layout[0].central + CENTRAL_CRC);
  b = flip(b, z.layout[0].local + LOCAL_CRC);
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /"definition.json": CRC32 of the data/),
    "stamped CRC flipped in both headers: FAIL");
  assert(!v.definitionFound, "a CRC-failed definition.json is not parsed");
}

{
  const z = buildZip(baseSpecs(adobeDef("F3", ROSTER)));
  const b = flip(z.buf, z.layout[0].central + CENTRAL_CRC);
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /local header CRC 0x[0-9a-f]+ differs from central directory CRC/),
    "central CRC alone flipped: local/central cross-check FAIL");
}

{
  const z = buildZip(baseSpecs(adobeDef("F4", ROSTER)));
  const b = flip(z.buf, z.layout[0].data + 3); // deflate body byte
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /"definition.json": (deflate stream does not inflate|CRC32 of the data|inflated to)/),
    "deflate body byte flipped: FAIL (inflate error or CRC), never a parse");
}

{
  const z = buildZip(baseSpecs(adobeDef("E", ROSTER)));
  const b = Buffer.from(z.buf);
  b.writeUInt32LE(0, z.eocd); // wipe the EOCD signature
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /no end-of-central-directory record: signature 0x6054b50/),
    "missing EOCD: FAIL names the signature searched for");
}

{
  const v = verify(Buffer.from("PK"));
  assert(!v.zipValid && has(v.errors, /file is 2 bytes; a zip needs at least 22/),
    "2-byte file: FAIL, grounded");
}

{
  const specs = baseSpecs(adobeDef("M", ROSTER));
  specs[2].methodField = 12;
  const v = verify(buildZip(specs).buf);
  assert(!v.zipValid && has(v.errors, /"media\/still.png": compression method 12 is not readable/),
    "unknown method 12: FAIL naming the method and the entry");
  const vd = verify(buildZip(specs).buf, { definitionOnly: true });
  assert(!vd.zipValid && has(vd.errors, /compression method 12/),
    "unknown method 12 in definitionOnly mode: still FAIL, never a skip");
  assert(vd.definitionFound, "definitionOnly still parsed the definition beside it");
}

{
  const z = buildZip(baseSpecs(adobeDef("L", ROSTER)));
  const b = Buffer.from(z.buf);
  b.writeUInt16LE(0, z.layout[0].local + LOCAL_METHOD); // central still says 8
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /local header method 0 differs from central directory method 8/),
    "local/central method disagreement: FAIL");
}

{
  const specs = baseSpecs(adobeDef("X", ROSTER));
  specs[1].encrypted = true;
  const v = verify(buildZip(specs).buf);
  assert(!v.zipValid && has(v.errors, /"project.aep": encrypted/),
    "encrypted entry: FAIL");
}

{
  const specs = baseSpecs(adobeDef("N", ROSTER)).slice(1);
  const v = verify(buildZip(specs).buf);
  assert(!v.zipValid && has(v.errors, /no definition.json among the 2 entries: project.aep, media\/still.png/),
    "no definition.json: FAIL lists the entries that exist");
}

{
  const v = verify(buildZip(baseSpecs("{not json")).buf);
  assert(!v.zipValid && has(v.errors, /definition.json does not parse as JSON/),
    "unparseable definition.json: FAIL");
}

// ====================================================== roster defects
{
  const v = verify(buildZip(baseSpecs(adobeDef("R", [["Title", 4], ["Color", 5]]))).buf);
  assert(v.zipValid, "dropped controller: the container itself is still valid");
  assert(JSON.stringify(v.missing) === '["Color"]' && v.extra.length === 0,
    "duplicate collapsed (Color x2 -> x1): multiset reports one missing");
  assert(has(v.errors, /"Color" expected 2 times, measured 1 in definition.json of <synthetic>.mogrt/),
    "collapsed duplicate: grounded sentence with expected, measured, path");
}

{
  const v = verify(buildZip(baseSpecs(adobeDef("R2", [["Color", 5], ["Color", 5]]))).buf);
  assert(JSON.stringify(v.missing) === '["Title"]' &&
         has(v.errors, /"Title" expected 1 time, measured 0/),
    "dropped controller: FAIL names it");
}

{
  const v = verify(buildZip(baseSpecs(adobeDef("R3", [["Headline", 4], ["Color", 5], ["Color", 5]]))).buf);
  assert(JSON.stringify(v.missing) === '["Title"]' &&
         JSON.stringify(v.extra) === '["Headline"]',
    "renamed controller: missing the old name, extra the new");
  assert(has(v.errors, /"Headline" measured 1 time, expected 0/),
    "renamed controller: extra reported as a grounded sentence");
}

{
  const v = verify(buildZip(baseSpecs(adobeDef("R4", ROSTER.concat([["Color", 5]])))).buf);
  assert(JSON.stringify(v.extra) === '["Color"]' && v.duplicateCounts.Color === 3,
    "one controller too many: extra reported, duplicateCounts measured 3");
}

{
  const v = verify(buildZip(baseSpecs(adobeDef("Other Name", ROSTER))).buf,
                   { templateName: "Brand Card" });
  assert(v.errors.length === 0 && v.templateNameMatches === false &&
         has(v.warnings, /template name expected "Brand Card", measured "Other Name"/),
    "template name mismatch: warning with both strings, roster still the verdict");
}

// ================================================== definitionOnly mode
{
  // The media entry claims deflate but carries bytes that are not a
  // deflate stream: inflating it THROWS. definitionOnly must never reach
  // it. The call count on zlib.inflateRawSync is the proof.
  const garbage = Buffer.alloc(500);
  for (let i = 0; i < garbage.length; i++) garbage[i] = 0xFF;
  const specs = baseSpecs(adobeDef("P", ROSTER));
  specs[2] = { name: "media/huge.mp4", data: MEDIA, method: 8, body: garbage };
  const z = buildZip(specs);

  const full = verify(z.buf);
  assert(!full.zipValid && has(full.errors, /"media\/huge.mp4": (deflate stream does not inflate|inflated to|CRC32)/),
    "full mode: the garbage deflate body FAILS loudly");

  const realInflate = zlib.inflateRawSync;
  const inflated = [];
  zlib.inflateRawSync = function (buf, o) {
    inflated.push(buf.length);
    return realInflate.call(zlib, buf, o);
  };
  let d;
  try {
    d = verify(z.buf, { definitionOnly: true });
  } finally {
    zlib.inflateRawSync = realInflate;
  }
  assert(d.zipValid && d.errors.length === 0 && d.definitionFound,
    "definitionOnly: PASS, definition parsed, garbage entry untouched");
  assert(inflated.length === 1,
    "definitionOnly: exactly one inflate call (measured " + inflated.length + ")");
  assert(d.entries[2].crcOk === null && d.entries[0].crcOk === true &&
         d.entries[1].crcOk === null,
    "definitionOnly: other entries carry crcOk null, not a false green");
  assert(JSON.stringify(d.controllersInFile) === JSON.stringify(EXPECTED),
    "definitionOnly: roster parity still computed");
}

{
  const big = adobeDef("Big", ROSTER) + " ".repeat(6000);
  const z = buildZip(baseSpecs(big));
  const v = verify(z.buf, { definitionOnly: true, maxInflate: 1000 });
  assert(has(v.warnings, /"definition.json": uncompressed size \d+ exceeds the inflate cap 1000; not inflated/),
    "maxInflate cap: grounded warning instead of inflating past it");
  assert(!v.definitionFound && v.entries[0].crcOk === null,
    "maxInflate cap: definition not parsed, CRC left unverified (null)");
  const ok = verify(z.buf, { definitionOnly: true, maxInflate: 100000 });
  assert(ok.definitionFound && ok.errors.length === 0,
    "same file under a roomy cap: parses");
}

{
  // A header that under-declares its size: the inflate is bounded and
  // the mismatch is reported instead of trusting the header.
  const z = buildZip(baseSpecs(adobeDef("Lie", ROSTER)));
  const b = Buffer.from(z.buf);
  b.writeUInt32LE(10, z.layout[0].central + 24); // uncompressed size -> 10
  b.writeUInt32LE(10, z.layout[0].local + 22);
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /"definition.json": (inflates past the declared 10 bytes|inflated to \d+ bytes, central directory declares 10)/),
    "under-declared uncompressed size: FAIL says it inflates past the declared " +
    "size (ERR_BUFFER_TOO_LARGE), never 'does not inflate': " + v.errors.join("; "));
  assert(!has(v.errors, /does not inflate/),
    "under-declared size is not reported as a corrupt stream");
}

// ================================================ readMogrt from a path
{
  const z = buildZip(baseSpecs(adobeDef("Disk", ROSTER)));
  const p = path.join(os.tmpdir(), "aell-mogrt-read-" + process.pid + ".mogrt");
  fs.writeFileSync(p, z.buf);
  const r = MogrtRead.readMogrt(p);
  fs.unlinkSync(p);
  assert(r.ok && r.bytes === z.buf.length && r.entries.length === 3 &&
         r.definition && r.definition.capsuleVersion === 1,
    "readMogrt reads from disk: ok, byte count, parsed definition");
  assert(r.readable === true, "readMogrt on a real file: readable true");
  const gone = MogrtRead.readMogrt(p);
  assert(!gone.ok && gone.readable === false &&
         has(gone.errors, /cannot open .*aell-mogrt-read-.*ENOENT/),
    "readMogrt on a missing path: readable false, grounded error naming the path");
  const gv = MogrtRead.verifyExport({ path: p, expectedControllers: EXPECTED });
  assert(gv.readable === false && gv.zipValid === null &&
         Array.isArray(gv.controllersInFile) && gv.controllersInFile.length === 0,
    "verifyExport on a missing path: readable false, zipValid null (unjudged), " +
    "controllersInFile still an array");
  const dir = os.tmpdir();
  const dv = MogrtRead.verifyExport({ path: dir, expectedControllers: EXPECTED });
  assert(dv.readable === false && dv.zipValid === null &&
         has(dv.errors, /(cannot open|cannot read|short read|cannot stat)/),
    "verifyExport on a directory: readable false, not a zip verdict: " +
    dv.errors.join("; "));
}

// ====================================================== windowed I/O
{
  // The reader must never slurp the file: fs.readFileSync is trapped,
  // and every fs.readSync position/length is recorded. The media body is
  // 200 000 stored bytes, so the 65 557-byte tail window cannot reach it
  // and any read touching it is a read the definitionOnly pass must not
  // make.
  const bigMedia = Buffer.alloc(200000);
  for (let i = 0; i < bigMedia.length; i++) bigMedia[i] = (i * 31 + 7) & 0xFF;
  const specs = baseSpecs(adobeDef("Win", ROSTER));
  specs[2] = { name: "media/big.mov", data: bigMedia, method: 0 };
  const z = buildZip(specs);
  const p = path.join(os.tmpdir(), "aell-mogrt-window-" + process.pid + ".mogrt");
  fs.writeFileSync(p, z.buf);
  const media = z.layout[2];
  const mediaEnd = media.data + media.bodyLength;

  const realReadFile = fs.readFileSync, realReadSync = fs.readSync,
        realClose = fs.closeSync;
  let reads = [], closes = 0, slurped = 0;
  fs.readFileSync = function (f) {
    if (String(f) === p) { slurped++; throw new Error("slurp"); }
    return realReadFile.apply(fs, arguments);
  };
  fs.readSync = function (fd, buf, off, len, pos) {
    reads.push({ pos: pos, len: len });
    return realReadSync.call(fs, fd, buf, off, len, pos);
  };
  fs.closeSync = function (fd) { closes++; return realClose.call(fs, fd); };
  let d, full;
  try {
    d = MogrtRead.verifyExport({ path: p, expectedControllers: EXPECTED,
                                 definitionOnly: true });
    const defReads = reads; reads = [];
    full = MogrtRead.verifyExport({ path: p, expectedControllers: EXPECTED });
    const fullReads = reads;
    fs.readFileSync = realReadFile; fs.readSync = realReadSync; fs.closeSync = realClose;

    assert(slurped === 0, "no fs.readFileSync of the capsule in either mode");
    assert(d.zipValid && d.errors.length === 0 && d.definitionFound,
      "definitionOnly over the fd: valid, definition parsed");
    // The EOCD tail window is fixed at 22 + 65535 bytes (a comment can be
    // that long) and the media entry closes the file, so that one read
    // necessarily overlaps the media's last bytes. Every OTHER read must
    // stay out of the body.
    const isTail = function (r) { return r.pos + r.len === z.buf.length; };
    const tails = defReads.filter(isTail);
    assert(tails.length === 1 && tails[0].len === 22 + 65535,
      "definitionOnly: exactly one tail-window read of 65557 bytes");
    const touchesMedia = function (r) { return !isTail(r) && r.pos < mediaEnd && r.pos + r.len > media.data; };
    assert(!defReads.some(touchesMedia),
      "definitionOnly: no read beyond the tail window intersects the media body [" +
      media.data + "," + mediaEnd + ") — reads: " +
      defReads.map(function (r) { return r.pos + "+" + r.len; }).join(" "));
    const defBytes = defReads.reduce(function (n, r) { return n + r.len; }, 0);
    assert(defBytes < 70000 && z.buf.length > 200000,
      "definitionOnly: " + defBytes + " bytes read of a " + z.buf.length + "-byte file");
    assert(defReads.some(function (r) { return r.pos + r.len === z.buf.length; }),
      "definitionOnly: the tail window was read for the EOCD");
    assert(defReads.some(function (r) { return r.pos === z.layout[0].data; }),
      "definitionOnly: definition.json's body was read at its data offset " + z.layout[0].data);
    assert(fullReads.some(function (r) { return r.pos === media.data && r.len === media.bodyLength; }),
      "full mode: the media body is read exactly once at its offset");
    assert(full.zipValid && full.entries[2].crcOk === true,
      "full mode over the fd: media CRC verified");
    assert(closes === 2, "the fd is closed after each read (" + closes + " closes)");
  } finally {
    fs.readFileSync = realReadFile; fs.readSync = realReadSync; fs.closeSync = realClose;
    fs.unlinkSync(p);
  }
}

{
  // A read that fails mid-parse (the file shrinks under the reader) is
  // readable:false, not a zip verdict.
  const z = buildZip(baseSpecs(adobeDef("Shrink", ROSTER)));
  const p = path.join(os.tmpdir(), "aell-mogrt-shrink-" + process.pid + ".mogrt");
  fs.writeFileSync(p, z.buf);
  const realReadSync = fs.readSync;
  let n = 0;
  fs.readSync = function (fd, buf, off, len, pos) {
    n++;
    if (n === 2) { const e = new Error("EBUSY: resource busy"); e.code = "EBUSY"; throw e; }
    return realReadSync.call(fs, fd, buf, off, len, pos);
  };
  let v;
  try { v = MogrtRead.verifyExport({ path: p, expectedControllers: EXPECTED }); }
  finally { fs.readSync = realReadSync; fs.unlinkSync(p); }
  assert(v.readable === false && v.zipValid === null &&
         has(v.errors, /cannot read \d+ bytes at offset \d+ of .*EBUSY/),
    "a read error mid-parse: readable false, zipValid null, grounded: " + v.errors.join("; "));
}

// ================================================ EOCD edge cases
{
  // ZIP64 sentinels must be named before any "past the EOCD" arithmetic.
  const z = buildZip(baseSpecs(adobeDef("Z64", ROSTER)));
  const b = Buffer.from(z.buf);
  b.writeUInt16LE(0xFFFF, z.eocd + 8);
  b.writeUInt16LE(0xFFFF, z.eocd + 10);
  b.writeUInt32LE(0xFFFFFFFF, z.eocd + 12);
  b.writeUInt32LE(0xFFFFFFFF, z.eocd + 16);
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /ZIP64 sentinel values \(entries 65535, cd offset 4294967295/),
    "ZIP64 sentinels: the grounded ZIP64 sentence, checked before the offset arithmetic");
  assert(!has(v.errors, /past the EOCD/),
    "ZIP64 sentinels: no misleading 'past the EOCD' error");
}

{
  // A SELF-CONSISTENT fake EOCD planted at the start of the comment: its
  // comment length reaches end-of-file exactly, so the length rule alone
  // would accept it. Its cdOffset (0) points at a LOCAL signature, so the
  // scan must keep going to the real record.
  const inner = buildZip(baseSpecs(adobeDef("Fake", ROSTER)));
  const tailText = Buffer.from("comment text after the fake record");
  const fakeCommentLen = tailText.length;
  const fake = Buffer.concat([le32(0x06054b50), le16(0), le16(0), le16(1), le16(1),
                              le32(46), le32(0), le16(fakeCommentLen)]);
  const comment = Buffer.concat([fake, tailText]).toString("latin1");
  const z = buildZip(baseSpecs(adobeDef("Fake", ROSTER)), { comment: comment });
  assert(z.buf.length === inner.buf.length + comment.length, "fixture: comment appended verbatim");
  const v = verify(z.buf);
  assert(v.zipValid && v.entryCount === 3 && v.errors.length === 0,
    "self-consistent fake EOCD inside the comment: the real record wins");
  assert(has(v.warnings, new RegExp(comment.length + "-byte trailing comment")),
    "the real record's comment length is the one reported");
}

{
  // Real EOCD whose cdOffset points at garbage: reported with the
  // signature found there.
  const z = buildZip(baseSpecs(adobeDef("Bad", ROSTER)));
  const b = Buffer.from(z.buf);
  b.writeUInt32LE(0, z.eocd + 16); // cd offset -> 0 (a local header)
  const v = verify(b);
  assert(!v.zipValid && has(v.errors, /central directory offset 0 holds signature 0x4034b50, not 0x2014b50/),
    "cd offset pointing at a local header: FAIL names the signature found");
}

{
  // Bit 11 set in the central record only: the raw name bytes agree, so
  // this is the same entry, not a rename.
  const specs = baseSpecs(adobeDef("B11", ROSTER));
  specs[2] = { name: "média/ünïcode.png", data: MEDIA, method: 8, utf8: true };
  const z = buildZip(specs);
  const b = Buffer.from(z.buf);
  b.writeUInt16LE(0, z.layout[2].local + 6); // local flags: bit 11 cleared
  const v = verify(b);
  assert(v.zipValid && v.errors.length === 0 && v.entries[2].name === "média/ünïcode.png",
    "UTF-8 flag in the central record only: PASS, name from the central record");
  // And a REAL rename in the local header still fails.
  const b2 = Buffer.from(z.buf);
  b2.write("X", z.layout[2].local + 30, 1, "latin1");
  const v2 = verify(b2);
  assert(!v2.zipValid && has(v2.errors, /"média\/ünïcode.png": local header names it "X/),
    "a differing local name byte: FAIL");
}

// ============================================ the shipped receipt hook
// tools.js runs verifyMogrtResult on every ok export_mogrt receipt (the
// panel's Node side, definitionOnly, 4 MB cap). The receipt gains
// zipValid / controllersInFile / templateNameInFile and a grounded
// verifyNote when the file disagrees with what the host reported. The
// hook must never turn an ok export into an error: a verifier that
// fails is reported as a verifier that failed.
{
  const toolsSrc = fs.readFileSync(
    path.join(__dirname, "..", "extension", "js", "tools.js"), "utf8");
  const window = { MogrtRead: MogrtRead };
  new Function("window", toolsSrc)(window);
  const hook = window.Tools._verifyMogrtResult;
  assert(typeof hook === "function", "tools.js exposes the receipt hook");

  const p = path.join(os.tmpdir(), "aell-mogrt-hook-" + process.pid + ".mogrt");
  fs.writeFileSync(p, buildZip(baseSpecs(adobeDef("Brand Card", ROSTER))).buf);

  let d = hook({ path: p, template: "Brand Card", controllers: 3,
                 controllerNames: ["Title", "Color", "Color"] });
  assert(d.zipValid === true && d.controllersInFileCount === 3 &&
         d.templateNameInFile === "Brand Card" && d.verifyNote === undefined,
    "a matching export gets zipValid/controllersInFileCount/" +
    "templateNameInFile and no note: " +
    JSON.stringify([d.zipValid, d.controllersInFileCount,
                    d.templateNameInFile, d.verifyNote]));

  // AE threw on a name read: the host roster carries "(unreadable)".
  // Name parity would be a guaranteed false mismatch, so the hook falls
  // back to COUNT parity and says so — never "controller (unreadable)
  // expected 1 time, measured 0".
  d = hook({ path: p, template: "Brand Card", controllers: 3,
             controllerNames: ["Title", "(unreadable)", "Color"] });
  assert(d.zipValid === true && d.controllersInFileCount === 3 &&
         /unreadable/.test(String(d.verifyNote)) &&
         /COUNT only/.test(String(d.verifyNote)) &&
         !/\(unreadable\)" expected/.test(String(d.verifyNote)) &&
         !/nobody exposed/.test(String(d.verifyNote)),
    "an unreadable name degrades to count parity, no false mismatch: " +
    d.verifyNote);
  d = hook({ path: p, template: "Brand Card", controllers: 4,
             controllerNames: ["Title", "(unreadable)", "Color"] });
  assert(/COUNT only/.test(String(d.verifyNote)) &&
         /4 exposed, 3 in definition\.json/.test(String(d.verifyNote)),
    "and a real count disagreement still surfaces through it: " +
    d.verifyNote);

  // The host caps the roster (500): more controllers than names means
  // the tail was never read, so again count parity, said plainly.
  d = hook({ path: p, template: "Brand Card", controllers: 3,
             controllerNames: ["Title", "Color"] });
  assert(/capped at 2 of 3/.test(String(d.verifyNote)) &&
         !/nobody exposed/.test(String(d.verifyNote)),
    "a capped roster never accuses the file of extra controllers: " +
    d.verifyNote);

  d = hook({ path: p, template: "Brand Card", controllers: 4,
             controllerNames: ["Title", "Color", "Color", "Size"] });
  assert(d.zipValid === true && /absent from definition\.json: Size/.test(d.verifyNote),
    "a controller the host exposed but the file lacks is named in the note: " +
    d.verifyNote);

  d = hook({ path: p, template: "Brand Card", controllers: 2,
             controllerNames: ["Title", "Color"] });
  assert(/nobody exposed: Color/.test(String(d.verifyNote)),
    "a duplicate collapsed the other way (file has more) is named too: " +
    d.verifyNote);

  const cut = buildZip(baseSpecs(adobeDef("Brand Card", ROSTER))).buf;
  fs.writeFileSync(p, cut.subarray(0, cut.length - 30));
  d = hook({ path: p, template: "Brand Card", controllers: 3,
             controllerNames: ["Title", "Color", "Color"] });
  assert(d.zipValid === false && d.verifyNote && d.verifyNote.length > 20,
    "a truncated file is zipValid:false with the reader's grounded error: " +
    String(d.verifyNote).slice(0, 100));
  fs.unlinkSync(p);

  d = hook({ path: p, template: "Brand Card", controllers: 3,
             controllerNames: ["Title", "Color", "Color"], ok: true });
  assert(d.ok === true && d.zipValid === null &&
         /unjudged, not failed/.test(String(d.verifyNote)),
    "a file that vanished is UNJUDGED (zipValid null, ok untouched) — " +
    "never reported as an invalid zip: " + String(d.verifyNote).slice(0, 110));

  const bare = { MogrtRead: undefined };
  new Function("window", toolsSrc)(bare);
  const d2 = bare.Tools._verifyMogrtResult({ path: p, controllerNames: [] });
  assert(d2.zipValid === undefined && d2.verifyNote === undefined,
    "without the reader loaded the hook is a no-op, never a false verdict");
}

// ================================ the pinned real definition.json (AE 2026)
//
// tests/fixtures/ae2026-definition.json is the definition.json out of a
// template AFTER EFFECTS 2026 wrote, captured by
// scripts/mogrt-verify-probe.js and scrubbed of nothing but the temp
// staging path (which carried a Windows account name). Every other
// fixture in this file is hand-built by this file, which is exactly how
// the reader shipped unable to read a real export for a week: it and its
// tests were written to the same invented shape and agreed perfectly.
// These checks are the only ones here whose input this repo did not make.
{
  const REAL = fs.readFileSync(
    path.join(__dirname, "fixtures", "ae2026-definition.json"), "utf8");
  const def = JSON.parse(REAL);
  const REAL_ROSTER = ["Headline Size é", "Card Position",
                       "BG Opacity", "Headline Text"];

  // --- the shape itself, asserted so a future edit cannot re-invent it
  assert(Array.isArray(def.clientControls) && def.clientControls.length === 4,
    "real AE 2026: the roster is a flat clientControls array");
  const row = def.clientControls[0].uiName.strDB[0];
  assert(row.localeString === "en_US" && typeof row.str === "string",
    "real AE 2026: a strDB row is {localeString: <LOCALE>, str: <VALUE>} — " +
    "the locale is in localeString, NOT the value: " + JSON.stringify(row));
  assert(def.clientControls.every(function (c) {
    return typeof c.type === "number" && !("controlType" in c);
  }), "real AE 2026: the control type key is `type`, never `controlType`");

  assert(JSON.stringify(MogrtRead.readRoster(def).controllers
           .map(function (c) { return c.name; })) ===
         JSON.stringify(REAL_ROSTER),
    "real AE 2026: every controller name reads back, accent included " +
    "(the swapped strDB read returned \"en_US\" four times)");
  assert(MogrtRead.readRoster(def).provisional === false &&
         MogrtRead.readRoster(def).via === "clientControls",
    "real AE 2026: the roster is a flat read under a known key, not provisional");
  assert(MogrtRead.templateNameOf(def) === "Untitled",
    "real AE 2026: capsuleName is the placeholder, never the template name");
  assert(MogrtRead.compNameOf(def) === "AELL MOGRT Probe",
    "real AE 2026: the comp name IS written, at sourceInfoLocalized.en_US.name");

  // --- through the whole container, and through the shipped hook
  const z = buildZip(baseSpecs(REAL));
  const v = MogrtRead.verifyExport({
    path: "<real>.mogrt", buffer: z.buf, expectedControllers: REAL_ROSTER,
    templateName: "AELL Probe Card", compName: "AELL MOGRT Probe"
  });
  assert(v.zipValid && v.missing.length === 0 && v.extra.length === 0 &&
         v.errors.length === 0,
    "real AE 2026: roster parity holds end to end (" + v.errors.join("; ") + ")");
  assert(v.templateNameUnwritten === true && v.templateNameMatches === null &&
         v.warnings.length === 0,
    "real AE 2026: the placeholder capsuleName raises NO mismatch warning — " +
    "it fired on every correct export and could never fire on a wrong one: " +
    v.warnings.join("; "));
  assert(v.compNameInFile === "AELL MOGRT Probe" && v.compNameMatches === true,
    "real AE 2026: comp-name parity is the name check that carries information");

  const wrong = MogrtRead.verifyExport({
    path: "<real>.mogrt", buffer: z.buf, compName: "Some Other Comp"
  });
  assert(wrong.compNameMatches === false &&
         /comp name expected "Some Other Comp", measured "AELL MOGRT Probe"/
           .test(wrong.warnings.join(" ")),
    "real AE 2026: a comp-name disagreement is reported, naming both: " +
    wrong.warnings.join("; "));

  // A build that DOES write a template name and writes the wrong one is
  // still caught — the placeholder is a special case, not an amnesty.
  const named = JSON.parse(REAL);
  named.capsuleName = "Something Else";
  const nv = MogrtRead.verifyExport({
    path: "<real>.mogrt", buffer: buildZip(baseSpecs(JSON.stringify(named))).buf,
    templateName: "AELL Probe Card"
  });
  assert(nv.templateNameUnwritten === false && nv.templateNameMatches === false &&
         /template name expected "AELL Probe Card", measured "Something Else"/
           .test(nv.warnings.join(" ")),
    "a NON-placeholder template name that disagrees is still a warning: " +
    nv.warnings.join("; "));

  // The shipped receipt hook, on the real bytes, with the real receipt.
  {
    const toolsSrc = fs.readFileSync(
      path.join(__dirname, "..", "extension", "js", "tools.js"), "utf8");
    const win = { MogrtRead: MogrtRead };
    new Function("window", toolsSrc)(win);
    const p = path.join(os.tmpdir(), "aell-mogrt-real-" + process.pid + ".mogrt");
    fs.writeFileSync(p, z.buf);
    const d = win.Tools._verifyMogrtResult({
      path: p, comp: "AELL MOGRT Probe", template: "AELL Probe Card",
      controllers: 4, controllerNames: REAL_ROSTER.slice()
    });
    assert(d.zipValid === true && d.controllersInFileCount === 4 &&
           d.templateNameInFile === "Untitled" && d.verifyNote === undefined,
      "the shipped hook on real AE bytes: clean receipt, NO verifyNote — " +
      "before the pin this said all four controllers were missing and four " +
      "called \"en_US\" were extra: " + String(d.verifyNote));
    const wrongComp = win.Tools._verifyMogrtResult({
      path: p, comp: "Not The Comp", template: "AELL Probe Card",
      controllers: 4, controllerNames: REAL_ROSTER.slice()
    });
    assert(/comp name expected "Not The Comp"/.test(String(wrongComp.verifyNote)),
      "and the hook surfaces a comp-name disagreement: " + wrongComp.verifyNote);
    fs.unlinkSync(p);
  }
}

console.log("\n" + checks + " checks");
if (process.exitCode) console.log("TESTS FAILED");
else console.log("ALL TESTS PASSED");
