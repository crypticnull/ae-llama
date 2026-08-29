#!/usr/bin/env node
/*
 * workflow-hash-history.js — maintain the append-only record of every
 * version of every bundled ComfyUI template the panel has ever shipped.
 *
 *   node scripts/workflow-hash-history.js            # append current hashes
 *   node scripts/workflow-hash-history.js --from-git # + every version in git
 *   node scripts/workflow-hash-history.js --check    # exit 1 if a bundled
 *                                                    #   file is unrecorded
 *   ... --dir <folder>                               # operate on another
 *                                                    #   bundle (tests)
 *
 * Why this file exists: `ensureDataDirs` seeds bundled templates into
 * %APPDATA%\AE-Llama\comfy-workflows and — before this — refused to
 * overwrite anything already there, so a machine that installed the panel
 * once kept its first copy forever. On the development machine that meant
 * the H3 i2v template and manifest were still the versions shipped five
 * releases earlier, missing the removal rules and the corrected
 * attribution. Simply overwriting would be worse: a user is invited to
 * edit these templates, and their edits must survive an update.
 *
 * The history tells the two cases apart. If the installed file's hash is
 * one WE ever shipped, it is an unedited (possibly stale) shipped copy and
 * may be refreshed. If the hash is unknown, a human changed it and the
 * panel never touches it. Append-only: a hash is never removed, because
 * some install out there is still sitting on that exact byte sequence.
 *
 * tests/test-workflow-hash-history.js runs --check, so CI fails when a
 * bundled template changes without its new hash being recorded — an
 * unrecorded hash would make every stale install look "user-edited" and
 * silently re-freeze the bug this whole mechanism exists to fix.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DEFAULT_DIR = path.join(ROOT, "extension", "comfy-workflows");
const HISTORY_NAME = ".hash-history.json";

/**
 * sha1 of the file's bytes with CRLF normalized to LF.
 *
 * Git checks these text files out with the platform's line endings, so the
 * raw bytes on a Windows working tree and the bytes of the same blob in
 * `git show` differ. Hashing raw bytes would record hashes no installed
 * file ever matches on one of the two platforms. Both sides of every
 * comparison use this function, so the normalization is consistent; the
 * only cost is that two files differing ONLY by line ending are treated as
 * the same version, which for these JSON/markdown templates is true.
 */
function hashBuffer(buf) {
  const norm = Buffer.from(buf).toString("latin1").replace(/\r\n/g, "\n");
  return crypto.createHash("sha1").update(norm, "latin1").digest("hex");
}

function hashFile(p) { return hashBuffer(fs.readFileSync(p)); }

/** The files a bundle seeds: real files, no dotfiles, no subdirectories. */
function bundledFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (name) {
    if (name.charAt(0) === ".") return false;
    return fs.statSync(path.join(dir, name)).isFile();
  }).sort();
}

function historyPath(dir) { return path.join(dir, HISTORY_NAME); }

function loadHistory(dir) {
  const p = historyPath(dir);
  if (!fs.existsSync(p)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { throw new Error(HISTORY_NAME + " is not valid JSON: " + e.message); }
  if (!j || typeof j !== "object" || !j.files || typeof j.files !== "object") {
    throw new Error(HISTORY_NAME + " has no `files` object");
  }
  return j;
}

function emptyHistory() {
  return {
    note: "Append-only sha1 (CRLF-normalized) of every version of each " +
          "bundled ComfyUI template this panel has shipped. setup.js's " +
          "ensureDataDirs refreshes an installed copy only when its hash " +
          "appears here (an unedited shipped copy); an unknown hash is a " +
          "user edit and is never overwritten. Regenerate with " +
          "`node scripts/workflow-hash-history.js`. Never delete entries.",
    algorithm: "sha1 of file bytes with CRLF normalized to LF",
    files: {}
  };
}

/**
 * Every version of `relPath` recorded in git, oldest first.
 *
 * `--all --full-history` deliberately: the panel ships from the dev branch
 * as well as main (a push to `claude/**` publishes a feed), and plain
 * `git log -- path` applies history simplification — it listed one commit
 * for the H3 template where the full history has three. Those three turned
 * out to hold identical bytes, so nothing was lost this time, but a
 * version missing here is an install we would misread as user-edited
 * forever, and that is not a risk worth taking to save two seconds.
 */
function gitVersions(relPath) {
  const log = spawnSync("git",
                        ["log", "--all", "--full-history", "--format=%H",
                         "--", relPath],
                        { cwd: ROOT, encoding: "utf8" });
  if (log.status !== 0) return [];
  const commits = String(log.stdout || "").split(/\r?\n/)
    .filter(function (s) { return s.length > 0; }).reverse();
  const out = [];
  for (const c of commits) {
    const show = spawnSync("git", ["show", c + ":" + relPath],
                           { cwd: ROOT, encoding: "buffer" });
    if (show.status !== 0 || !show.stdout) continue;  // deleted in that commit
    out.push(hashBuffer(show.stdout));
  }
  return out;
}

function appendUnique(list, hash) {
  if (list.indexOf(hash) === -1) { list.push(hash); return true; }
  return false;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.indexOf("--check") !== -1;
  const fromGit = argv.indexOf("--from-git") !== -1;
  const dirAt = argv.indexOf("--dir");
  const dir = dirAt !== -1 ? path.resolve(argv[dirAt + 1]) : DEFAULT_DIR;
  const relDir = path.relative(ROOT, dir).split(path.sep).join("/");

  const files = bundledFiles(dir);
  if (!files.length) {
    console.error("No bundled files in " + dir);
    process.exitCode = 1;
    return;
  }

  if (check) {
    let history;
    try { history = loadHistory(dir); }
    catch (e) { console.error(e.message); process.exitCode = 1; return; }
    if (!history) {
      console.error("Missing " + path.join(dir, HISTORY_NAME) +
                    " - run: node scripts/workflow-hash-history.js");
      process.exitCode = 1;
      return;
    }
    const missing = [];
    for (const name of files) {
      const h = hashFile(path.join(dir, name));
      const seen = history.files[name] || [];
      if (seen.indexOf(h) === -1) missing.push(name + " (" + h + ")");
    }
    if (missing.length) {
      console.error("Bundled template(s) changed without recording the new " +
                    "hash:\n  " + missing.join("\n  ") +
                    "\nRun: node scripts/workflow-hash-history.js");
      process.exitCode = 1;
      return;
    }
    console.log("hash history covers all " + files.length + " bundled files");
    return;
  }

  const history = loadHistory(dir) || emptyHistory();
  let added = 0;
  for (const name of files) {
    const list = history.files[name] || (history.files[name] = []);
    if (fromGit) {
      for (const h of gitVersions(relDir + "/" + name)) {
        if (appendUnique(list, h)) added++;
      }
    }
    if (appendUnique(list, hashFile(path.join(dir, name)))) added++;
  }
  fs.writeFileSync(historyPath(dir),
                   JSON.stringify(history, null, 2) + "\n");
  console.log("hash history: " + files.length + " files, " + added +
              " new hash(es) recorded" + (fromGit ? " (git history walked)" : ""));
}

if (require.main === module) main();

module.exports = { hashBuffer, hashFile, bundledFiles, HISTORY_NAME };
