// Regression test: the whisper.cpp verification round-trip -- speak a
// phrase with the OS synthesizer, transcribe it, assert the phrase came
// back. WORKPLAN 6.1 Pass B.
//
// The whole file exists because "did it transcribe?" has an obvious wrong
// answer. Measured on this machine 2026-08-29, b4938 / ggml-base.en:
//
//   * two seconds of digital SILENCE transcribes as " You" -- not '',
//     not [BLANK_AUDIO]. A check that asserts "something came back"
//     passes on a file with no speech in it, which is the one failure a
//     verification harness exists to catch.
//   * whisper-cli writes NOTHING to stdout when it fails and ~6 KB to
//     stderr. Draining stdout first with ReadToEnd() deadlocks against
//     the full stderr pipe: measured as a five-minute hang with both
//     processes alive and no output at all, which reads like a slow model
//     rather than a bug in the caller.
//   * base.en writes numbers as DIGITS ("five dozen" -> "5 dozen"), and
//     the synthesizer's "pack" comes back as "hack". A verification
//     phrase is a fixture; one the model gets wrong tests nothing.
//   * the code this replaced matched with `-like "*$phrase*"`, which is
//     wildcard syntax, not containment. A phrase holding `*` reports PASS
//     for audio that was never spoken.
//
// Everything that needs the 150 MB install is gated on it being there and
// SKIPS cleanly otherwise -- CI has no binary. What runs everywhere is the
// pure half: the normalizer, the comparison, the grounded errors, and the
// install discovery, all driven through the real PowerShell functions in
// scripts/lib/whisper-verify.ps1 rather than a paraphrase of them.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIB = path.join(ROOT, "scripts", "lib", "whisper-verify.ps1");
const RUNNER = path.join(ROOT, "scripts", "verify-whisper.ps1");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

if (process.platform !== "win32") {
  console.log("skip - the verification harness is PowerShell, Windows-only");
  process.exit(0);
}

// --- captured from whisper-cli 2026-08-29, verbatim -------------------
// b4938 / ggml-base.en, phrase spoken by Microsoft David Desktop.
const OUT_TIMESTAMPED =
  "\n[00:00:00.000 --> 00:00:03.080]   The quick brown fox jumps over the " +
  "lazy dog.\n";
const OUT_PLAIN = "\n The quick brown fox jumps over the lazy dog.\n";
// 2 s of 16 kHz silence. NOT empty, NOT [BLANK_AUDIO].
const OUT_SILENCE = "\n[00:00:00.000 --> 00:00:02.000]   You\n";
// `-f C:\nope\missing.wav`: exit 2, stdout empty, this on stderr, followed
// by ~5 KB of usage screen (trimmed here after the first option line).
const ERR_MISSING_FILE = [
  "load_backend: loaded CPU backend from C:\\Users\\mr\\AppData\\Roaming" +
    "\\AE-Llama\\vendor\\whisper.cpp\\bin\\Release\\ggml-cpu-cascadelake.dll",
  "error: input file not found 'C:\\nope\\missing.wav'",
  "error: no input files specified",
  "",
  "usage: whisper-cli.exe [options] file0 file1 ...",
  "supported audio formats: flac, mp3, ogg, wav",
  "",
  "options:",
  "  -h,        --help                 [default] show this help message and exit",
  "  -t N,      --threads N            [4      ] number of threads to use"
].join("\n");

/**
 * Run one PowerShell script that dot-sources the verification library, so
 * a whole batch of cases costs a single spawn. Captured whisper output is
 * handed over as JSON so no escaping rule has to be re-derived in
 * PowerShell quoting.
 */
function runPs(body) {
  const fixtures = JSON.stringify({
    timestamped: OUT_TIMESTAMPED,
    plain: OUT_PLAIN,
    silence: OUT_SILENCE,
    errMissing: ERR_MISSING_FILE
  });
  const preamble =
    ". '" + LIB.replace(/'/g, "''") + "'\n" +
    "$ErrorActionPreference = 'Stop'\n" +
    "$RAW = @'\n" + fixtures + "\n'@\n" +
    "$F = ConvertFrom-Json $RAW\n";
  const file = path.join(os.tmpdir(),
    "aell-whisper-verify-test-" + process.pid + ".ps1");
  fs.writeFileSync(file, preamble + body, "ascii");
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file
    ], { encoding: "utf8" });
  } finally {
    try { fs.unlinkSync(file); } catch (e) {}
  }
}

