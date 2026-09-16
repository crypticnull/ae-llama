// The files a source-guard test should read: what git would COMMIT.
//
// MEASURED 2026-09-16: guards that walked the tree with readdirSync also
// read gitignored output -- `local/` (raw ANSI sweep logs, which turned
// test-source-control-chars red 3 of 4 on this machine while CI stayed
// green) and `scripts/web/` + `scripts/__pycache__/` (web assets a node
// pack writes on import, which three probe guards read and were green on
// only by luck). A guard that is red locally for a file nobody can commit
// teaches a pass to ignore a red test.
//
// listFiles(root, { under, exts, skipDirs }) returns absolute paths:
//   under    - repo-relative directory to restrict to ("scripts"), or none
//   exts     - Set/array of lower-case extensions (".js"), or none for all
//   skipDirs - Set/array of path segments to drop anywhere in the path
// Tracked files plus untracked-but-not-ignored ones (a file a pass is about
// to add is checked BEFORE it is added). When git is unavailable (a source
// zip) it falls back to a walk, and `.fromGit` on the result says which.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function toSet(v) { return v ? new Set(v) : null; }

function keep(rel, exts, skipDirs) {
  if (skipDirs && rel.split("/").some((part) => skipDirs.has(part))) return false;
  if (exts && !exts.has(path.extname(rel).toLowerCase())) return false;
  return true;
}

function fromGit(root, underRel, exts, skipDirs) {
  let out;
  try {
    const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
    if (underRel) args.push("--", underRel);
    out = execFileSync("git", args,
                       { cwd: root, encoding: "utf8",
                         stdio: ["ignore", "pipe", "ignore"],
                         maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { return null; }
  const seen = new Set();
  const list = [];
  for (const rel of out.split("\0")) {
    if (!rel || seen.has(rel)) continue;   // --cached + --others can repeat
    seen.add(rel);
    if (!keep(rel, exts, skipDirs)) continue;
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;    // deleted in the worktree, not staged
    list.push(full);
  }
  return list;
}

function fromWalk(root, underRel, exts, skipDirs) {
  const list = [];
  (function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      if (skipDirs && skipDirs.has(name)) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) walk(full);
      else if (!exts || exts.has(path.extname(name).toLowerCase())) list.push(full);
    }
  })(underRel ? path.join(root, underRel) : root);
  return list;
}

function listFiles(root, opts) {
  opts = opts || {};
  const underRel = opts.under ? String(opts.under).replace(/\\/g, "/") : "";
  const exts = toSet(opts.exts);
  const skipDirs = toSet(opts.skipDirs);
  const git = fromGit(root, underRel, exts, skipDirs);
  const list = git || fromWalk(root, underRel, exts, skipDirs);
  list.fromGit = !!git;
  return list;
}

// Repo-relative, forward-slashed paths among `files` that git IGNORES.
// Empty when none are (or git is unavailable). Asked of git per path, not
// of a hard-coded directory, so a new ignore rule needs no edit here.
function ignoredAmong(root, files) {
  if (!files.length) return [];
  let out = "";
  try {
    out = execFileSync("git", ["check-ignore", "--no-index", "--stdin"],
                       { cwd: root, encoding: "utf8",
                         input: files.map((f) => path.relative(root, f)
                                            .split(path.sep).join("/"))
                                     .join("\n") + "\n",
                         stdio: ["pipe", "pipe", "ignore"] });
  } catch (e) {
    // exit 1 means "none of them is ignored"; anything else is no answer
    out = (e.status === 1) ? "" : String(e.stdout || "");
  }
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

module.exports = { listFiles, ignoredAmong };
