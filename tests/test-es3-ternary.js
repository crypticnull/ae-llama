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

console.log((failed === 0 ? "PASS" : "FAIL") +
            ": " + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
