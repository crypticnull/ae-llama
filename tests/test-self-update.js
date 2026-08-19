// Regression test: panel self-update (setup.js) against REAL git repos.
// Covers: install-kind detection (git vs package), git-pull update,
// already-up-to-date, ff-only divergence refusal, and the package-install
// path's no-URL guidance. Runs on Linux and the Windows CI runner alike.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// ------------------------------------------------------------ fixture repos

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aell-upd-"));
const originDir = path.join(tmp, "origin.git");
const seedDir = path.join(tmp, "seed");
const workDir = path.join(tmp, "work");

fs.mkdirSync(originDir);
execFileSync("git", ["init", "--bare", "-b", "main", originDir], { encoding: "utf8" });

fs.mkdirSync(path.join(seedDir, "extension"), { recursive: true });
execFileSync("git", ["init", "-b", "main", seedDir], { encoding: "utf8" });
sh(seedDir, "config", "user.email", "test@test");
sh(seedDir, "config", "user.name", "test");
fs.writeFileSync(path.join(seedDir, "extension", "version.txt"), "v1");
sh(seedDir, "add", "-A");
sh(seedDir, "commit", "-m", "v1");
sh(seedDir, "remote", "add", "origin", originDir);
sh(seedDir, "push", "origin", "main");

execFileSync("git", ["clone", originDir, workDir], { encoding: "utf8" });
sh(workDir, "config", "user.email", "test@test");
sh(workDir, "config", "user.name", "test");

// package-install fixture: extension folder with no git repo above it
const pkgExt = path.join(tmp, "pkg", "extension");
fs.mkdirSync(pkgExt, { recursive: true });

// ------------------------------------------------------------ panel stubs

let extPath = path.join(workDir, "extension");
const window = {
  AEBridge: {
    nodeRequire: require,
    getExtensionPath: () => extPath
  },
  Settings: { dataRoot: () => tmp, get: () => ({}) },
  AELL: { UPDATE_MANIFEST_URL: "", FALLBACK_STARTER_MODEL: {} },
  Llama: {},
  setInterval, clearInterval, setTimeout, clearTimeout
};

eval(fs.readFileSync(path.join(__dirname, "..", "extension", "js", "setup.js"), "utf8"));
const Setup = window.Setup;

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("ok  -", msg);
}
function install(manifest) {
  return new Promise(resolve =>
    Setup.installUpdate(manifest, null, (err, res) => resolve({ err, res })));
}

(async () => {
  // 1. install-kind detection
  const kindGit = Setup.detectInstallKind();
  assert(kindGit.kind === "git", "junctioned repo checkout detected as git install");
  assert(fs.existsSync(path.join(kindGit.repoRoot, ".git")),
         "repoRoot points at the git checkout");

  extPath = pkgExt;
  assert(Setup.detectInstallKind().kind === "package",
         "extracted-ZXP layout detected as package install");
  extPath = path.join(workDir, "extension");

  // 2. update published upstream -> git pull applies it
  fs.writeFileSync(path.join(seedDir, "extension", "version.txt"), "v2");
  sh(seedDir, "add", "-A");
  sh(seedDir, "commit", "-m", "v2");
  sh(seedDir, "push", "origin", "main");

  let r = await install({});
  assert(!r.err && r.res.changed === true,
         "git-install update pulls the new commit" + (r.err ? " -> " + r.err.message : ""));
  assert(fs.readFileSync(path.join(workDir, "extension", "version.txt"), "utf8") === "v2",
         "working copy actually updated to v2");

  // 3. nothing new -> reported as unchanged
  r = await install({});
  assert(!r.err && r.res.changed === false, "second run reports already up to date");

  // 4. package install without a panelPackageUrl -> actionable error
  extPath = pkgExt;
  r = await install({ panelUrl: "https://example.com/product" });
  assert(r.err && /no direct install package/i.test(r.err.message) &&
         /example\.com/.test(r.err.message),
         "package install without panelPackageUrl points at the store page");
  extPath = path.join(workDir, "extension");

  // 5. local divergence -> ff-only refuses instead of clobbering
  fs.writeFileSync(path.join(workDir, "extension", "local.txt"), "local work");
  sh(workDir, "add", "-A");
  sh(workDir, "commit", "-m", "local divergence");
  fs.writeFileSync(path.join(seedDir, "extension", "version.txt"), "v3");
  sh(seedDir, "add", "-A");
  sh(seedDir, "commit", "-m", "v3");
  sh(seedDir, "push", "origin", "main");

  r = await install({});
  assert(r.err && /git pull failed/i.test(r.err.message),
         "diverged dev repo refuses to auto-update (ff-only): " +
         (r.err ? r.err.message.slice(0, 80) : "no error"));
  assert(fs.existsSync(path.join(workDir, "extension", "local.txt")),
         "local work untouched after refused update");

  console.log(process.exitCode ? "\nTESTS FAILED" : "\nALL TESTS PASSED");
})();
