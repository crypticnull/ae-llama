/*
 * test-es3-ternary.js — ExtendScript parses `?:` LEFT-associatively.
 *
 * THE FIELD FACT (measured in real AE 2026, ExtendScript $.version
 * 4.5.6, build 80.1060872, 2026-09-01):
 *
 *     true  ? 1 : true ? 2 : 3            -> 2    (ECMA says 1)
 *     false ? 1 : true ? 2 : true ? 3 : 4 -> 3    (ECMA says 2)
 *
 * Every other JS engine on earth — including the Chromium that runs the
 * panel's own .js, and the Node that runs these tests — parses the
 * conditional operator RIGHT-associatively, so a chained ternary reads
 * correctly everywhere except the one engine that actually ships the
 * host tools. ExtendScript groups it as
 *
 *     ((a ? b : c) ? d : e) ? f : g
 *
 * which means the FIRST branch's VALUE becomes the next condition. The
 * shape is only accidentally right when the earlier conditions are false
 * and the fallthrough values happen to be truthy — which is why the bug
 * class hid for so long: two-level chains starting with a false test
 * still return the right answer.
 *
 * It cost a real harness failure: reorder_layers' landing-slot check
 * computed `want` from a four-way chain, got 1 instead of 7, and warned
 * the model that a perfectly correct move had gone wrong.
 *
 * Node CANNOT reproduce the miscompute — it parses the same source
 * correctly. So this suite is a SOURCE lint, not a behaviour test: it
 * refuses any nested conditional in an ES3-executed file that is not
 * explicitly parenthesised. Parens are unambiguous in both engines.
 *
 * Scope = the files ExtendScript actually evaluates:
 *   extension/jsx/hostscript.jsx  (every host tool)
 *   extension/js/selftest.js      ($.evalFile'd by scripts/ae-selftest.jsx)
 *   scripts/ae-selftest.jsx       (the CLI runner itself)
 * The rest of extension/js/ runs in CEP's Chromium and is unaffected.
 *
 * ...EXCEPT where a .js file BUILDS ExtendScript as a string and sends it
 * to AE. That source is ExtendScript-executed too, and the file it lives
 * in is not, so the list above walked straight past it: scripts/
 * chat-probe.js's comp reader classified mask modes with a bare chain,
 * every SUBTRACT mask read back as 'add', and the paraphrase matrix
 * scored two correct model answers as HARM. So the second half of this
 * lint reconstructs the ExtendScript out of the STRING LITERALS of every
 * .js under scripts/ and extension/js/ and scans that too — no list to
 * keep, and the next embedded body is covered the day it is written.
 */

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");

// Discovered the same way tests/test-es3-syntax.js discovers them (every
// .jsx AE compiles, plus the dual-target selftest.js), so a new
// ExtendScript file cannot land in one lint's scope and miss the other's.
function jsxIn(dir) {
  var abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter(function (f) {
    return /\.jsx$/.test(f);
  }).map(function (f) {
    return (dir + "/" + f).replace(/\\/g, "/");
  });
}
var FILES = jsxIn("extension/jsx")
  .concat(jsxIn("scripts"))
  // The P0 probe bundle: compiled by ExtendScript in both hosts, so the
  // left-associative ?: rule binds it too (docs/PREMIERE_PLAN.md P0).
  .concat(jsxIn("probe/com.cptk.aellama.probe/jsx"))
  .concat(["extension/js/selftest.js"]);

var passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; return true; }
  failed++;
  console.log("FAIL: " + label);
  return false;
}

/*
 * Blank out comments, string literals and regex literals in place so the
 * scanner below sees only code punctuation, with every source offset
 * (and therefore every line number) preserved.
 */