function field(out, key) {
  const m = new RegExp("^" + key + "=(.*)$", "m").exec(out);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------
// 1. The normalizer, against output whisper really produced.
// ---------------------------------------------------------------------
const norm = runPs([
  "Write-Output ('TS=' + (ConvertTo-AellWhisperText $F.timestamped))",
  "Write-Output ('PLAIN=' + (ConvertTo-AellWhisperText $F.plain))",
  "Write-Output ('SIL=' + (ConvertTo-AellWhisperText $F.silence))",
  "Write-Output ('EMPTY=[' + (ConvertTo-AellWhisperText '') + ']')",
  // digits must survive: a take number is not noise
  "Write-Output ('DIGITS=' + (ConvertTo-AellWhisperText 'Take 2, slate B.'))",
  // any other bracketed marker goes the same way as a timestamp
  "Write-Output ('MARK=' + (ConvertTo-AellWhisperText '[BLANK_AUDIO] hello'))"
].join("\n"));

assert(field(norm, "TS") === "the quick brown fox jumps over the lazy dog",
  "the [00:00:00.000 --> 00:00:03.080] stamp is stripped, words kept");
assert(field(norm, "PLAIN") === "the quick brown fox jumps over the lazy dog",
  "-nt output normalizes to the same text as the timestamped output");
assert(field(norm, "SIL") === "you",
  "silence normalizes to 'you', not to '' -- the trap is reproduced");
assert(field(norm, "EMPTY") === "[]",
  "empty input normalizes to empty, without throwing");
assert(field(norm, "DIGITS") === "take 2 slate b",
  "digits survive normalization (stripping them loses take numbers)");
assert(field(norm, "MARK") === "hello",
  "[BLANK_AUDIO] and friends are stripped like timestamps");

// ---------------------------------------------------------------------
// 2. The comparison. This is where "it transcribed" is decided, and both
//    directions matter: saying yes when it should, and NO when it should.
// ---------------------------------------------------------------------
const cmp = runPs([
  "$p = 'the quick brown fox jumps over the lazy dog'",
  "Write-Output ('HIT=' + (Test-AellPhraseHeard -Heard $F.timestamped -Phrase $p))",
  // THE bug this harness exists for: silence must not satisfy any phrase
  "Write-Output ('SIL=' + (Test-AellPhraseHeard -Heard $F.silence -Phrase $p))",
  // a phrase that was never spoken must not be found in this transcript
  "Write-Output ('OTHER=' + (Test-AellPhraseHeard -Heard $F.timestamped " +
    "-Phrase 'after effects renders the composition'))",
  // -like would read these as wildcard syntax
  "Write-Output ('STAR=' + (Test-AellPhraseHeard -Heard $F.timestamped " +
    "-Phrase 'the * dog'))",
  "Write-Output ('QMARK=' + (Test-AellPhraseHeard -Heard $F.timestamped " +
    "-Phrase 'the quick brown ?ox'))",
  // a marker dropped mid-sentence must not split the phrase in two
  "Write-Output ('BRACKET=' + (Test-AellPhraseHeard " +
    "-Heard 'render the [BLANK_AUDIO] shot' -Phrase 'render the shot'))",
  // an empty phrase is contained in everything -- must not be a pass
  "Write-Output ('BLANKPHRASE=' + (Test-AellPhraseHeard -Heard $F.plain -Phrase ''))",
  // punctuation and case whisper adds must not fail the match
  "Write-Output ('PUNCT=' + (Test-AellPhraseHeard " +
    "-Heard 'The quick brown fox, jumps over the lazy dog!' -Phrase $p))"
].join("\n"));

assert(field(cmp, "HIT") === "True",
  "the spoken phrase is found in its own transcript");
assert(field(cmp, "SIL") === "False",
  "silence's ' You' does NOT satisfy the phrase (non-empty is not enough)");
assert(field(cmp, "OTHER") === "False",
  "a phrase that was never spoken is not found");
assert(field(cmp, "STAR") === "False",
  "a phrase holding '*' is compared literally, not as a wildcard: " +
  "-like would report PASS here for audio nobody spoke");
assert(field(cmp, "QMARK") === "False",
  "a phrase holding '?' is compared literally too");
assert(field(cmp, "BRACKET") === "True",
  "a [MARKER] whisper drops into the middle of a sentence is removed " +
  "with its contents, so it does not split the phrase in two");
assert(field(cmp, "BLANKPHRASE") === "False",
  "an empty phrase is not 'heard in everything'");
assert(field(cmp, "PUNCT") === "True",
  "the period and capital whisper adds do not fail the match");

// ---------------------------------------------------------------------
// 3. The default phrase list is a FIXTURE, and the rules it must keep.
// ---------------------------------------------------------------------
const phrases = runPs([
  "Write-Output ('COUNT=' + $script:AellWhisperPhrases.Count)",
  "Write-Output ('JOINED=' + ($script:AellWhisperPhrases -join ' | '))"
].join("\n"));

const list = (field(phrases, "JOINED") || "").split(" | ");
assert(Number(field(phrases, "COUNT")) >= 3,
  "at least three phrases: one cannot tell transcription from a " +
  "constant string coming back");
assert(new Set(list).size === list.length, "the phrases are distinct");
// base.en writes numbers as digits, so a spoken number can never match
// the word. Measured: 'five dozen' -> '5 dozen'.
const NUMBER_WORDS = new RegExp("\\b(one|two|three|four|five|six|seven|" +
  "eight|nine|ten|eleven|twelve|dozen|hundred|thousand)\\b");
assert(!list.some((p) => NUMBER_WORDS.test(p)),
  "no phrase contains a number word (base.en transcribes them as digits)");
assert(!list.some((p) => /[^a-z ]/.test(p)),
  "the phrases are plain lowercase words, so normalization cannot " +
  "change what is being asserted");

// ---------------------------------------------------------------------
// 4. Grounded errors out of whisper-cli's 6 KB of stderr.
// ---------------------------------------------------------------------
const err = runPs([
  "Write-Output ('ERR=' + (Get-AellWhisperCliError $F.errMissing))",
  "Write-Output ('BANNERONLY=' + (Get-AellWhisperCliError " +
    "'load_backend: loaded CPU backend from x.dll'))",
  "Write-Output ('NONE=[' + (Get-AellWhisperCliError '') + ']')"
].join("\n"));

const errLine = field(err, "ERR") || "";
assert(/input file not found/.test(errLine),
  "the real reason is relayed: 'input file not found'");
assert(!/--threads|usage:/.test(errLine),
  "the ~5 KB usage screen is NOT relayed with it");
assert(!/^load_backend/.test(errLine),
  "the backend banner is not mistaken for the error");
assert(field(err, "BANNERONLY") === "",
  "a stderr holding only the banner reports no error");
assert(field(err, "NONE") === "[]", "empty stderr reports no error");

// ---------------------------------------------------------------------
// 5. Install discovery: what it finds, and what it SAYS when it does not.
//    Fabricated trees -- no binary, no download, runs on CI.
// ---------------------------------------------------------------------
const fake = path.join(os.tmpdir(), "aell-whisper-verify-fixture-" + process.pid);
function mk(rel, bytes) {
  const p = path.join(fake, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes || 1));
}
fs.rmSync(fake, { recursive: true, force: true });

