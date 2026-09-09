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

  assert(!/"PK[\x00-\x1f]/.test(html),
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

// ------------------------- 5. the probe has to survive its OWN last run
//
// Measured 2026-09-03 on Premiere 26.3.2, three unattended runs back to
// back:
//
//   * a scratch .prproj handed to Premiere on the command line is NOT
//     opened. app.project.name was still empty after the full 30s wait,
//     and on the way out Premiere raised "This file path does not exist
//     on disk at this location. <that path>" about a 14216-byte file
//     that WAS on disk. Nobody can answer that modal unattended, so the
//     close timed out and the instance had to be forced.
//   * the same with a scratch written by a CLEAN close: identical, so
//     the file's history is not the discriminator.
//   * the same run with the file moved aside: app.newProject created
//     the project, `history` measured for the first time, and Premiere
//     closed by itself.
//
// app.newProject will not overwrite a taken path (it returns false and
// leaves an AELL_PROBE_SCRATCH<guid> sidecar), so a probe that saves a
// scratch project for "next time" poisons its own next run: the first
// run of the night passes and every one after it fails. That is the
// exact shape an unattended loop must never inherit, and it is what
// these assertions hold shut.
{
  const runner = read(path.join(ROOT, "scripts", "run-ppro-probe.ps1"));
  // Line-based, like the Set-Content check above: a comment EXPLAINING
  // that we no longer pass a project path reads, to a regex, exactly
  // like a line passing one.
  const runnerCode = runner.split(/\r?\n/)
    .filter(function (l) { return !/^\s*#/.test(l); }).join("\n");

  const launches = runnerCode.match(/Start-Process[^\n]*\$PremierePath[^\n]*/g) || [];
  assert(launches.length > 0, "run-ppro-probe.ps1 launches Premiere");
  assert(launches.filter(function (l) { return /-ArgumentList/.test(l); }).length === 0,
         "and never hands it a project path: Premiere does not open one " +
         "given on the command line, it raises a modal nobody can answer");

  const idxFree = runnerCode.indexOf("AELL_PROBE_SCRATCH*");
  const idxLaunch = runnerCode.indexOf("Start-Process -FilePath $PremierePath");
  assert(idxFree !== -1,
         "it clears the scratch path it is about to ask for");
  assert(idxFree !== -1 && idxLaunch !== -1 && idxFree < idxLaunch,
         "and does it BEFORE the launch, so app.newProject meets a free " +
         "path instead of returning false against a taken one");

  const jsx = stripJs(read(path.join(PROBE, "jsx", "probe.jsx")));
  const flat = jsx.replace(/\s+/g, " ");
  assert(/app\.openDocument\(/.test(flat),
         "probe.jsx opens an EXISTING scratch project with openDocument, " +
         "the call newProject cannot stand in for");
  const call = /app\.openDocument\(([^)]*)\)/.exec(flat);
  assert(call && (call[1].match(/true/g) || []).length === 4,
         "and passes all four suppress-the-dialog flags, because a modal " +
         "with nobody at the keyboard is a hang, not an error");
  assert(flat.indexOf("app.openDocument(") !== -1 &&
         flat.indexOf("app.openDocument(") < flat.indexOf("app.newProject("),
         "and tries it BEFORE creating, which is the order the failure " +
         "was measured in");
  assert(/d\.openDocument = AELLP_typeOf/.test(jsx) &&
         /d\.newProject = AELLP_typeOf/.test(jsx),
         "hostFacts records whether each of the two routes exists at all");
}

// ------------------------------------ 8. the job reaches the battery
//
// Both doors used to build the battery's arguments from a hand-written
// whitelist, and there were two copies of it. The job grew `seedMedia`
// and `readyTimeoutMs`; neither whitelist grew with it; the dialog-free
// sequence route never ran on a single unattended run and never showed
// up in the step's own `tried` list, so the failure read as "that route
// does not apply here" instead of "that route was never given its
// argument". This section makes a dropped field a red test rather than
// a wasted Premiere launch.
{
  const BEGIN = "/* BATTARGS-SHARED-BEGIN";
  const END = "/* BATTARGS-SHARED-END */";
  function shared(file) {
    const src = read(file);
    const a = src.indexOf(BEGIN);
    const b = src.indexOf(END);
    return (a === -1 || b === -1) ? null : src.slice(a, b + END.length);
  }
  const doorPanel = shared(path.join(PROBE, "index.html"));
  const door3 = shared(path.join(HARNESS, "index.html"));

  assert(doorPanel && door3,
         "both doors carry the shared battArgs block");
  assert(doorPanel && door3 && doorPanel === door3,
         "and the two copies are byte-identical: a whitelist maintained " +
         "twice is a whitelist that goes stale once");

  // The PowerShell runner is the only author of a real job, so it -- not
  // this test's imagination -- says which fields have to survive.
  const ps = read(path.join(ROOT, "scripts", "run-ppro-probe.ps1"));
  const jobBlock = /\$job\s*=\s*\[ordered\]@\{([\s\S]*?)\n\}/.exec(ps);
  assert(jobBlock, "run-ppro-probe.ps1 still builds the job as one literal");
  const jobKeys = (jobBlock ? jobBlock[1].split(/\r?\n/) : [])
    .filter(function (l) { return !/^\s*#/.test(l); })
    .map(function (l) { const m = /^\s*([A-Za-z_]\w*)\s*=/.exec(l); return m && m[1]; })
    .filter(Boolean);
  assert(jobKeys.indexOf("seedMedia") !== -1 &&
         jobKeys.indexOf("readyTimeoutMs") !== -1,
         "the job it writes carries seedMedia and readyTimeoutMs -- the " +
         "two the old whitelist lost");

  if (door3) {
    // Run the real block, not a regex impression of it.
    const battArgsOf = new Function(door3 + "\nreturn AELLP_battArgs;")();
    const job = {};
    jobKeys.forEach(function (k, i) { job[k] = "v" + i; });
    const out = battArgsOf(job, "P:/progress.json", "M:/fallback.mogrt");

    const runnerOwned = ["probeJsx", "probe", "args", "createdAt", "__claimed"];
    const lost = jobKeys.filter(function (k) {
      return runnerOwned.indexOf(k) === -1 && !(k in out);
    });
    assert(lost.length === 0,
           "every job field the runner does not own reaches the battery" +
           (lost.length ? " (lost: " + lost.join(", ") + ")" : ""));
    assert(out.seedMedia === job.seedMedia &&
           out.readyTimeoutMs === job.readyTimeoutMs,
           "including seedMedia and readyTimeoutMs, by value");
    assert(!("probeJsx" in out) && !("args" in out),
           "and the runner's own fields stay with the runner");
    assert(out.progressPath === "P:/progress.json",
           "progressPath comes from the door, which is the only one that " +
           "knows where the breadcrumb goes");
    assert(battArgsOf({}, null, "M:/fallback.mogrt").mogrtPath ===
             "M:/fallback.mogrt" &&
           battArgsOf({ mogrtPath: "J:/from-job.mogrt" }, null,
                      "M:/fallback.mogrt").mogrtPath === "J:/from-job.mogrt",
           "the panel's found .mogrt is a FALLBACK, never an override");

    // A future field must not need either door edited, which is the
    // whole point of dropping the whitelist.
    assert(battArgsOf({ somethingNew: 7 }, null, null).somethingNew === 7,
           "a field neither door has heard of is forwarded anyway");
  }

  [[PROBE, "the visible panel"], [HARNESS, "the door-3 runner"]]
    .forEach(function (pair) {
      const code = stripJs(read(path.join(pair[0], "index.html")));
      assert(/battArgs\s*=\s*(job\.args\s*\|\|\s*)?AELLP_battArgs\(/.test(code),
             pair[1] + " builds battArgs with the shared function");
      assert(!/battArgs\s*=\s*(job\.args\s*\|\|\s*)?\{/.test(code),
             "and not from an object literal listing the fields it " +
             "remembered (" + pair[1] + ")");
    });
}

// --------------- 9. the clip just added is found by DIFF, not by index
//
// FIELD FAILURE 2026-09-03 (Premiere 26.3.2, run -0413): `importMGT`
// landed -- track 0 grew 1 -> 2 -- and the probe then read the clip back
// as `clips[after - 1]` and got `icon-normal.png`, the seed still the
// sequence had been built from. `getMGTComponent` on that clip answers
// null, and null there reads exactly like "this build cannot read a
// MOGRT's controllers back": a conclusion about Premiere drawn from
// asking the wrong clip. The graphic lands at its insertion TIME, so the
// new clip can be anywhere in the collection and the LAST index is not
// "the one just added".
//
// This drives the REAL diff out of probe.jsx against a track built here.
{
  const psrc = read(path.join(PROBE, "jsx", "probe.jsx"));

  // The caller may not quietly go back to indexing. This runs FIRST so
  // it still reports on a tree where the helpers are gone altogether --
  // "went back to indexing" is the regression, and it must not be
  // swallowed by the drive-out below failing to evaluate.
  const mogrt = /AELLP_PROBES\.mogrtAccept = function[\s\S]*?\n\};/.exec(psrc);
  assert(!!mogrt, "probe.jsx still defines mogrtAccept as one function");
  const mbody = stripJs(mogrt ? mogrt[0] : "");
  assert(!/clips\s*\[\s*after\s*-\s*1\s*\]/.test(mbody),
         "mogrtAccept does not read the landed clip as clips[after - 1]");
  assert(/AELLP_newClip\s*\(/.test(mbody),
         "it identifies the clip with AELLP_newClip");
  assert(/pickedBy/.test(mbody),
         "and the receipt records HOW the clip was picked -- a fact " +
         "measured off a fallback pick is weaker evidence than one off " +
         "a clean diff, and the reader has to be able to tell");

  const grab = function (name) {
    const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n\\}");
    const m = re.exec(psrc);
    assert(!!m, "probe.jsx defines " + name);
    return m ? m[0] : "";
  };
  const bundle = [grab("AELLP_say"), grab("AELLP_safe"),
                  grab("AELLP_clipSnap"), grab("AELLP_clipId"),
                  grab("AELLP_newClip")].join("\n");
  let api = null;
  try {
    api = new Function(bundle +
      "\nreturn { snap: AELLP_clipSnap, id: AELLP_clipId, diff: AELLP_newClip };")();
  } catch (e) {
    assert(false, "the clip-diff helpers evaluate on their own: " + e.message);
  }

  // A track whose clips answer the way Premiere's TrackItems do:
  // `.name`, `.start.ticks`, and `.nodeId` where the build has one.
  function seqOf(clips) {
    const coll = { numItems: clips.length };
    clips.forEach(function (c, i) {
      coll[i] = {
        get name() {
          if (c.name === undefined) { throw new Error("no name"); }
          return c.name;
        },
        get start() {
          if (c.ticks === undefined) { throw new Error("no start"); }
          return { ticks: c.ticks };
        },
        get nodeId() {
          if (c.node === "throws") { throw new Error("no nodeId"); }
          return c.node;
        }
      };
    });
    return { videoTracks: [{ clips: coll }] };
  }
  function newOf(before, after) {
    if (!api) { return { how: "helpers-missing", clip: null, added: [] }; }
    return api.diff(api.snap(seqOf(before), 0), api.snap(seqOf(after), 0));
  }

  // (a) the exact shape that failed in the field: the graphic went in at
  //     time 0 and the seed slid to the END of the collection.
  {
    const seed = { name: "icon-normal.png", ticks: "0", node: "n-seed" };
    const seedMoved = { name: "icon-normal.png", ticks: "8467200000",
                        node: "n-seed" };
    const gfx = { name: "AELL MOGRT Probe", ticks: "0", node: "n-gfx" };
    const got = newOf([seed], [gfx, seedMoved]);
    assert(got.how === "diff" && got.clip && got.clip.index === 0,
           "the new clip is the one the BEFORE picture cannot account " +
           "for, even when it is not last (got index " +
           String(got.clip && got.clip.index) + ")");
    assert(got.clip && got.clip.name === "AELL MOGRT Probe",
           "and it is the graphic, not the seed that clips[after - 1] " +
           "handed back in run -0413");
  }

  // (b) identity survives a build with no readable nodeId: name + start
  //     ticks is the fallback, and it is a MULTISET compare, so a clip
  //     that merely SHARES a name with an existing one is not new.
  {
    const got = newOf(
      [{ name: "A.png", ticks: "0" }, { name: "A.png", ticks: "200" }],
      [{ name: "A.png", ticks: "0" }, { name: "A.png", ticks: "100" },
       { name: "A.png", ticks: "200" }]);
    assert(got.how === "diff" && got.clip && got.clip.index === 1,
           "with no nodeId, name+start finds the inserted clip among " +
           "same-named neighbours");
    const thrown = newOf(
      [{ name: "A.png", ticks: "0", node: "throws" }],
      [{ name: "A.png", ticks: "0", node: "throws" },
       { name: "G", ticks: "50", node: "throws" }]);
    assert(thrown.how === "diff" && thrown.clip && thrown.clip.name === "G",
           "a nodeId read that THROWS falls back too -- AELLP_safe's " +
           "\"throws: ...\" string is not an identity");
  }

  // (c) the honest refusal. If two clips are unaccounted for, or none
  //     is, there is no measurement -- and the probe has to SAY that
  //     rather than fall back to an index, because an index guess is
  //     what produced the wrong answer in the first place.
  {
    const ambiguous = newOf(
      [{ name: "A", ticks: "0" }],
      [{ name: "A", ticks: "0" }, { name: "G1", ticks: "10" },
       { name: "G2", ticks: "20" }]);
    assert(/^ambiguous/.test(ambiguous.how) && ambiguous.clip === null,
           "two unaccounted-for clips is 'ambiguous', not a guess");
    const none = newOf(
      [{ name: "A", ticks: "0" }, { name: "B", ticks: "10" }],
      [{ name: "A", ticks: "0" }, { name: "B", ticks: "10" }]);
    assert(none.how === "no-new-clip" && none.clip === null,
           "and a track whose clips are all accounted for yields no clip");
    const blind = newOf(
      [{ ticks: "0", node: "throws" }],
      [{ ticks: "0", node: "throws" }, { ticks: "10", node: "throws" }]);
    assert(blind.clip === null,
           "a build where NOTHING identifies a clip refuses too, rather " +
           "than calling every clip new");
  }

}

// ------- 10. the grader reads BOTH artifacts, newest row wins, and says
//             which file every row came from
//
// The defect: `ppro-probe-report.js` built every row from
// runtime-<HOST>.json, which only the VISIBLE panel writes when a human
// clicks its buttons. job-result.json -- where an unattended
// run-ppro-probe.ps1 puts the WHOLE battery -- was read into
// `collected.jobResult` and then never used by a single row. So after
// the first all-green unattended run the report still printed
// `FAIL MOGRT ... clip count did not grow (1 -> 1)` off a click from
// the previous day, and `G0: NOT MEASURED`. A report confidently about
// a different artifact is the same failure class as the last-index
// guess §9 above just removed.
{
  const rep = require("../scripts/ppro-probe-report.js");

  // A minimal unattended result, shaped exactly like the real one.
  function jobResult(over) {
    const j = {
      door: 3,
      startedAt: "2026-09-03T09:09:41.632Z",
      finishedAt: "2026-09-03T09:10:20.961Z",
      host: { appName: "PPRO", appVersion: "26.3.2", appLocale: "en_US" },
      via: "invisible runner (door 3)",
      ok: true,
      parsed: { ok: true },
      battery: { steps: [
        { step: "ping", ok: true, data: { pong: true, engineName: "NewWorld",
            fileName: "/x/probe/jsx/probe.jsx" } },
        { step: "hostFacts", ok: true, data: { engineName: "NewWorld",
            btAppName: "premierepro", beginUndoGroup: "undefined",
            executeCommand: "undefined", enableQE: "function" } },
        { step: "qe", ok: true, data: { qeProject: "object", effectCount: 236 } },
        { step: "project", ok: true, data: { via: "created",
            name: "AELL_PROBE_SCRATCH.prproj" } },
        { step: "sequence", ok: true, data: { via: "created",
            active: "AELL PROBE SEQ", videoTracks: 3 } },
        { step: "history", ok: true, data: { mutated: true,
            instruction: "count the entries" } },
        { step: "mogrt", ok: true, data: { before: 1, after: 2, landed: true,
            pickedBy: "diff", controllerCount: 4, namesReadable: true } },
        { step: "cleanup", ok: true, data: { removed: ["AELL PROBE SEQ"] } }
      ] }
    };
    if (over) { Object.keys(over).forEach(function (k) { j[k] = over[k]; }); }
    return j;
  }

  // The panel file the field failure was graded from: OLDER, and its
  // MOGRT attempt failed.
  function panelFile(takenAt) {
    return {
      takenAt: takenAt || "2026-09-02T20:51:46.828Z",
      panel: { cepPresent: true, appName: "PPRO", appVersion: "26.3.2",
               appdata: "C:\\Users\\mr\\AppData\\Roaming",
               cepApiVersion: { major: "12" },
               node: { fs: true, http: true, child_process: true } },
      storage: { note: "no other host's key visible" },
      mogrtAccept: { before: 1, after: 1, landed: false,
                     error: "clip count did not grow (1 -> 1)" }
    };
  }

  function rowOf(graded, claimStart) {
    return graded.rows.filter(function (r) {
      return r.claim.indexOf(claimStart) === 0;
    })[0];
  }

  // (a) the adapter: an unattended battery reads as a runtime result.
  {
    const asRuntime = rep.fromJobResult(jobResult());
    assert(asRuntime && asRuntime.host === "PPRO",
           "fromJobResult attributes the battery to the host it names");
    assert(asRuntime.takenAt === "2026-09-03T09:10:20.961Z",
           "and is dated by when the battery FINISHED, so it can be " +
           "compared with the panel file's takenAt");
    assert(asRuntime.hostFacts.btAppName === "premierepro" &&
           asRuntime.qe.qeProject === "object" &&
           asRuntime.mogrtAccept.landed === true,
           "the battery's steps land under the keys the grader reads");
    assert(asRuntime.evalScript.ok === true && asRuntime.probeLoad,
           "a parsed envelope plus an answering ping IS an evalScript " +
           "round-trip and IS proof probe.jsx loaded -- the runner has no " +
           "separate row for either");
    assert(asRuntime.panel.node === undefined &&
           asRuntime.panel.appdata === undefined,
           "what the runner never measures stays ABSENT rather than " +
           "guessed: Node modules and APPDATA are panel-side rows");
    assert(rep.fromJobResult({ battery: { steps: [] } }) === null,
           "a job result that does not name a host is not attributed to one");
    assert(rep.fromJobResult(null) === null &&
           rep.fromJobResult({ __unreadable: "bad json" }) === null,
           "no job result, or an unreadable one, is not a source");
  }

  // (b) newest wins per ROW, and the older artifact still fills the gaps.
  {
    const collected = { dir: "d", hosts: { PPRO: panelFile() },
                        jobResult: jobResult() };
    const g = rep.gradeHost("PPRO", rep.sourcesFor("PPRO", collected));
    const mogrt = rowOf(g, "MOGRT");
    assert(mogrt.state === "MEASURED" && /^landed/.test(String(mogrt.value)),
           "the MOGRT row comes from the NEWER battery, not from " +
           "yesterday's failed click -- the field defect verbatim");
    assert(mogrt.from === "job-result.json" && mogrt.stale === false,
           "and the row says which artifact it came from");
    const node = rowOf(g, "Node: child_process");
    assert(node.state === "MEASURED" && node.from === "runtime-PPRO.json" &&
           node.stale === true,
           "a fact only the older panel file has is still MEASURED -- but " +
           "flagged as coming from the older artifact, because 'measured " +
           "yesterday' and 'measured in the run you just watched' are " +
           "different claims");
    const soak = rowOf(g, "engine soak");
    assert(soak.state === "MISSING" && soak.from === null,
           "a row NEITHER artifact measures is MISSING with no source");
    assert(rowOf(g, "battery: every step passed").value.indexOf("8/8") === 0,
           "the battery's own steps are graded too");
    assert(rowOf(g, "a sequence to work in").value ===
           "created AELL PROBE SEQ, 3 video tracks",
           "including the ones with no panel equivalent at all");
  }

  // (c) the merge is by DATE, not by file: a fresh click beats an old
  //     battery just as surely as the other way round.
  {
    const stale = jobResult({ finishedAt: "2026-09-01T00:00:00.000Z" });
    const g = rep.gradeHost("PPRO", rep.sourcesFor("PPRO",
      { dir: "d", hosts: { PPRO: panelFile("2026-09-02T20:51:46.828Z") },
        jobResult: stale }));
    const mogrt = rowOf(g, "MOGRT");
    assert(mogrt.from === "runtime-PPRO.json" && mogrt.state === "FAILED",
           "with the battery OLDER, the newer panel file wins the same row " +
           "-- and its failure is reported, not hidden by the older pass");
    assert(rowOf(g, "BridgeTalk.appName").stale === true,
           "and the older battery's exclusive facts are marked stale");
  }

  // (d) a battery from a DIFFERENT host is never merged into this one.
  {
    const aeJob = jobResult({ host: { appName: "AEFT", appVersion: "26.3" } });
    const g = rep.gradeHost("PPRO", rep.sourcesFor("PPRO",
      { dir: "d", hosts: { PPRO: panelFile() }, jobResult: aeJob }));
    assert(rowOf(g, "MOGRT").from === "runtime-PPRO.json",
           "an AEFT job result does not answer a PPRO row");
    assert(!rowOf(g, "battery: every step passed"),
           "and contributes no battery rows to PPRO");
  }

  // (e) a failed battery step is a measured FAIL, never a quiet pass.
  {
    const broken = jobResult();
    broken.battery.steps[4] = { step: "sequence", ok: false,
                                data: { error: "Illegal Parameter type" } };
    const g = rep.gradeHost("PPRO", rep.sourcesFor("PPRO",
      { dir: "d", hosts: {}, jobResult: broken }));
    assert(rowOf(g, "battery: every step passed").state === "FAILED",
           "one failed step fails the battery row");
    assert(rowOf(g, "a sequence to work in").state === "FAILED",
           "and the step's own row carries its error");
  }

  // (f) G0 reads both artifacts, and an ABSENT reading is UNMEASURED --
  //     never a measured FAIL. The old gate printed
  //     "FAIL evalScript ... envelope parsed" when there was no
  //     evalScript result at all: wrong in both halves of one line.
  {
    const g0 = rep.gradeG0({ dir: "d", hosts: { PPRO: panelFile() },
                             jobResult: jobResult() });
    const es = g0.checks.filter(function (c) {
      return c.name.indexOf("evalScript") === 0; })[0];
    assert(es.pass === true && es.from === "job-result.json",
           "G0's evalScript row is answered by the unattended battery");
    const node = g0.checks.filter(function (c) {
      return c.name.indexOf("CEP Node") === 0; })[0];
    assert(node.pass === true && node.from === "runtime-PPRO.json",
           "and its Node row by the panel file, in the same report");

    const bare = rep.gradeG0({ dir: "d", hosts: { PPRO: { takenAt: "x",
      panel: { cepPresent: true, appName: "PPRO" } } } });
    const bareEs = bare.checks.filter(function (c) {
      return c.name.indexOf("evalScript") === 0; })[0];
    assert(bareEs.unmeasured === true && bareEs.pass === false,
           "no evalScript result anywhere is UNMEASURED, not a measured FAIL");
    assert(!/envelope parsed/.test(String(bareEs.detail)),
           "and the detail beside it does not claim an envelope parsed");
    const bareNode = bare.checks.filter(function (c) {
      return c.name.indexOf("CEP Node") === 0; })[0];
    assert(bareNode.unmeasured === true,
           "an unTAKEN Node inventory is unmeasured too");
    assert(bare.measured === false && bare.pass === false,
           "so the gate as a whole is NOT MEASURED");
  }

  // (g) the whole report still builds off a folder holding only a job
  //     result -- the exact state an unattended run leaves behind.
  {
    const r = rep.report({ dir: "d", exists: true, hosts: {},
                           jobResult: jobResult() });
    const ppro = r.hosts.filter(function (h) { return h.host === "PPRO"; })[0];
    assert(ppro.present === true,
           "a host with no panel file but a battery result is PRESENT");
    assert(ppro.sources.length === 1 && ppro.sources[0].file ===
           "job-result.json",
           "and its sources line names the one artifact that spoke");
    const aeft = r.hosts.filter(function (h) { return h.host === "AEFT"; })[0];
    assert(aeft.present === false,
           "while AEFT, which nothing measured, is still reported absent");
  }

  // (h) a panel file that will not parse is a finding, and must not
  //     swallow the battery result standing beside it.
  {
    const r = rep.report({ dir: "d", exists: true,
      hosts: { PPRO: { __unreadable: "Unexpected end of JSON input" } },
      jobResult: jobResult() });
    const ppro = r.hosts.filter(function (h) { return h.host === "PPRO"; })[0];
    assert(ppro.rows[0].state === "FAILED" &&
           /JSON/.test(String(ppro.rows[0].value)),
           "an unreadable runtime-PPRO.json is reported as a FAILED row");
    assert(rowOf(ppro, "MOGRT").from === "job-result.json",
           "and the battery beside it is still graded -- a corrupt panel " +
           "file is not a reason to lose the run nobody watched");
  }
}

// ----------- 11. the soak is DRIVEN BY THE DOOR, and a partial one is
//                 never a pass
//
// THE HOLE, filed 2026-09-03: G0 was three-of-four rows ok and NOT
// MEASURED on the fourth forever. The 500-round-trip engine soak lived
// ONLY as a click handler in the visible panel's index.html, so however
// green the unattended battery came back, no unattended run could ever
// close the gate. "Add it to the battery" is the obvious fix and it is
// the wrong one: the degradation being measured ("InternalError: Stack
// overrun" on a long-lived engine) accumulates per evalScript ENTRY, so
// 500 iterations INSIDE one evalScript would measure nothing and report
// green -- a false pass on the one row the gate was still honest about.
//
// So the loop lives on the CEP side, shared by both doors, and this
// section drives the REAL implementation out of the page.
{
  const BEGIN = "/* SOAK-SHARED-BEGIN";
  const END = "/* SOAK-SHARED-END */";
  function shared(file) {
    const src = read(file);
    const a = src.indexOf(BEGIN);
    const b = src.indexOf(END);
    return (a === -1 || b === -1) ? null : src.slice(a, b + END.length);
  }
  const panelBlock = shared(path.join(PROBE, "index.html"));
  const door3Block = shared(path.join(HARNESS, "index.html"));

  assert(panelBlock && door3Block, "both doors carry the shared soak block");
  assert(panelBlock === door3Block,
         "and the two copies are byte-identical -- the same rule the " +
         "battArgs block learned: a thing maintained twice goes stale once");

  // The soak must NOT be a step inside probe.jsx: a loop that never
  // crosses the CEP boundary cannot see the degradation, and a step
  // named "soak" in the battery would read as if it had.
  const probeJsx = read(path.join(PROBE, "jsx", "probe.jsx"));
  assert(!/step\("soak"/.test(probeJsx),
         "probe.jsx has no soak STEP -- 500 iterations inside one " +
         "evalScript would measure nothing and grade green");
  assert(/AELLP_PROBES\.echo\s*=/.test(probeJsx),
         "it carries only the echo PAYLOAD, which the door calls once " +
         "per round trip");

  const api = new Function(
    panelBlock +
    "\nreturn { soak: AELLP_soak, args: AELLP_soakArgs, " +
    "check: AELLP_soakCheck, pad: AELLP_SOAK_PAD };")();

  /** Drive the real loop synchronously with a fake clock and callback. */
  function run(opts, oneRound) {
    let clock = 0;
    let out = null;
    const pending = [];
    api.soak(
      Object.assign({ now: function () { return clock; },
                      later: function (fn) { pending.push(fn); } }, opts),
      function (round, cb) { clock += (opts.msPerRound || 1); oneRound(round, cb); },
      opts.onProgress || null,
      function (res) { out = res; });
    // The loop hands its continuation to `later`; drain it here instead
    // of waiting on a real event loop.
    let guard = 0;
    while (pending.length && guard++ < 100000) { pending.shift()(); }
    return out;
  }

  // (a) the happy path: every round answers, the verdict is the claim.
  {
    const seen = [];
    const res = run({ rounds: 500 }, function (round, cb) {
      seen.push(round);
      cb(api.check(null, { round: round, pad: api.pad }));
    });
    assert(res.rounds === 500 && res.total === 500 && res.failedAt === null,
           "500 answered round trips is 500 rounds and no failure");
    assert(seen.length === 500 && seen[0] === 1 && seen[499] === 500,
           "and the door really made 500 SEPARATE round trips, numbered " +
           "1..500 -- the whole point of not looping inside the engine");
    assert(res.verdict === "survived 500 round-trips",
           "the verdict is the sentence the gate grades");
    assert(!res.skipped, "and it claims no skip");
  }

  // (b) a degraded engine is named by its round, not by a boolean.
  {
    const res = run({ rounds: 500 }, function (round, cb) {
      cb(round === 137 ? "InternalError: Stack overrun" : null);
    });
    assert(res.failedAt === 137 && res.rounds === 136,
           "the round that died is the one reported, and the rounds that " +
           "survived are counted separately");
    assert(res.verdict === "DEGRADED at round 137" &&
           /Stack overrun/.test(res.error),
           "the verdict names the round and keeps the engine's own words");
  }

  // (c) A SHORT REPLY IS A DEGRADED ENGINE, not a passing round. This is
  //     the check that makes the payload size worth having: an engine
  //     that answers but truncates has failed, and a soak that only
  //     asked "did it throw" would call that survival.
  {
    assert(api.check(null, { pad: api.pad }) === null,
           "a full payload passes the round");
    assert(/short payload/.test(String(api.check(null, { pad: 12 }))),
           "a truncated one does not");
    assert(/no data/.test(String(api.check(null, null))),
           "and an empty reply is a failure with its own words");
    assert(api.check("evalScript itself failed", null) ===
             "evalScript itself failed",
           "an error from the door is passed through unchanged");
    const res = run({ rounds: 10 }, function (round, cb) {
      cb(api.check(null, { round: round, pad: round === 4 ? 12 : api.pad }));
    });
    assert(res.failedAt === 4 && /short payload/.test(res.error),
           "so a short reply at round 4 DEGRADES the soak there");
  }

  // (d) THE ONE THIS SECTION EXISTS FOR: a soak that ran out of wall
  //     clock is UNMEASURED, never survival. The gate's claim is "500
  //     round-trips"; 137 of them does not support it, and reporting
  //     "survived" for a truncated run would be exactly the false pass
  //     the whole grader exists to refuse.
  {
    const res = run({ rounds: 500, budgetMs: 200, msPerRound: 1 },
                    function (round, cb) { cb(null); });
    assert(res.rounds < 500 && res.failedAt === null,
           "the budget stopped it early without blaming the engine");
    assert(typeof res.skipped === "string" && /budget/.test(res.skipped) &&
           /not the claim/.test(res.skipped),
           "and it says SKIPPED with the reason, which the grader reads " +
           "as unmeasured");
    assert(/^STOPPED at round /.test(res.verdict) &&
           res.verdict.indexOf("survived") === -1,
           "the verdict never contains the word 'survived'");

    const rep11 = require("../scripts/ppro-probe-report.js");
    const gated = {
      dir: "d",
      hosts: { PPRO: {
        panel: { cepPresent: true, appName: "PPRO", appVersion: "26.3",
                 node: { child_process: true, fs: true, http: true } },
        evalScript: { ok: true, ping: { engineName: "NewWorld" } },
        soak: res
      } }
    };
    const g = rep11.gradeG0(gated);
    assert(g.measured === false && g.pass === false,
           "G0 over a budget-truncated soak is NOT MEASURED -- the run " +
           "that stopped at round " + res.rounds + " must not close the gate");
  }

  // (e) progress is reported so a hang can name its round. Without this
  //     breadcrumb the soak runs after the battery's LAST flush, and a
  //     hang would print an all-ok battery and no reason at all.
  {
    const ticks = [];
    run({ rounds: 100, progressEvery: 25,
          onProgress: function (ran, total) { ticks.push(ran + "/" + total); } },
        function (round, cb) { cb(null); });
    assert(ticks.join(" ") === "25/100 50/100 75/100 100/100",
           "the soak ticks every 25 rounds, which is what the runner " +
           "writes to job-soak-progress.json");
  }

  // (f) the door-3 runner really wires it: asked for, run after the
  //     battery, and refused rather than faked when the probe never
  //     loaded.
  {
    const h = stripJs(read(path.join(HARNESS, "index.html")));
    assert(/job\.soakRounds/.test(h),
           "the runner takes the round count from the JOB, so an " +
           "unattended run controls it");
    assert(/runSoak\(ok,/.test(h) && /soak: soak/.test(h),
           "it runs the soak with the battery's verdict in hand and puts " +
           "the result in job-result.json beside the battery");
    assert(/job-soak-progress\.json/.test(h),
           "with its own breadcrumb file, not the battery's");
    assert(/AELLP_soakArgs\(round\)/.test(h) &&
           /AELLP_soakCheck\(err, data\)/.test(h),
           "and it uses the shared payload and the shared check, so both " +
           "doors grade a round trip by one rule");

    // The refusal that keeps a load failure from reading as degradation:
    // the visible panel once logged "DEGRADED at round 1" when probe.jsx
    // had simply never been evaluated.
    assert(/if \(!batteryOk\) \{/.test(h) &&
           /nothing[\s\S]{0,40}to soak/.test(h),
           "a run whose battery never came back reports SKIPPED, never " +
           "DEGRADED -- a probe that did not load is not a broken engine");

    const p = stripJs(read(path.join(PROBE, "index.html")));
    assert(/AELLP_soak\(\{ rounds: 500 \}/.test(p),
           "and the panel's button drives the same shared loop, so the " +
           "click and the unattended run cannot drift apart");
  }

  // (g) A RUN THAT NEVER TRIED must not answer the row. The picker takes
  //     the NEWEST source that has a value, so an unattended run writing
  //     `soak: {skipped:"we did not ask"}` would displace a real
  //     measurement from the panel file with our own silence.
  {
    const rep11 = require("../scripts/ppro-probe-report.js");
    const h = stripJs(read(path.join(HARNESS, "index.html")));
    assert(/whenDone\(null\);/.test(h),
           "with soakRounds 0 the runner reports NO soak reading at all");
    assert(/soakNote = /.test(h) && /soakNote: soakNote/.test(h),
           "the reason lives in soakNote, which no row grades");

    const noSoak = rep11.fromJobResult({
      host: { appName: "PPRO" }, finishedAt: "2026-09-03T10:00:00.000Z",
      parsed: { ok: true }, ok: true,
      soak: null, soakNote: "this run did not ask for a soak",
      battery: { steps: [{ step: "ping", ok: true, data: { pong: true } }] }
    });
    assert(noSoak.soak === null,
           "so the adapter offers nothing for that row");

    const withSoak = rep11.fromJobResult({
      host: { appName: "PPRO" }, finishedAt: "2026-09-03T10:00:00.000Z",
      parsed: { ok: true }, ok: true,
      soak: { rounds: 500, total: 500, failedAt: null,
              verdict: "survived 500 round-trips" },
      battery: { steps: [{ step: "ping", ok: true, data: { pong: true } }] }
    });
    assert(withSoak.soak && withSoak.soak.failedAt === null,
           "and a soak the runner DID take reaches the grader from " +
           "job-result.json -- the whole point of the change");

    // End to end, in the shape the field produces: an OLD panel file
    // with no soak and a NEW unattended run that took one closes G0.
    const r = rep11.report({
      dir: "d", exists: true,
      hosts: { PPRO: {
        takenAt: "2026-09-02T20:51:46.828Z",
        panel: { cepPresent: true, appName: "PPRO", appVersion: "26.3.2",
                 node: { fs: true, http: true, child_process: true } }
      } },
      jobResult: {
        host: { appName: "PPRO", appVersion: "26.3.2" },
        finishedAt: "2026-09-03T10:00:00.000Z",
        parsed: { ok: true }, ok: true, via: "invisible runner (door 3)",
        soak: { rounds: 500, total: 500, failedAt: null, ms: 7100,
                verdict: "survived 500 round-trips" },
        battery: { steps: [
          { step: "ping", ok: true, data: { pong: true, engineName: "NewWorld",
              fileName: "/x/probe.jsx" } }
        ] }
      }
    });
    assert(r.g0.measured === true && r.g0.pass === true,
           "G0 PASSES on an unattended run for the first time -- the row " +
           "that was structurally unclosable is closed");
    const soakCheck = r.g0.checks.filter(function (c) {
      return /soak/.test(c.name);
    })[0];
    assert(soakCheck.from === "job-result.json",
           "and the report names the unattended artifact as its source, " +
           "not the panel click that never happened");
  }

  // (h) the PowerShell runner is the only author of a real job, so it
  //     has to ask for the soak and budget it inside its own timeout.
  {
    const ps = read(path.join(ROOT, "scripts", "run-ppro-probe.ps1"));
    assert(/soakRounds\s*=\s*\$SoakRounds/.test(ps) &&
           /soakBudgetMs\s*=\s*\(\$SoakBudgetSec \* 1000\)/.test(ps),
           "run-ppro-probe.ps1 writes soakRounds and soakBudgetMs into " +
           "the job");
    assert(/\[int\]\$SoakRounds = 500/.test(ps),
           "and asks for 500 by default, which is the claim G0 grades");
    assert(/job-soak-progress\.json/.test(ps),
           "it reads the soak's breadcrumb when there is no result, so a " +
           "hang in round 300 names itself");
    assert(/\$res\.soak\.skipped/.test(ps) && /UNMEASURED/.test(ps),
           "and a skipped soak prints UNMEASURED rather than passing");
    assert(/\$res\.soak\.failedAt\) \{[\s\S]{0,80}\$failedSteps\+\+/.test(ps),
           "a DEGRADED engine makes the whole run exit non-zero");
  }
}

// ------- 12. the two rows only a CLICK could ever answer
//
// FIELD STATE 2026-09-03: every battery step passed, the soak passed,
// G0 passed -- and the PPRO table still showed two gaps. Neither was
// about Premiere. `manifest shape installed` and `$.fileName inside the
// manifest's ScriptPath` were read by the VISIBLE panel and by nothing
// else, so an unattended run could not answer them however green it
// was, and the report printed them exactly like something Premiere had
// refused to say.
//
// Two defects, one shape: a reading nobody takes, and a reading taken
// and then thrown away. Premiere's answer for $.fileName IS the empty
// string, both doors stored it as `(fname && ...) ? fname : null`, and
// the grader skips "" the same way it skips a missing key -- so the one
// host the row exists for graded itself unmeasured while holding the
// answer.
{
  function sharedBlock(file, name) {
    const src = read(file);
    const BEGIN = "/* " + name + "-SHARED-BEGIN";
    const END = "/* " + name + "-SHARED-END */";
    const a = src.indexOf(BEGIN);
    const b = src.indexOf(END);
    return (a === -1 || b === -1) ? null : src.slice(a, b + END.length);
  }
  const panelShape = sharedBlock(path.join(PROBE, "index.html"), "SHAPE");
  const door3Shape = sharedBlock(path.join(HARNESS, "index.html"), "SHAPE");
  const panelSp = sharedBlock(path.join(PROBE, "index.html"), "SCRIPTPATH");
  const door3Sp = sharedBlock(path.join(HARNESS, "index.html"), "SCRIPTPATH");

  assert(panelShape && door3Shape && panelShape === door3Shape,
         "both doors carry the shared manifest-shape block, byte-identical");
  assert(panelSp && door3Sp && panelSp === door3Sp,
         "and the shared ScriptPath-reading block, byte-identical -- two " +
         "doors grading one row by two rules is the row changing question");

  // (a) the shape rule, driven over the REAL manifests in this repo.
  if (panelShape) {
    const shapeOf = new Function(panelShape + "\nreturn AELLP_shapeOfXml;")();
    const shapeA = shapeOf(read(path.join(PROBE, "CSXS", "manifest-shape-a.xml")));
    const shapeB = shapeOf(read(path.join(PROBE, "CSXS", "manifest-shape-b.xml")));
    assert(/^A \(/.test(shapeA.guess), "shape A grades as A");
    assert(/^B \(/.test(shapeB.guess), "shape B grades as B");
    assert(shapeOf(read(path.join(PROBE, "CSXS", "manifest.xml"))).guess ===
             shapeB.guess,
           "and the installed default grades as the same shape as the " +
           "file it is a copy of");

    // THE BUG THE OLD RULE HAD: zero HostLists is not more than one, so
    // an unreadable file came back "B (one HostList, loader)" -- a
    // measurement produced by a read that found nothing.
    const nothing = shapeOf("");
    assert(nothing.guess === null,
           "an empty read is NOT graded shape B: zero HostLists is not " +
           "one, and a read that found nothing is not a measurement");
    assert(/not a CEP manifest/.test(String(nothing.error)),
           "it says what it read instead, with the byte count");
    assert(shapeOf(null).guess === null && shapeOf(undefined).guess === null,
           "and a missing file reads the same way, not as a throw");
  }

  // (b) the ScriptPath rule: three states, and the empty one is a value.
  if (panelSp) {
    const factOf = new Function(panelSp + "\nreturn AELLP_scriptPathFact;")();

    const unset = factOf("undefined", 0, "", null);
    assert(!unset.scriptPath && /did not run here/.test(String(unset.note)),
           "a global that does not exist yields a NOTE and no reading -- " +
           "loader.jsx never ran in that engine, so this run has nothing " +
           "to say and must not displace a run that did");

    // Premiere 26.3.2, measured: $.fileName inside ScriptPath is "".
    const empty = factOf("string", "0", "", "missing X ($.fileName reported )");
    assert(!!empty.scriptPath, "an EMPTY value is still a reading");
    assert(empty.scriptPath.dollarFileName === "",
           "the raw answer is kept verbatim, empty and all");
    assert(empty.scriptPath.dollarFileNameSaid === "(the empty string)",
           "and it is ALSO said in a form the report can print: \"\" is " +
           "skipped by the grader exactly like a missing key, which is " +
           "how Premiere's own answer read as unmeasured");
    assert(empty.scriptPath.loaderSaid === "missing X ($.fileName reported )",
           "the loader's own sentence rides along");

    const named = factOf("string", "1", "7", "undefined");
    assert(named.scriptPath.dollarFileNameSaid === "7" &&
           named.scriptPath.loaderSaid === null,
           "AE's answer (\"7\") is passed through, and an absent loader " +
           "sentence is null rather than the string \"undefined\"");

    // The two ways of getting "" apart: the host counted characters and
    // the round trip delivered none.
    const lost = factOf("string", "42", "", null);
    assert(/42 characters/.test(lost.scriptPath.dollarFileNameSaid) &&
           !!lost.scriptPath.transport,
           "a value the HOST counted but evalScript did not deliver is a " +
           "transport finding, not a measurement of an empty $.fileName");
  }

  // (c) the door-3 runner takes both readings, and fabricates neither.
  {
    const code = stripJs(read(path.join(HARNESS, "index.html")));
    assert(/shape:\s*readShape\(\)/.test(code),
           "the runner puts a manifest-shape reading in its result");
    assert(/ExtensionBundleId=/.test(code) && /readdirSync/.test(code),
           "found by BUNDLE ID under the CEP roots, not by trusting a " +
           "folder name the installer happened to choose");
    assert(/scriptPath:\s*fact\.scriptPath \|\| null/.test(code) &&
           /scriptPathNote:\s*fact\.note \|\| null/.test(code),
           "and a ScriptPath reading only when there is one -- the reason " +
           "goes in a note, which no row grades");
    assert(/typeof \$\.global\.AELLP_LOADER_FILENAME/.test(code) &&
           /AELLP_LOADER_FILENAME\)\.length/.test(code),
           "it asks the type and the host-side length separately, so an " +
           "empty reply and an empty value stay different findings");
  }

  // (d) the panel takes them the same way, through the same blocks.
  {
    const code = stripJs(read(path.join(PROBE, "index.html")));
    assert(/AELLP_shapeOfXml\(/.test(code),
           "the visible panel grades its manifest with the shared rule");
    assert(!/hostLists > 1 \?[\s\S]{0,120}guess/.test(
             code.split(stripJs(panelShape || "x")).join("")),
           "and has no second copy of the rule left in it");
    assert((code.match(/readScriptPath\(function/g) || []).length === 2,
           "both of the panel's runs take the ScriptPath reading through " +
           "the shared block (the click and the unattended job)");
    assert(!/dollarFileName: \(fname && fname !== "undefined"\)/.test(code),
           "and the expression that threw Premiere's answer away is gone");
  }

  // (e) the grader: both rows close off an unattended run, and a note
  //     does not displace an older click that really measured.
  {
    const rep = require("../scripts/ppro-probe-report.js");
    function jobWith(over) {
      const j = {
        door: 3, startedAt: "2026-09-03T11:00:00.000Z",
        finishedAt: "2026-09-03T11:05:00.000Z",
        host: { appName: "PPRO", appVersion: "26.3.2" },
        via: "invisible runner (door 3)", ok: true, parsed: { ok: true },
        battery: { steps: [{ step: "ping", ok: true,
                             data: { pong: true, fileName: "/x/probe.jsx" } }] },
        shape: { extensionEntries: 1, hostLists: 1,
                 guess: "B (one HostList, loader)",
                 readFrom: "C:/x/CSXS/manifest.xml" },
        scriptPath: { dollarFileName: "", dollarFileNameChars: 0,
                      dollarFileNameSaid: "(the empty string)" }
      };
      if (over) { Object.keys(over).forEach(function (k) { j[k] = over[k]; }); }
      return j;
    }
    const older = {
      takenAt: "2026-09-02T20:51:46.828Z",
      panel: { cepPresent: true, appName: "PPRO" },
      shape: { guess: "A (per-extension HostList)" },
      scriptPath: { dollarFileName: "8" }
    };
    function rowOf(graded, start) {
      return graded.rows.filter(function (r) {
        return r.claim.indexOf(start) === 0;
      })[0];
    }
    const asRuntime = rep.fromJobResult(jobWith());
    assert(!!asRuntime.shape &&
           asRuntime.shape.guess === "B (one HostList, loader)",
           "the adapter carries the runner's manifest-shape reading");
    assert(!!asRuntime.scriptPath &&
           asRuntime.scriptPath.dollarFileNameSaid === "(the empty string)",
           "and its ScriptPath reading");

    const graded = rep.gradeHost("PPRO", [
      { tag: "job", file: "job-result.json", takenAt: asRuntime.takenAt,
        data: asRuntime },
      { tag: "pnl", file: "runtime-PPRO.json", takenAt: older.takenAt,
        data: older }
    ]);
    const shapeRow = rowOf(graded, "manifest shape installed");
    const spRow = rowOf(graded, "$.fileName inside");
    assert(shapeRow.state === "MEASURED" && shapeRow.from === "job-result.json",
           "an unattended run closes the manifest-shape row on its own");
    assert(spRow.state === "MEASURED" && spRow.value === "(the empty string)" &&
           spRow.from === "job-result.json",
           "and the ScriptPath row, with Premiere's empty answer PRINTED " +
           "rather than skipped -- the whole defect in one row");

    // A run that could not take the reading must fall through, not win.
    const noReading = rep.fromJobResult(jobWith({
      scriptPath: null, shape: null,
      scriptPathNote: "loader.jsx did not run in this engine" }));
    const graded2 = rep.gradeHost("PPRO", [
      { tag: "job", file: "job-result.json", takenAt: noReading.takenAt,
        data: noReading },
      { tag: "pnl", file: "runtime-PPRO.json", takenAt: older.takenAt,
        data: older }
    ]);
    assert(rowOf(graded2, "$.fileName inside").value === "8" &&
           rowOf(graded2, "$.fileName inside").from === "runtime-PPRO.json",
           "a run with nothing to say leaves the older click's answer " +
           "standing instead of overwriting it with silence");
    assert(rowOf(graded2, "manifest shape installed").from ===
             "runtime-PPRO.json",
           "same for the shape row");

    // A failed READ is not a measurement.
    const broken = rep.fromJobResult(jobWith({
      shape: { guess: null, lookedIn: ["C:/a", "C:/b"],
               error: "no bundle with ExtensionBundleId " +
                      "com.cptk.aellama.probe is installed under any CEP " +
                      "extensions root" } }));
    const graded3 = rep.gradeHost("PPRO", [
      { tag: "job", file: "job-result.json", takenAt: broken.takenAt,
        data: broken }
    ]);
    const bad = rowOf(graded3, "manifest shape installed");
    assert(bad.state === "FAILED",
           "a shape read that found nothing grades FAILED, not MEASURED: " +
           "the sentence explaining why is not a shape");
    assert(/ExtensionBundleId/.test(String(bad.value)),
           "and it names what it looked for");

    // (f) EXPLAINED: a reading no unattended run can take.
    //
    // MEASURED 2026-09-03 (run -0902): loader.jsx is the PROBE bundle's
    // ScriptPath, an unattended run opens no panel, so CEP never
    // evaluates it and the global is absent from the engine door 3
    // talks to. Door 3 does NOT grow a ScriptPath of its own to close
    // the row -- "nothing auto-loads" is what keeps the invisible
    // runner inert (section 5 above) and it outranks one table cell.
    // What changes is the REPORT: a run that said why it could not
    // answer must not print like a run that was never made.
    const clickOnly = rep.fromJobResult(jobWith({
      scriptPath: null,
      scriptPathNote: "$.global.AELLP_LOADER_FILENAME is undefined in " +
                      "this engine: the probe bundle's ScriptPath " +
                      "(jsx/loader.jsx) did not run here" }));
    const graded4 = rep.gradeHost("PPRO", [
      { tag: "job", file: "job-result.json", takenAt: clickOnly.takenAt,
        data: clickOnly }
    ]);
    const explained = rowOf(graded4, "$.fileName inside");
    assert(explained.state === "EXPLAINED",
           "with no reading anywhere, the row prints the run's own " +
           "reason instead of an empty MISSING -- an absence with a " +
           "cause is not the same report as a probe nobody ran");
    assert(/did not run here/.test(String(explained.value)) &&
           explained.from === "job-result.json",
           "and it names the artifact the reason came from");
    assert(explained.state !== "MEASURED",
           "a note is still not a measurement: it can never pass a row");
  }
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
