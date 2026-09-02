// Regression test: every XML file in this repo must actually PARSE.
//
// THE FIELD FAILURE (2026-09-02, on the owner's machine):
//
//   <!-- SHAPE B -- ONE <Extension> ... -->
//
// An XML comment may not contain a double dash, and may not end with a
// dash (XML 1.0 section 2.5). All four probe manifests shipped with one.
// CEP does not report a parse error anywhere a user can see it: the
// extension is simply absent from Window > Extensions, which looks
// EXACTLY like a manifest whose shape or HostList the host rejected.
//
// So the wrong thing got blamed. The probe shipped two candidate
// manifest shapes precisely so the machine could choose between them,
// the panel did not appear, and the conclusion drawn was "shape A does
// not load" - a claim about Adobe. It was a typo in a comment, in BOTH
// shapes, and neither had ever been parsed. A whole diagnosis, a
// default swap and a round trip on the owner's machine came out of a
// character that Node can check in a millisecond.
//
// Hence this file. It is not about CEP: any .xml this repo ships or
// installs has to be well-formed, and the cost of finding out from an
// Adobe app instead is a full quit-and-relaunch cycle per attempt.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed++; }
  else console.log("ok  -", msg);
}

function xmlFiles(dir, out) {
  out = out || [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  entries.forEach(function (e) {
    if (e.name === "node_modules" || e.name === ".git" ||
        e.name === "dist") { return; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { xmlFiles(p, out); }
    else if (/\.xml$/i.test(e.name)) { out.push(p); }
  });
  return out;
}

/**
 * Minimal well-formedness check: comment legality, tag balance, and
 * attribute quoting. Node ships no XML parser, and pulling a dependency
 * into a repo that has none would cost more than it saves - but the
 * failure class that actually bit is comment legality, and tag balance
 * is the other one an editor introduces by hand.
 *
 * Returns [] when the file is clean, or a list of complaints.
 */
function checkXml(src, rel) {
  const problems = [];

  // --- comments (XML 1.0 s2.5: no "--" inside, may not end with "-")
  const comment = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = comment.exec(src)) !== null) {
    const line = src.slice(0, m.index).split("\n").length;
    const body = m[1];
    const dd = body.indexOf("-" + "-");
    if (dd !== -1) {
      const at = body.slice(Math.max(0, dd - 30), dd + 30)
        .replace(/\s+/g, " ").trim();
      problems.push("line " + line + ": comment contains a double dash, " +
                    "which XML forbids: ..." + at + "...");
    }
    if (/-$/.test(body)) {
      problems.push("line " + line + ": comment ends with a dash, which " +
                    "XML forbids");
    }
  }
  // An unterminated comment eats the rest of the document.
  const opens = (src.match(/<!--/g) || []).length;
  const closes = (src.match(/-->/g) || []).length;
  if (opens !== closes) {
    problems.push("unbalanced comment markers: " + opens + " <!-- vs " +
                  closes + " -->");
  }

  // --- tag balance, over a body with comments/prolog/CDATA removed
  const body = src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\?[\s\S]*?\?>/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ")
    .replace(/<!DOCTYPE[^>]*>/gi, " ");
  const stack = [];
  const tag = /<\s*(\/?)\s*([A-Za-z_][\w.:-]*)([^>]*?)(\/?)\s*>/g;
  while ((m = tag.exec(body)) !== null) {
    const closing = m[1] === "/";
    const name = m[2];
    const attrs = m[3];
    const selfClose = m[4] === "/";
    if (closing) {
      const top = stack.pop();
      if (top !== name) {
        problems.push("closing </" + name + "> does not match <" +
                      (top || "nothing") + ">");
      }
    } else if (!selfClose) {
      stack.push(name);
    }
    // Every attribute value must be quoted.
    const bare = /(\s[A-Za-z_][\w.:-]*)\s*=\s*([^"'\s>]+)/.exec(attrs);
    if (bare) {
      problems.push("<" + name + "> has an unquoted attribute value: " +
                    bare[0].trim());
    }
  }
  if (stack.length) {
    problems.push("unclosed element(s): " + stack.join(" > "));
  }
  return problems;
}

// ------------------------------------------------------------ the sweep
const files = xmlFiles(ROOT);
assert(files.length >= 4, "found " + files.length + " XML files to check");

files.forEach(function (f) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const problems = checkXml(fs.readFileSync(f, "utf8"), rel);
  assert(problems.length === 0,
         rel + " parses" + (problems.length ? ": " + problems.join("; ") : ""));
});

// ------------------------------------------- the checker itself works
{
  const bad = '<a>\n<!-- one ' + '-' + '- two -->\n</a>';
  assert(checkXml(bad, "x").length === 1,
         "the checker CATCHES the exact character that shipped");
  assert(/double dash/.test(checkXml(bad, "x")[0]),
         "and names it, rather than saying 'invalid XML': " +
         checkXml(bad, "x")[0]);

  assert(checkXml("<a>\n<!-- fine -->\n<b/>\n</a>", "x").length === 0,
         "a legal comment and a self-closing tag pass");
  assert(checkXml("<a><b></a>", "x").length > 0, "mismatched tags fail");
  assert(checkXml("<a><b/>", "x").length > 0, "an unclosed root fails");
  assert(checkXml('<a x=1/>', "x").length > 0,
         "an unquoted attribute value fails");
  assert(checkXml('<a x="1" y=\'2\'/>', "x").length === 0,
         "both quote styles pass");
  // "<a><!-- dash ---></a>": the non-greedy match ends at the LAST two
  // dashes, so the body is " dash -" and only the trailing-dash rule
  // fires. Writing the fixture with two dashes instead tests nothing,
  // which is how the first version of this assertion passed a checker
  // that had never seen the case.
  const trailing = checkXml("<a><!-- dash " + "---></a>", "x");
  assert(trailing.length === 1 && /ends with a dash/.test(trailing[0]),
         "a comment ending in a dash fails: " + (trailing[0] || "(not caught)"));
}

// --------------------------------------- CEP manifests carry the basics
{
  const manifests = files.filter(function (f) {
    return /CSXS[\\/]manifest[^\\/]*\.xml$/i.test(f);
  });
  assert(manifests.length >= 4,
         "found " + manifests.length + " CEP manifests (panel + probe shapes " +
         "+ harness)");
  manifests.forEach(function (f) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    const src = fs.readFileSync(f, "utf8");
    const bundleId = /ExtensionBundleId="([^"]+)"/.exec(src);
    const listed = (src.match(/<Extension\s+Id="([^"]+)"\s+Version=/g) || []);
    const dispatched = (src.match(/<Extension\s+Id="([^"]+)"\s*>/g) || []);
    assert(!!bundleId, rel + " declares an ExtensionBundleId");
    assert(listed.length > 0, rel + " lists at least one <Extension>");
    assert(dispatched.length === listed.length,
           rel + " dispatches every extension it lists (" +
           dispatched.length + " vs " + listed.length + ")");
    assert(/<Host\s+Name="/.test(src), rel + " names at least one host");
  });
}

console.log(failed ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
process.exitCode = failed ? 1 : 0;
