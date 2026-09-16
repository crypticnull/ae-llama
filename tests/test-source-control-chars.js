// Regression test: no source file may contain a literal ASCII control
// character.
//
// MEASURED 2026-09-09, and it had already shipped a DEAD assertion.
// tests/test-model-catalog.js:211 was written the night before as
//
//     /\b\d+(\.\d+)?\s*(s\b|sec|seconds|f\b|frames)/i
//
// and reached disk as
//
//     /<0x08>d+(\.\d+)?\s*(s<0x08>|sec|seconds|f<0x08>|frames)/i
//
// -- every `\b` word boundary turned into a literal BACKSPACE by the tool
// that wrote the file. The regex then required a 0x08 byte inside
// measuredAt, so it could never match anything, and the rule its own log
// entry described ("a measured video entry must name the clip LENGTH")
// was enforcing nothing at all. It hid because the only video entry was
// `measured: false`, so the branch holding it never ran; the FIRST pass to
// measure one is the pass that found it.
//
// The failure mode is the point: a mangled escape does not throw, does not
// fail to parse, and does not look wrong in a diff -- `cat -A` is the only
// way to see it. A regex that can never match reads exactly like a rule
// that is being obeyed. So this is a byte-level check, not a behaviour one.
//
// 0x09 tab, 0x0A newline and 0x0D carriage return are the three that
// legitimately appear in source. Everything else under 0x20 is a mistake:
// nothing in this repo means to embed a bell, a form feed or a NUL.
//
// Only files git would COMMIT are scanned (tracked, or untracked and not
// ignored). MEASURED 2026-09-16: a plain directory walk also read the
// gitignored `local/`, where a sweep had saved raw ANSI-coloured backend
// output (`local/attn-sweep.txt`, `local/ck7a-sweep.txt`), and failed 3 of
// 4 on this machine while CI -- which has no `local/` -- stayed green. A
// test that is red locally and green in CI for a file nobody can commit
// teaches a pass to ignore a red test, which is worse than no test.
"use strict";
const fs = require("fs");
const path = require("path");
const { listFiles, ignoredAmong } = require("./lib/git-files");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", "logs", "dist", "build",
                           "vendor", ".claude"]);
// Text we author. Binary (.7z, .png, .mp4, .zxp) is excluded by extension
// rather than by sniffing, so a new binary type is a visible edit here.
const EXTS = new Set([".js", ".jsx", ".json", ".ps1", ".md", ".html", ".css",
                      ".xml", ".yml", ".yaml", ".txt", ".bat", ".sh"]);
const ALLOWED = new Set([9, 10, 13]);

let checks = 0;
let failures = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { console.error("FAIL:", msg); failures++; process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// What git would commit (tracked, or untracked and not ignored); a walk
// stands in when git is unavailable. Shared with the probe guards.
const files = listFiles(ROOT, { exts: EXTS, skipDirs: SKIP_DIRS });
assert(files.length > 50,
       "the " + (files.fromGit ? "git file list" : "walk (no git)") +
       " found the repo's source files (" + files.length + ")");

// The regression itself: when git answered, nothing it IGNORES may be in the
// list. Asked of git per path, not of a hard-coded `local/`, so a new ignore
// rule is honoured without an edit here.
if (files.fromGit) {
  const ignored = ignoredAmong(ROOT, files);
  assert(ignored.length === 0,
         "no gitignored path is scanned (a red test here for a file nobody " +
         "can commit is one a pass learns to ignore)" +
         (ignored.length ? " -- got: " + ignored[0] : ""));
}

// One assertion per OFFENDING file, plus one for the whole sweep: a clean
// repo should not print several hundred ok lines to say nothing happened.
const offenders = [];
for (const full of files) {
  const buf = fs.readFileSync(full);
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 32 || ALLOWED.has(c)) continue;
    // Name the line and show the neighbourhood: a bare byte offset in a
    // 20k-line file is not something a reader can act on.
    const before = buf.slice(0, i).toString("utf8");
    const line = before.split("\n").length;
    const ctx = buf.slice(Math.max(0, i - 40), i + 20).toString("latin1")
                   .replace(/[\x00-\x1f]/g, (m) =>
                     "<0x" + m.charCodeAt(0).toString(16).padStart(2, "0") + ">");
    offenders.push(path.relative(ROOT, full) + ":" + line +
                   " byte 0x" + c.toString(16).padStart(2, "0") +
                   "  ..." + ctx + "...");
    break;   // one report per file is enough to act on
  }
}

offenders.forEach((o) => {
  assert(false, "literal control character in source -- " + o);
});
assert(offenders.length === 0,
       "no source file carries a literal control character (a mangled \\b " +
       "or \\t escape parses fine and silently disables whatever it is in)");

console.log(failures ? "\n" + failures + " of " + checks + " FAILED"
                     : "\n" + checks + " checks passed");