const missingRoot = path.join(fake, "not-installed");
// (a) nothing at all
let find = runPs([
  "$r = Find-AellWhisperInstall -Root '" + missingRoot.replace(/'/g, "''") + "'",
  "Write-Output ('OK=' + $r.Ok)",
  "Write-Output ('WHY=' + $r.Reason)"
].join("\n"));
assert(field(find, "OK") === "False", "a missing root is not Ok");
assert(/get-whisper\.ps1/.test(field(find, "WHY") || ""),
  "and the reason names the acquirer to run");

// (b) a bin folder holding the wrong exes -- main.exe is the deprecation
//     shim, so finding IT would be the bug.
mk("bin/Release/main.exe");
mk("bin/Release/bench.exe");
find = runPs([
  "$r = Find-AellWhisperInstall -Root '" + fake.replace(/'/g, "''") + "'",
  "Write-Output ('OK=' + $r.Ok)",
  "Write-Output ('WHY=' + $r.Reason)"
].join("\n"));
assert(field(find, "OK") === "False",
  "main.exe alone is not an install (it is a deprecation shim)");
const why = field(find, "WHY") || "";
assert(/whisper-cli\.exe/.test(why) && /main\.exe/.test(why) &&
       /bench\.exe/.test(why),
  "the reason names what is missing AND lists the exes that are there");

// (c) the cli, but no model
mk("bin/Release/whisper-cli.exe");
fs.mkdirSync(path.join(fake, "models"), { recursive: true });
find = runPs([
  "$r = Find-AellWhisperInstall -Root '" + fake.replace(/'/g, "''") + "'",
  "Write-Output ('OK=' + $r.Ok)",
  "Write-Output ('WHY=' + $r.Reason)"
].join("\n"));
assert(field(find, "OK") === "False", "a binary with no model is not Ok");
assert(/only the model is missing/.test(field(find, "WHY") || ""),
  "and the reason says the binary IS installed, so nobody re-downloads it");

// (d) two models: the default takes the smaller file, a name takes that
//     one, and an absent name is grounded against what is present.
mk("models/ggml-base.en.bin", 4096);
mk("models/ggml-small.en.bin", 9000);
find = runPs([
  "$q = '" + fake.replace(/'/g, "''") + "'",
  "$a = Find-AellWhisperInstall -Root $q",
  "Write-Output ('AOK=' + $a.Ok)",
  "Write-Output ('APICK=' + (Split-Path -Leaf $a.Model))",
  "Write-Output ('ACLI=' + (Split-Path -Leaf $a.Cli))",
  "$b = Find-AellWhisperInstall -Root $q -Model 'small.en'",
  "Write-Output ('BPICK=' + (Split-Path -Leaf $b.Model))",
  // the file name is what the whisper docs print; it must work too
  "$c = Find-AellWhisperInstall -Root $q -Model 'ggml-small.en.bin'",
  "Write-Output ('CPICK=' + (Split-Path -Leaf $c.Model))",
  "$d = Find-AellWhisperInstall -Root $q -Model 'large-v3'",
  "Write-Output ('DOK=' + $d.Ok)",
  "Write-Output ('DWHY=' + $d.Reason)"
].join("\n"));
assert(field(find, "AOK") === "True", "cli + model under the root is Ok");
assert(field(find, "ACLI") === "whisper-cli.exe",
  "the cli is found under bin\\Release\\, not at the top of bin\\");
assert(field(find, "APICK") === "ggml-base.en.bin",
  "with no -Model the SMALLEST model wins, so the check stays fast");
assert(field(find, "BPICK") === "ggml-small.en.bin",
  "-Model small.en takes that model instead");
assert(field(find, "CPICK") === "ggml-small.en.bin",
  "-Model accepts the full file name too");
assert(field(find, "DOK") === "False", "a model that is not there is not Ok");
const dwhy = field(find, "DWHY") || "";
assert(/ggml-base\.en\.bin/.test(dwhy) && /ggml-small\.en\.bin/.test(dwhy),
  "and the reason lists the models that ARE present");

// (e) the runner skips on a missing install and exits 0 -- this is the
//     path CI takes, and a non-zero exit there would redden every build.
const skipRun = spawnSync("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RUNNER,
  "-Root", missingRoot
], { encoding: "utf8" });
assert(skipRun.status === 0, "verify-whisper.ps1 exits 0 with no install");
assert(/SKIP/.test(skipRun.stdout || ""), "and says SKIP, not PASS");
assert(!/PASSED/.test(skipRun.stdout || ""),
  "a skip is never reported as a pass");

const requireRun = spawnSync("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RUNNER,
  "-Root", missingRoot, "-Require"
], { encoding: "utf8" });
assert(requireRun.status === 2,
  "-Require turns the same missing install into exit 2");

fs.rmSync(fake, { recursive: true, force: true });

// ---------------------------------------------------------------------
// 6. The deadlock. A child that writes a lot to stderr and a little to
//    stdout hangs forever if stdout is drained with ReadToEnd() before
//    the process is waited on -- measured against the real whisper-cli,
//    which dumps ~6 KB of usage on any argument error.
//
//    Reproduced here with a stand-in console exe compiled on the spot, so
//    the case runs with no 150 MB install. If the machine has no C#
//    compiler the case is skipped rather than failed.
// ---------------------------------------------------------------------
const noisySrc = [
  "using System;",
  "public class P {",
  "  public static int Main(string[] a) {",
  // 200 KB, far past any pipe buffer
  "    for (int i = 0; i < 2000; i++)",
  "      Console.Error.WriteLine(new string('x', 100));",
  "    Console.Out.WriteLine(\" The quick brown fox jumps over the lazy dog.\");",
  "    Console.Error.WriteLine(\"error: input file not found 'nope.wav'\");",
  "    return 7;",
  "  }",
  "}"
].join("\n");
const noisyExe = path.join(os.tmpdir(), "aell-noisy-" + process.pid + ".exe");
let compiled = false;
try {
  const build = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    "$src = [Console]::In.ReadToEnd(); " +
    "Add-Type -TypeDefinition $src -OutputAssembly '" +
    noisyExe.replace(/'/g, "''") + "' -OutputType ConsoleApplication"
  ], { input: noisySrc, encoding: "utf8", timeout: 120000 });
  compiled = build.status === 0 && fs.existsSync(noisyExe);
  if (!compiled) {
    console.log("skip - no C# compiler for the deadlock case: " +
                (build.stderr || "").split("\n")[0]);
  }
} catch (e) {
  console.log("skip - could not build the deadlock stand-in: " + e.message);
}

if (compiled) {
  const started = Date.now();
  const dead = runPs([
    "$r = Invoke-AellWhisperCli -Cli '" + noisyExe.replace(/'/g, "''") +
      "' -Model m -Wav w -TimeoutMs 30000",
    "Write-Output ('EXIT=' + $r.ExitCode)",
    "Write-Output ('TIMEDOUT=' + $r.TimedOut)",
    "Write-Output ('ERRLEN=' + $r.Err.Length)",
    "Write-Output ('TEXT=' + $r.Text)",
    "Write-Output ('WHY=' + (Get-AellWhisperCliError $r.Err))"
  ].join("\n"));
  const took = Date.now() - started;
  assert(field(dead, "TIMEDOUT") === "False",
    "a child writing 200 KB to stderr does not hang the reader " +
    "(took " + took + " ms; ReadToEnd-then-WaitForExit never returns)");
  assert(field(dead, "EXIT") === "7",
    "the child's real exit code comes back, not 0");
  assert(Number(field(dead, "ERRLEN")) > 100000,
    "all of stderr is captured, not the first pipe-buffer's worth");
  assert(field(dead, "TEXT") === "the quick brown fox jumps over the lazy dog",
    "and stdout is captured and normalized at the same time");
  assert(/input file not found/.test(field(dead, "WHY") || ""),
    "the grounded reason is pulled out of that stderr");
  try { fs.unlinkSync(noisyExe); } catch (e) {}
}

// ---------------------------------------------------------------------
// 7. The real thing -- only where a real install exists. This is the
//    field truth the stub half is modelled on; CI skips it.
// ---------------------------------------------------------------------
const realRoot = path.join(process.env.APPDATA || "",
  "AE-Llama", "vendor", "whisper.cpp");
const haveReal = fs.existsSync(path.join(realRoot, "models"));
if (!haveReal) {
  console.log("skip - no whisper.cpp install at " + realRoot +
              " (run scripts/get-whisper.ps1 to exercise the real check)");
} else {
  const run = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RUNNER, "-Require"
  ], { encoding: "utf8", timeout: 600000 });
  const out = run.stdout || "";
  assert(run.status === 0, "the real round-trip passes: " + out.trim());
  assert(/PASSED/.test(out), "and reports every phrase heard back");
  assert(/control:/.test(out),
    "including the negative control -- a harness that cannot fail " +
    "proves nothing");
}

// ---------------------------------------------------------------------
// 8. House rules: Windows PowerShell 5.1 wants BOM-less ASCII, and there
//    must be exactly ONE implementation of the round-trip.
// ---------------------------------------------------------------------
[LIB, RUNNER].forEach(function (f) {
  const buf = fs.readFileSync(f);
  let bad = -1;
  for (let i = 0; i < buf.length; i++) { if (buf[i] > 127) { bad = i; break; } }
  assert(bad === -1, path.basename(f) + " is pure ASCII (byte " + bad + ")");
});

const acquirer = fs.readFileSync(
  path.join(ROOT, "scripts", "get-whisper.ps1"), "utf8");
assert(/Invoke-AellWhisperCheck/.test(acquirer),
  "get-whisper.ps1's own verify step calls the shared check");
assert(!/SpeechAudioFormatInfo/.test(acquirer),
  "and does not carry a second copy of the synthesizer");

console.log(failed ? "\n" + failed + " FAILED" : "\nall passed");
