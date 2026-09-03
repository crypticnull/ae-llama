// Regression test: the P0 probe bundle (docs/PREMIERE_PLAN.md phase P0).
//
// Two things have to hold, and neither is visible by reading one file:
//
// 1. THE PROBE CAN NEVER SHIP. CI publishes the update feed on EVERY
//    push to main and claude/**, to a stable URL every installed panel
//    polls — so anything that lands inside extension/ is on customers'
//    machines within minutes, whether or not anyone meant it to be.
//    The probe therefore lives in probe/, has its own bundle id, and is
//    installed only by a junction. This test is what keeps it there.
//
// 2. THE PROBE MUST NOT DEPEND ON THE PANEL. Its whole job is to find
//    out whether a CEP extension reaches Premiere's ExtendScript engine
//    at all; loading hostscript.jsx (11.8k lines of AE DOM) or the
//    panel's JS first would answer a different question, and could throw
//    before the answer is taken.
//
// Plus the cheap checks that save a wasted trip to the owner's machine:
// the inline page script actually parses, both manifest shapes name the
// hosts they claim to, and the door-3 runner is invisible by
// construction.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROBE = path.join(ROOT, "probe", "com.cptk.aellama.probe");
const HARNESS = path.join(ROOT, "probe", "com.cptk.aellama.harness");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}
function read(p) { return fs.readFileSync(p, "utf8"); }

// Every content assertion below reads CODE, never prose. tests/
// test-es3-syntax.js learned this the same way: a comment explaining
// what a file deliberately does NOT do reads, to a regex, exactly like
// the file doing it. Three assertions here failed on their own
// explanations before this existed.
function stripJs(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}
function stripXml(src) {
  return src.replace(/<!--[\s\S]*?-->/g, " ");
}

// ------------------------------------------------ 1. it cannot ship
{
  assert(fs.existsSync(PROBE), "the probe bundle exists at probe/");
  assert(!fs.existsSync(path.join(ROOT, "extension", "probe")) &&
         !fs.existsSync(path.join(ROOT, "extension", "com.cptk.aellama.probe")),
         "and NOT inside extension/, which CI publishes on every push");

  const pkg = read(path.join(ROOT, "scripts", "package-zxp.ps1"));
  assert(/\$srcDir\s*=\s*Join-Path \$repoRoot 'extension'/.test(pkg),
         "package-zxp.ps1 stages extension\\ and nothing above it");
  // The property that matters is a PATH reference, not the word: a
  // comment may well say "probe" one day, but a `probe\` or `probe/` in
  // a staging script is the thing that would ship it.
  assert(!/probe[\\\/]/i.test(pkg),
         "package-zxp.ps1 references no path under probe/ — it cannot " +
         "stage what it does not know about");

  const ci = read(path.join(ROOT, ".github", "workflows", "build-zxp.yml"));
  assert(!/probe\//.test(ci),
         "the CI packaging job does not reach into probe/");

  const probeManifest = read(path.join(PROBE, "CSXS", "manifest.xml"));
  const panelManifest = read(path.join(ROOT, "extension", "CSXS",
                                       "manifest.xml"));
  const probeId = /ExtensionBundleId="([^"]+)"/.exec(probeManifest)[1];
  const panelId = /ExtensionBundleId="([^"]+)"/.exec(panelManifest)[1];
  assert(probeId !== panelId,
         "the probe's ExtensionBundleId (" + probeId + ") differs from the " +
         "panel's (" + panelId + ") — installing one can never replace the " +
         "other, and uninstalling the probe cannot take the panel with it");
}

