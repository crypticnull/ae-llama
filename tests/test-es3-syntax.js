// Regression test: every file that After Effects has to COMPILE must be
// valid ES3. ExtendScript is ES3, and its failure mode is brutal:
//
//   var final = null;   // `final` is an ES3 FutureReservedWord
//
// AE rejects the WHOLE file at compile time ("Illegal use of reserved
// word"), so not a single statement runs — including the try/catch that
// was supposed to report the error. scripts/run-ae-selftest.ps1 then
// reports only a generic timeout, and the resulting modal DISABLES AE's
// main window, so every later `AfterFX.exe -r` is silently swallowed.
//
// Node can never catch this by executing the code: `var final` is legal
// in modern JS. It has to be caught by reading the source, which is what
// this test does — no AE required.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}

// ES3 (ECMA-262 3rd ed. 7.5.3) FutureReservedWord. Using any of these as
// an identifier is a compile error in ExtendScript.
const RESERVED = [
  "abstract", "boolean", "byte", "char", "class", "const", "debugger",
  "double", "enum", "export", "extends", "final", "float", "goto",
  "implements", "import", "int", "interface", "long", "native",
  "package", "private", "protected", "public", "short", "static",
  "super", "synchronized", "throws", "transient", "volatile"
];

/**
 * Blank out comments and string literals, preserving line structure, so
 * the scanners only ever see real code. Without this, an error message
 * like "no such class" would be flagged as a reserved word.
 */
function stripNonCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { i++; }
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") { i++; }
        if (src[i] === "\n") { out += "\n"; }
        i++;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Every violation found in one file, as {line, rule, text}. */
function scan(src) {
  const code = stripNonCode(src);
  const lines = code.split(/\r?\n/);
  const hits = [];

  lines.forEach((line, idx) => {
    const at = (rule, m) =>
      hits.push({ line: idx + 1, rule, text: m });

    for (const word of RESERVED) {
      // Bare identifier: `var final = ...`, `if (final)`. This is the
      // form that actually broke the harness.
      const bare = new RegExp(
        "(^|[^.\\w$])(" + word + ")\\b(?!\\s*:)", "g");
      if (bare.test(line)) {
        at("ES3 reserved word `" + word + "`", line.trim());
        continue;
      }
      // ES3 also forbids reserved words as property names, in both
      // `obj.class` and `{ class: 1 }` form — Identifier excludes
      // ReservedWord in the MemberExpression grammar.
      const prop = new RegExp(
        "\\.\\s*" + word + "\\b|(^|[^.\\w$])" + word + "\\s*:", "g");
      if (prop.test(line)) {
        at("ES3 reserved word `" + word + "` as property name", line.trim());
      }
    }
    if (/(^|[^.\w$])(const|let)\s+[A-Za-z_$]/.test(line)) {
      at("const/let (ES3 has neither)", line.trim());
    }
    if (/=>/.test(line)) {
      at("arrow function", line.trim());
    }
    if (/`/.test(line)) {
      at("template literal", line.trim());
    }
  });
  return hits;
}

// Files AE must compile: every .jsx, plus selftest.js — which is
// dual-target, running in the CEP panel AND $.evalFile'd by the harness
// (see scripts/ae-selftest.jsx), so it is bound by ES3 too.
function jsxIn(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter(f => f.endsWith(".jsx"))
    .map(f => path.join(dir, f).replace(/\\/g, "/"));
}
const TARGETS = jsxIn("extension/jsx")
  .concat(jsxIn("scripts"))
  // probe/ ships nothing, but ExtendScript still has to COMPILE it, and
  // a reserved word there costs a trip to the owner's machine with
  // Premiere open — the most expensive kind of round trip this project
  // has (docs/PREMIERE_PLAN.md P0).
  .concat(jsxIn("probe/com.cptk.aellama.probe/jsx"))
  .concat(["extension/js/selftest.js"]);

assert(TARGETS.length >= 3,
       "found " + TARGETS.length + " ExtendScript-compiled files to scan");

let totalHits = 0;
for (const rel of TARGETS) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const hits = scan(src);
  totalHits += hits.length;
  assert(hits.length === 0,
         rel + " is ES3-clean" +
         (hits.length
           ? "\n      " + hits.map(h =>
               rel + ":" + h.line + "  " + h.rule + "  ->  " + h.text
             ).join("\n      ")
           : ""));
}

// The scanner must actually bite. Without this, a broken regex would
// turn the whole test into a silent no-op that passes forever.
const KNOWN_BAD = [
  ["var final = null;", "ES3 reserved word `final`"],
  ["if (final) { writeOut(final); }", "ES3 reserved word `final`"],
  ["const x = 1;", "const/let (ES3 has neither)"],
  ["var f = (a) => a + 1;", "arrow function"],
  ["var s = `hi`;", "template literal"],
  ["var klass = obj.class;", "ES3 reserved word `class` as property name"],
  ["var o = { final: 1 };", "ES3 reserved word `final` as property name"]
];
for (const [bad, rule] of KNOWN_BAD) {
  const hits = scan(bad);
  assert(hits.some(h => h.rule === rule),
         "scanner catches: " + bad.trim());
}

// ...and must not cry wolf on legal ES3 that merely mentions the words.
const KNOWN_GOOD = [
  'var msg = "no such class or final value";',
  "// final: the last one",
  "/* class, static, final */",
  'if (s.indexOf("/") !== -1) { return "finalist"; }',
  "var superb = 1, internal = 2, constant = 3, klass = 4;",
  'throw new Error("interface not implemented");'
];
for (const good of KNOWN_GOOD) {
  const hits = scan(good);
  assert(hits.length === 0,
         "no false positive: " + good.trim() +
         (hits.length ? "  (got " + hits[0].rule + ")" : ""));
}

console.log(process.exitCode
  ? "\nTESTS FAILED"
  : "\nALL TESTS PASSED (" + TARGETS.length + " files scanned, " +
    totalHits + " violations)");