function blankNonCode(src) {
  var out = src.split("");
  var i = 0, n = src.length;

  function regexCanStartHere(pos) {
    for (var j = pos - 1; j >= 0; j--) {
      var c = src.charAt(j);
      if (c === " " || c === "\t" || c === "\r" || c === "\n") continue;
      if ("(,=:[!&|?{};+-*%~^<>".indexOf(c) >= 0) return true;
      if (/[A-Za-z0-9_$]/.test(c)) {
        var w = src.slice(Math.max(0, j - 10), j + 1).match(/[A-Za-z0-9_$]+$/);
        var kw = ["return", "typeof", "case", "in", "new", "delete", "void",
                  "instanceof", "do", "else"];
        return !!(w && kw.indexOf(w[0]) >= 0);
      }
      return false;
    }
    return true;
  }
  function wipe(from, to) {
    for (var k = from; k < to && k < n; k++) {
      if (src.charAt(k) !== "\n") out[k] = " ";
    }
  }

  while (i < n) {
    var c = src.charAt(i);
    if (c === "/" && src.charAt(i + 1) === "/") {
      var eol = src.indexOf("\n", i);
      if (eol < 0) eol = n;
      wipe(i, eol);
      i = eol;
      continue;
    }
    if (c === "/" && src.charAt(i + 1) === "*") {
      var close = src.indexOf("*/", i + 2);
      var end = close < 0 ? n : close + 2;
      wipe(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      var q = c;
      out[i] = " ";
      i++;
      while (i < n) {
        var d = src.charAt(i);
        if (d === "\\") { out[i] = " "; if (i + 1 < n) out[i + 1] = " "; i += 2; continue; }
        out[i] = " ";
        i++;
        if (d === q) break;
        if (d === "\n") break;   // unterminated: do not swallow the file
      }
      continue;
    }
    if (c === "/" && regexCanStartHere(i)) {
      var j = i + 1, inClass = false, closed = false;
      while (j < n) {
        var e = src.charAt(j);
        if (e === "\\") { j += 2; continue; }
        if (e === "\n") break;
        if (e === "[") inClass = true;
        else if (e === "]") inClass = false;
        else if (e === "/" && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        var after = j + 1;
        while (after < n && /[a-z]/.test(src.charAt(after))) after++;
        wipe(i, after);
        i = after;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/*
 * Find every conditional operator that is nested directly inside another
 * conditional at the SAME bracket depth — i.e. written as a bare chain
 * rather than wrapped in parentheses. Wrapping in parens pushes the inner
 * `?` one depth down, so a parenthesised nest never matches: the depth
 * test IS the paren test.
 *
 * `:` also ends `case`/`default` labels and separates object-literal
 * keys. Neither has an open `?` pending at its own depth, so both fall
 * through the else branch untouched.
 */
function findChainedTernaries(src) {
  var code = blankNonCode(src);
  var depth = 0;
  var pending = [];   // '?' seen, ':' not yet
  var alts = [];      // ':' seen, alternate still being parsed
  var hits = [];
  var lineStarts = [0];
  var i;
  for (i = 0; i < src.length; i++) {
    if (src.charAt(i) === "\n") lineStarts.push(i + 1);
  }
  function lineOf(pos) {
    var lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  for (i = 0; i < code.length; i++) {
    var c = code.charAt(i);
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      while (alts.length && alts[alts.length - 1] > depth) alts.pop();
      while (pending.length && pending[pending.length - 1] > depth) pending.pop();
      continue;
    }
    if (c === "," || c === ";") {
      while (alts.length && alts[alts.length - 1] >= depth) alts.pop();
      continue;
    }
    if (c === "?") {
      if (alts.length && alts[alts.length - 1] === depth) {
        hits.push({ line: lineOf(i), pos: i, where: "alternate" });
      } else if (pending.length && pending[pending.length - 1] === depth) {
        hits.push({ line: lineOf(i), pos: i, where: "consequent" });
      }
      pending.push(depth);
      continue;
    }
    if (c === ":") {
      if (pending.length && pending[pending.length - 1] === depth) {
        pending.pop();
        alts.push(depth);
      } else {
        while (alts.length && alts[alts.length - 1] >= depth) alts.pop();
      }
      continue;
    }
  }
  return hits;
}

console.log("== ExtendScript ternary associativity lint ==");

// ---- 1. The scanner must actually detect the shape it is guarding ----
// A lint that silently degrades to "found nothing" is worse than none,
// so prove the detector on samples before trusting its verdict.
var BAD = [
  ["bare 3-level chain",
   "var w = k === 'a' ? t - 1 : k === 'b' ? t + 1 : k === 'c' ? 1 : n;"],
  ["bare 2-level chain",
   "var w = a ? 1 : b ? 2 : 3;"],
  ["chain across newlines",
   "var w = key === 'above' ? target.index - 1\n" +
   "  : key === 'below' ? target.index + 1\n" +
   "  : key === 'toFront' ? 1 : numLayers;"],
  ["chain inside a call argument",
   "f(x ? 1 : y ? 2 : 3);"],
  ["chain inside an object value",
   "var o = { k: x ? 1 : y ? 2 : 3 };"],
  ["chain inside a return",
   "function f() { return x ? 1 : y ? 2 : 3; }"],
  ["nest in the CONSEQUENT",
   "var w = a ? b ? 1 : 2 : 3;"]
];
for (var b = 0; b < BAD.length; b++) {
  ok(findChainedTernaries(BAD[b][1]).length > 0,
     "detector misses a real chain: " + BAD[b][0]);
}

var GOOD = [
  ["single ternary", "var w = a ? 1 : 2;"],
  ["parenthesised nest",
   "var w = a ? 1 : (b ? 2 : (c ? 3 : 4));"],
  ["parenthesised nest across newlines",
   "var w = key === 'above' ? target.index - 1\n" +
   "  : (key === 'below' ? target.index + 1\n" +
   "  : (key === 'toFront' ? 1 : numLayers));"],
  ["two INDEPENDENT ternaries in one statement",
   "var w = (a ? 1 : 2) + (b ? 3 : 4);"],
  ["independent ternaries as separate call args",
   "f(a ? 1 : 2, b ? 3 : 4);"],
  ["independent ternaries as separate object values",
   "var o = { p: a ? 1 : 2, q: b ? 3 : 4 };"],
  ["ternary in a nested call inside an alternate",
   "var w = a ? 1 : f(b ? 2 : 3);"],
  ["a ternary then a later statement's ternary",
   "var w = a ? 1 : 2; var v = b ? 3 : 4;"],
  ["object literal colons are not conditionals",
   "var o = { a: 1, b: 2 }; var w = c ? 1 : 2;"],
  ["switch labels are not conditionals",
   "switch (x) { case 1: y = a ? 1 : 2; break; default: y = 0; }"],
  ["a '?' inside a string is not code",
   "var s = 'a ? b : c ? d : e'; var w = x ? 1 : 2;"],
  ["a '?' inside a comment is not code",
   "/* a ? b : c ? d : e */ var w = x ? 1 : 2;"],
  ["a '?' inside a regex is not code",
   "var re = /(a)?(b)?:(c)?/; var w = x ? 1 : 2;"],
  ["regex containing a slash-in-class",
   "var re = /[/?]/g; var w = x ? 1 : 2;"],
  ["parenthesised nest in the CONSEQUENT",
   "var w = a ? (b ? 1 : 2) : 3;"]
];
for (var g = 0; g < GOOD.length; g++) {
  var falsePos = findChainedTernaries(GOOD[g][1]);
  ok(falsePos.length === 0,
     "detector false-positives on safe code: " + GOOD[g][0] +
     " (line " + (falsePos[0] && falsePos[0].line) + ")");
}

// ---- 2. The real files ----
ok(FILES.length >= 3,
   "found " + FILES.length + " ExtendScript-executed files to scan");
for (var f = 0; f < FILES.length; f++) {
  var rel = FILES[f];
  var abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    ok(false, "ES3-executed file is missing: " + rel);
    continue;
  }
  var text = fs.readFileSync(abs, "utf8");
  var hits = findChainedTernaries(text);
  var lines = text.split("\n");
  var detail = hits.slice(0, 12).map(function (h) {
    return "\n    " + rel + ":" + h.line + " [" + h.where + "] " +
           (lines[h.line - 1] || "").trim().slice(0, 90);
  }).join("");
  ok(hits.length === 0,
     rel + " has " + hits.length + " unparenthesised chained ternary/ies" +
     " — ExtendScript parses these LEFT-associatively and will compute" +
     " the wrong branch. Wrap each nested conditional in parentheses." +
     detail);
}

// ---- 3. ExtendScript that lives INSIDE a .js file, as string literals -
/*
 * The inverse of blankNonCode: blank the comments and the code, KEEP what
 * is inside double-quoted strings, and preserve every offset so the line
 * numbers reported are this file's real ones.
 *
 * An escaped quote becomes a real quote, because in the reconstructed
 * ExtendScript it IS one — the scanner then treats what follows as the
 * string it will be at runtime. Every other escape becomes two spaces:
 * whitespace parses the same and cannot be mistaken for code.
 */
function embeddedEs3(src) {
  var out = src.split("");
  var i = 0, n = src.length;
  function blank(k) { if (src.charAt(k) !== "\n") out[k] = " "; }
  while (i < n) {
    var c = src.charAt(i);
    if (c === "/" && src.charAt(i + 1) === "/") {
      var eol = src.indexOf("\n", i);
      if (eol < 0) eol = n;
      while (i < eol) { blank(i); i++; }
      continue;
    }
    if (c === "/" && src.charAt(i + 1) === "*") {
      var close = src.indexOf("*/", i + 2);
      var end = close < 0 ? n : close + 2;
      while (i < end) { blank(i); i++; }
      continue;
    }
    if (c === '"') {
      blank(i);                       // the opening quote is not content
      i++;
      while (i < n) {
        var d = src.charAt(i);
        if (d === "\\") {
          var esc = src.charAt(i + 1);
          blank(i);
          if (esc === '"' || esc === "'") out[i + 1] = esc;
          else if (i + 1 < n) blank(i + 1);
          i += 2;
          continue;
        }
        if (d === '"') { blank(i); i++; break; }
        if (d === "\n") break;       // unterminated: do not swallow the file
        i++;                          // KEEP: this is ExtendScript source
      }
      continue;
    }
    // Single-quoted JS strings hold ExtendScript's own string literals in
    // this codebase's style, so they are code to blank, not content.
    if (c === "'") {
      blank(i);
      i++;
      while (i < n) {
        var e2 = src.charAt(i);
        if (e2 === "\\") { blank(i); if (i + 1 < n) blank(i + 1); i += 2; continue; }
        blank(i);
        i++;
        if (e2 === "'") break;
        if (e2 === "\n") break;
      }
      continue;
    }
    blank(i);
    i++;
  }
  return out.join("");
}

function jsIn(dir) {
  var abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter(function (f) {
    return /\.js$/.test(f);
  }).map(function (f) {
    return (dir + "/" + f).replace(/\\/g, "/");
  });
}

// Prove the extractor on the exact shape that shipped, so a lint that
// degraded to "found nothing" cannot pass silently.
var SAMPLE =
  "var s = \"  row.maskModes.push(mm === MaskMode.SUBTRACT ? 'subtract'\" +\n" +
  "        \"  : mm === MaskMode.ADD ? 'add' : 'other');\";\n";
ok(findChainedTernaries(embeddedEs3(SAMPLE)).length > 0,
   "the extractor finds a chained ternary built out of string literals");
ok(findChainedTernaries(embeddedEs3(
     'var s = "a ? 1 : (b ? 2 : 3)";')).length === 0,
   "…and leaves a parenthesised one alone");
ok(findChainedTernaries(embeddedEs3(
     'var w = a ? 1 : b ? 2 : 3;   // NODE code, not ExtendScript'
   )).length === 0,
   "…and ignores the host .js file's OWN ternaries");

/*
 * Which .js files actually BUILD ExtendScript? The ones whose string
 * literals talk to AE's object model. That test is the file's own
 * evidence rather than a list somebody has to remember to extend — and
 * it is what keeps the tool DOCS out: `mode?: add|subtract` reads as a
 * conditional to any scanner, and tools.js is full of them, but none of
 * that text is ever handed to an interpreter.
 */
var AE_OBJECT_MODEL =
  /app\.project|\$\.global\.AELL|numLayers|beginUndoGroup|ADBE |MaskMode|CompItem/;

var EMBED = jsIn("scripts").concat(jsIn("extension/js")).filter(function (rel) {
  var t = embeddedEs3(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  return AE_OBJECT_MODEL.test(t);
});
ok(EMBED.length >= 1,
   "found " + EMBED.length + " .js file(s) that embed ExtendScript: " +
   EMBED.join(", "));
for (var m = 0; m < EMBED.length; m++) {
  var mrel = EMBED[m];
  var mtext = fs.readFileSync(path.join(ROOT, mrel), "utf8");
  var mbody = embeddedEs3(mtext);
  var mbodyLines = mbody.split("\n");
  // A .js file that embeds ExtendScript also holds ordinary Node strings,
  // and some of those are REGEX sources — "(?:need|have) to|without(?:
  // having to)?" reads as a chained conditional to any scanner and is not
  // code anybody executes. So a hit counts only where the ExtendScript
  // AROUND it is talking to AE's object model. The window is the unit
  // because these bodies are written as one concatenation dozens of
  // lines long.
  var mhits = findChainedTernaries(mbody).filter(function (h) {
    var from = Math.max(0, h.line - 26);
    return AE_OBJECT_MODEL.test(
      mbodyLines.slice(from, h.line + 25).join("\n"));
  });
  var mlines = mtext.split("\n");
  var mdetail = mhits.slice(0, 12).map(function (h) {
    return "\n    " + mrel + ":" + h.line + " [" + h.where + "] " +
           (mlines[h.line - 1] || "").trim().slice(0, 90);
  }).join("");
  ok(mhits.length === 0,
     mrel + " builds " + mhits.length + " unparenthesised chained " +
     "ternary/ies inside string literals — if that string reaches AE, " +
     "ExtendScript computes the wrong branch." + mdetail);
}

console.log((failed === 0 ? "PASS" : "FAIL") +
            ": " + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