// ------------------------------------- 2. it does not depend on the panel
{
  const jsx = read(path.join(PROBE, "jsx", "probe.jsx"));
  assert(/\$\.global\.AELLP_call\s*=/.test(jsx),
         "probe.jsx publishes $.global.AELLP_call — the one entry point");
  assert(!/hostscript\.jsx/.test(jsx) && !/AELL_call/.test(jsx),
         "and never loads or calls the AE panel's hostscript");
  assert(!/\bJSON\b\s*\./.test(jsx),
         "no JSON object: ExtendScript has none (CLAUDE.md), so the probe " +
         "carries its own serializer");
  assert(!/\b(const|let)\s/.test(jsx.replace(/\/\*[\s\S]*?\*\//g, "")
                                    .replace(/\/\/[^\n]*/g, "")),
         "no const/let in ES3 code");

  const html = read(path.join(PROBE, "index.html"));
  const srcs = (html.match(/<script[^>]+src=/g) || []);
  assert(srcs.length === 0,
         "index.html pulls in no external script at all — it shims CEP " +
         "itself, so nothing from extension/ can load first: " +
         srcs.join(" "));
  assert(!/\.\.\/\.\.\/extension/.test(stripJs(html)),
         "and no code path reaches up into extension/");

  // The mutating probes must be opt-in. A probe that reorganises the
  // owner's open project because a button was mislabelled is the one
  // failure mode that cannot be undone by re-running it.
  assert(/allowMutate !== true/.test(jsx),
         "historyProbe/mogrtAccept refuse without allowMutate:true");
  const mutators = (jsx.match(/allowMutate !== true/g) || []).length;
  assert(mutators >= 2, "both mutating probes are gated: " + mutators);
  assert(/window\.confirm/.test(html),
         "and the page confirms before calling either");
}

// -------------------------------------------- 3. the page script parses
{
  const html = read(path.join(PROBE, "index.html"));
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert(!!m, "index.html has an inline script");
  const tmp = path.join(os.tmpdir(),
                        "aell-probe-page-" + process.pid + ".js");
  fs.writeFileSync(tmp, m[1], "utf8");
  let ok = true, err = "";
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) {
    ok = false;
    err = String(e.stderr || e.message).split("\n").slice(0, 3).join(" ");
  }
  fs.unlinkSync(tmp);
  assert(ok, "the probe page's script parses (a syntax error here costs a " +
             "trip to the owner's machine): " + err);

  const hHtml = read(path.join(HARNESS, "index.html"));
  const hm = /<script>([\s\S]*?)<\/script>/.exec(hHtml);
  assert(!!hm, "the harness runner has an inline script");
  const tmp2 = path.join(os.tmpdir(),
                         "aell-harness-page-" + process.pid + ".js");
  fs.writeFileSync(tmp2, hm[1], "utf8");
  let ok2 = true, err2 = "";
  try {
    execFileSync(process.execPath, ["--check", tmp2], { stdio: "pipe" });
  } catch (e) {
    ok2 = false;
    err2 = String(e.stderr || e.message).split("\n").slice(0, 3).join(" ");
  }
  fs.unlinkSync(tmp2);
  assert(ok2, "and it parses too: " + err2);
}

// ------------------------------------------- 4. both manifest shapes
function hostsIn(xml) {
  const out = [];
  const re = /<Host\s+Name="([^"]+)"\s+Version="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) { out.push(m[1] + m[2]); }
  return out;
}

{
  const a = stripXml(read(path.join(PROBE, "CSXS", "manifest-shape-a.xml")));
  const b = stripXml(read(path.join(PROBE, "CSXS", "manifest-shape-b.xml")));

  assert((a.match(/<HostList>/g) || []).length >= 2,
         "shape A uses PER-EXTENSION HostLists (the shape the plan " +
         "recommends and the one with the least field evidence)");
  assert((a.match(/<Extension\s+Id="[^"]*"\s+Version=/g) || []).length === 2,
         "shape A declares two extensions");
  assert(/Name="AEFT"/.test(a) && /Name="PPRO"/.test(a),
         "shape A names both hosts: " + hostsIn(a).join(" "));

  assert((b.match(/<Extension\s+Id="[^"]*"\s+Version=/g) || []).length === 1,
         "shape B declares ONE extension (the shape shipped multi-host " +
         "manifests actually use)");
  assert(/Name="AEFT"/.test(b) && /Name="PPRO"/.test(b),
         "with both hosts on its single HostList: " + hostsIn(b).join(" "));
  assert(/<ScriptPath>\.\/jsx\/loader\.jsx<\/ScriptPath>/.test(b),
         "and a LOADER as ScriptPath — CEP auto-loads ScriptPath in every " +
         "host an extension lists, so shape B cannot name a host-specific " +
         "file directly");

  // CEP demands the active file be CSXS\manifest.xml, so install-probe.ps1
  // overwrites it to switch shapes. Both shapes are committed beside it.
  //
  // The DEFAULT is shape B, on the evidence that every shipped
  // multi-host CEP manifest anyone found uses one HostList.
  //
  // It is NOT the default because shape A was measured to fail. Both
  // shapes shipped with an illegal XML comment on 2026-09-02 and
  // neither was ever parsed by CEP; the "shape A does not load"
  // diagnosis drawn from that was wrong, and the shape question is
  // still open. tests/test-manifest-xml.js is what stops a repeat.
  assert(read(path.join(PROBE, "CSXS", "manifest-shape-b.xml")) ===
         read(path.join(PROBE, "CSXS", "manifest.xml")),
         "manifest.xml is byte-identical to shape B, the default that " +
         "actually loads (if this fails, a -Shape A install is still on)");
  const install = read(path.join(ROOT, "scripts", "install-probe.ps1"));
  assert(/\[string\]\$Shape = 'B'/.test(install),
         "install-probe.ps1 defaults to -Shape B");

  const idA = /ExtensionBundleId="([^"]+)"/.exec(a)[1];
  const idB = /ExtensionBundleId="([^"]+)"/.exec(b)[1];
  assert(idA === idB,
         "both shapes share one bundle id, so only one can be installed " +
         "at a time — whichever is present is the one being measured");

  // PPRO 25.0+ is CEP 12 per Adobe's host table; an upper bound that
  // stops before 27.x would make a beta probe impossible.
  const ppro = /Name="PPRO"\s+Version="\[([\d.]+),([\d.]+)\]"/.exec(a);
  assert(!!ppro, "shape A pins a PPRO version range");
  assert(parseFloat(ppro[1]) <= 25 && parseFloat(ppro[2]) >= 99,
         "open-ended enough to cover the 27.0 beta: [" + ppro[1] + "," +
         ppro[2] + "]");

  const loader = stripJs(read(path.join(PROBE, "jsx", "loader.jsx")));
  assert(!/\bapp\./.test(loader),
         "loader.jsx touches no app.* API — it runs at panel load in a " +
         "host it has not identified yet");
  assert(/BridgeTalk\.appName/.test(loader),
         "it branches on BridgeTalk.appName, which is readable before any " +
         "app call");
}

// ----------------------------------------- 5. the door-3 runner is inert
{
  const h = stripXml(read(path.join(HARNESS, "CSXS", "manifest.xml")));
  assert(/<AutoVisible>false<\/AutoVisible>/.test(h),
         "the harness extension is AutoVisible=false");
  assert(/<Type>Custom<\/Type>/.test(h),
         "Type=Custom (Adobe's invisible-extension recipe)");
  assert(!/<Menu>/.test(h),
         "and has no <Menu>, so it is never listed under Window > Extensions");
  assert(!/<ScriptPath>/.test(h),
         "no ScriptPath: nothing auto-loads into the host's ExtendScript " +
         "engine — the job file names the .jsx instead");
  assert(/ApplicationActivate/.test(h),
         "StartOn uses the event Adobe's own sample names for Premiere");

  const hHtml = read(path.join(HARNESS, "index.html"));
  assert(/renameSync/.test(hHtml),
         "the runner CLAIMS the job file (renameSync) before doing the " +
         "work — StartOn fires on every OS focus gain, so a job that is " +
         "not claimed first would run many times");
  assert(/if \(!fs\.existsSync\(jobFile\)\) \{ return; \}/.test(hHtml),
         "and does nothing at all when no job is waiting");

  const install = read(path.join(ROOT, "scripts", "install-probe.ps1"));
  assert(/\$Harness/.test(install) && /dev only/i.test(install),
         "install-probe.ps1 only installs it behind -Harness, labelled dev-only");
}

// --------------------------- 6. the grader: MISSING is never a pass
{
  const rep = require("../scripts/ppro-probe-report.js");

  assert(rep.measured("x", null).state === "MISSING",
         "a null measurement grades MISSING, not pass");
  assert(rep.measured("x", "").state === "MISSING",
         "an empty string is MISSING too");
  assert(rep.measured("x", "throws: nope").state === "FAILED",
         "a value that recorded a throw grades FAILED");
  assert(rep.measured("x", "yes").state === "MEASURED", "a real value passes");

  // The exact field failure this rule comes from: an unattended probe
  // with no results must never report a green gate.
  const empty = rep.gradeG0({ dir: "(nowhere)", hosts: {} });
  assert(empty.pass === false && empty.measured === false,
         "G0 over an empty probes folder is NOT MEASURED, never a pass");

  const good = {
    dir: "d",
    hosts: {
      PPRO: {
        panel: { cepPresent: true, appName: "PPRO", appVersion: "26.3",
                 node: { child_process: true, fs: true, http: true } },
        evalScript: { ok: true, ping: { engineName: "main" } },
        soak: { failedAt: null, verdict: "survived 500 round-trips" }
      }
    }
  };
  const g = rep.gradeG0(good);
  assert(g.measured === true && g.pass === true,
         "a complete PPRO result passes G0");

  const noSoak = JSON.parse(JSON.stringify(good));
  delete noSoak.hosts.PPRO.soak;
  const g2 = rep.gradeG0(noSoak);
  assert(g2.measured === false && g2.pass === false,
         "the same result WITHOUT the soak is not measured — the engine " +
         "degradation a third party hit on 26.2.2 is exactly what a " +
         "one-shot probe would miss");

  const badNode = JSON.parse(JSON.stringify(good));
  badNode.hosts.PPRO.panel.node.child_process = "throws: no Node";
  const g3 = rep.gradeG0(badNode);
  assert(g3.measured === true && g3.pass === false,
         "no child_process is a measured FAIL: without it there is no " +
         "llama-server, no ComfyUI, no ffmpeg");

  const deadDoors = rep.gradeDoors({ doors: [
    { door: 1, verdict: "DEAD", detail: "x" },
    { door: 2, verdict: "SKIPPED", detail: "y" }
  ] });
  assert(deadDoors.state === "DEAD",
         "one DEAD and one SKIPPED door grades DEAD (something was measured)");
  const allSkipped = rep.gradeDoors({ doors: [
    { door: 1, verdict: "SKIPPED", detail: "x" }
  ] });
  assert(allSkipped.state === "MISSING",
         "all-SKIPPED grades MISSING, never DEAD — nothing was measured, " +
         "and 'we did not try' must not read as 'it does not work'");
  assert(rep.gradeDoors(null).state === "MISSING",
         "no doors.json at all is MISSING");
  const alive = rep.gradeDoors({ doors: [
    { door: 3, verdict: "ALIVE", detail: "runner answered" }
  ] });
  assert(alive.state === "ALIVE", "an ALIVE door is reported as such");
}

// ------------------- 7. the .mogrt picker rejects damaged fixtures
//
// FIELD FAILURE 2026-09-02: the panel auto-filled the MOGRT path with
// the NEWEST .mogrt in logs\mogrt-verify\ and landed on
// truncated.mogrt - a deliberately damaged fixture that lives in that
// folder precisely because the reader tests need one. Premiere refused
// it, and without the read-back receipt that would have read as
// "Premiere rejects what AE writes": a conclusion about Adobe drawn
// from picking the wrong file.
//
// So the picker validates before it picks, and this drives the REAL
// function out of the page against capsules built here.
{
  const zlib = require("zlib");
  const crypto = require("crypto");

  const html = read(path.join(PROBE, "index.html"));
  const m = /function looksLikeCapsule\(fs, full\) \{[\s\S]*?\n  \}/.exec(html);
  assert(!!m, "the page defines looksLikeCapsule");
  const looksLikeCapsule = m ? eval("(" + m[0] + ")") : null;

  assert(!/"PK[ -]/.test(html),
         "the zip signature is compared as BYTES, not as a string literal " +
         "holding raw control characters (invisible bytes in source are " +
         "the hazard class that already bit this repo once)");

  function le16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
  function le32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) { c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1); }
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
        le32(data.length), le16(nb.length), le16(0), le16(0), le16(0),
        le16(0), le32(0), le32(off), nb]));
      off += loc.length + body.length;
    });
    const cd = Buffer.concat(cent);
    return Buffer.concat(parts.concat([cd, Buffer.concat([le32(0x06054b50),
      le16(0), le16(0), le16(entries.length), le16(entries.length),
      le32(cd.length), le32(off), le16(0)])]));
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aell-caps-"));
  // Random payloads on purpose: deflate squashes repeated characters
  // below the picker's 200-byte floor, and a fixture that trips the
  // SIZE guard never exercises the signature check it was written for.
  const good = zip([
    { name: "definition.json",
      data: JSON.stringify({ capsuleName: "Untitled", clientControls: [] }) },
    { name: "project.aegraphic", data: crypto.randomBytes(8000) }
  ]);
  const files = {
    "good.mogrt": good,
    "truncated.mogrt": good.slice(0, Math.floor(good.length * 0.6)),
    "notzip.mogrt": crypto.randomBytes(5000),
    "nodefinition.mogrt": zip([{ name: "readme.txt",
                                 data: crypto.randomBytes(3000) }]),
    "tiny.mogrt": Buffer.from("PK")
  };
  Object.keys(files).forEach(function (n) {
    fs.writeFileSync(path.join(dir, n), files[n]);
  });

  if (looksLikeCapsule) {
    const verdicts = {};
    Object.keys(files).forEach(function (n) {
      verdicts[n] = looksLikeCapsule(fs, path.join(dir, n));
    });
    assert(verdicts["good.mogrt"].ok === true,
           "a real capsule is USABLE: " + verdicts["good.mogrt"].why);
    assert(verdicts["truncated.mogrt"].ok === false &&
           /central-directory/.test(verdicts["truncated.mogrt"].why),
           "the exact file that shipped a wrong conclusion is rejected, " +
           "and the reason names the defect: " + verdicts["truncated.mogrt"].why);
    assert(verdicts["notzip.mogrt"].ok === false &&
           /not a zip/.test(verdicts["notzip.mogrt"].why),
           "a non-zip is rejected: " + verdicts["notzip.mogrt"].why);
    assert(verdicts["nodefinition.mogrt"].ok === false &&
           /definition\.json/.test(verdicts["nodefinition.mogrt"].why),
           "a valid zip that is not a capsule is rejected: " +
           verdicts["nodefinition.mogrt"].why);
    assert(verdicts["tiny.mogrt"].ok === false,
           "an empty stub is rejected: " + verdicts["tiny.mogrt"].why);

    // The three real defects must be caught by their OWN rule, not by
    // the size floor happening to fire first.
    ["truncated.mogrt", "notzip.mogrt", "nodefinition.mogrt"].forEach(
      function (n) {
        assert(!/^only \d+ bytes$/.test(verdicts[n].why),
               n + " is rejected by its real defect, not by the size " +
               "floor: " + verdicts[n].why);
      });
  }

  assert(/usable/.test(read(path.join(PROBE, "index.html"))) &&
         /candidates/.test(read(path.join(PROBE, "index.html"))),
         "the page records EVERY candidate and its verdict, so a wrong " +
         "pick is visible rather than silent");

  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------- 8. the BOM that ate two unattended runs
//
// Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a UTF-8
// BOM. Node's readFileSync(p, "utf8") returns it as a leading U+FEFF and
// JSON.parse THROWS. The probe's job file was written that way, so the
// CEP claimer renamed the job to claim it, threw inside JSON.parse, and
// returned from a silent catch. The job was consumed, nothing ran,
// nothing was written, and two 5-minute unattended runs reported only
// "it hung". PowerShell 6+ defaults to BOM-less and would have hidden
// this on a dev box forever while breaking every 5.1 user.
{
  // The failure, reproduced, so the reason this code exists is provable
  // rather than a story in a comment.
  const withBom = "﻿{\"a\":1}";
  let threw = false;
  try { JSON.parse(withBom); } catch (e) { threw = true; }
  assert(threw, "JSON.parse THROWS on a BOM-prefixed document");
  assert(JSON.parse(withBom.replace(/^﻿/, "")).a === 1,
         "and stripping the BOM makes it parse");

  const claimers = {
    "probe/index.html": read(path.join(PROBE, "index.html")),
    "harness/index.html": read(path.join(HARNESS, "index.html"))
  };
  Object.keys(claimers).forEach(function (name) {
    const src = claimers[name];
    assert(/replace\(\/\^\\uFEFF\/, ""\)/.test(src),
           name + " strips a BOM before JSON.parse");
    assert(!/﻿/.test(src),
           name + " contains no LITERAL BOM character (the escape is used, " +
           "so the guard is visible to a reviewer)");
    assert(/failedBeforeStarting/.test(src),
           name + " writes a breadcrumb when the claim fails instead of " +
           "returning silently - a silent catch after consuming the job is " +
           "what made the failure invisible");
  });

  // The write side. Every JSON file a Node/CEP reader consumes must be
  // written BOM-less, so no future script can reintroduce this.
  const scriptsDir = path.join(ROOT, "scripts");
  const psFiles = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); }
      else if (/\.ps1$/i.test(e.name)) { psFiles.push(p); }
    });
  })(scriptsDir);

  const offenders = [];
  psFiles.forEach(function (f) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (rel === "scripts/lib/json-io.ps1") { return; }   // documents it
    const src = fs.readFileSync(f, "utf8");
    src.split(/\r?\n/).forEach(function (line, i) {
      if (/^\s*#/.test(line)) { return; }                // a comment about it
      if (/Set-Content[^|]*-Encoding\s+UTF8/i.test(line)) {
        offenders.push(rel + ":" + (i + 1));
      }
    });
  });
  assert(offenders.length === 0,
         "no script writes with Set-Content -Encoding UTF8, which BOMs on " +
         "Windows PowerShell 5.1" +
         (offenders.length ? " (" + offenders.join(", ") + ")" : ""));

  const jsonIo = path.join(ROOT, "scripts", "lib", "json-io.ps1");
  assert(fs.existsSync(jsonIo), "scripts/lib/json-io.ps1 exists");
  const io = read(jsonIo);
  assert(/UTF8Encoding\(\$false\)/.test(io),
         "and writes with UTF8Encoding($false), i.e. no BOM");
  assert(/65279/.test(io),
         "and strips a BOM on read too - a format that only works when " +
         "both ends agree has two chances to break");
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
