/*
 * probe-store-root.js — where a chat-probe run keeps its memory store
 * (WORKPLAN §15 item 3, memory-layer-REFINED §9).
 *
 * The memory store does not exist yet. When it ships it takes `opts.root`,
 * and a probe that let it default would write into the OWNER'S store: the
 * seeded-store rows would seed it permanently, and under conditional
 * injection every other row's prompt would change with whatever it held.
 * The 770/770 baseline would stop being reproducible the day memory ships.
 * So the probe resolves its root here, BEFORE anything could write, and
 * prints where it came from the way reportSettingsOrigin prints settings.
 *
 *   default          a fresh temp folder, removed at exit (kept with --keep)
 *   --store-root D   that folder, created if missing, never removed
 *
 * A --store-root inside the panel's data folder is REFUSED: that folder is
 * where the owner's store will live, and a probe must not be able to write
 * into the product it measures. No flag overrides it, on purpose.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const TEMP_PREFIX = "aell-probe-store-";

function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

/** True when `child` is `parent` or anywhere under it (case-insensitive). */
function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = norm(child), p = norm(parent);
  return c === p || c.indexOf(p + "/") === 0 || c.indexOf(p + "\\") === 0;
}

/**
 * resolve({ storeRoot, dataRoot }, deps) ->
 *   { ok: true, root, from: "temp"|"--store-root", temp: bool }
 *   { ok: false, error }
 * deps: { fs, tmpdir } for tests.
 */
function resolve(opt, deps) {
  const f = (deps && deps.fs) || fs;
  const tmp = (deps && deps.tmpdir) || os.tmpdir();
  opt = opt || {};
  if (opt.storeRoot === "" || opt.storeRoot === true ||
      (opt.storeRoot != null && /^--/.test(String(opt.storeRoot)))) {
    return { ok: false, error: "--store-root wants a folder path" };
  }
  if (opt.storeRoot != null) {
    const root = path.resolve(String(opt.storeRoot));
    if (isInside(root, opt.dataRoot)) {
      return { ok: false, error: "--store-root " + root + " is inside the " +
               "panel's data folder (" + opt.dataRoot + "), where the " +
               "owner's store lives. A probe must not write there; pick a " +
               "folder outside it, or omit the flag for a temp store." };
    }
    try {
      f.mkdirSync(root, { recursive: true });
    } catch (e) {
      return { ok: false, error: "--store-root " + root +
               " cannot be created: " + e.message };
    }
    return { ok: true, root: root, from: "--store-root", temp: false };
  }
  const root = f.mkdtempSync(path.join(tmp, TEMP_PREFIX));
  return { ok: true, root: root, from: "temp", temp: true };
}

/** The provenance lines, printed beside `settings :` in the transcript. */
function describe(r, keep) {
  if (!r.ok) return ["store      : REFUSED — " + r.error];
  const fate = r.temp ? (keep ? "temp, kept (--keep)" : "temp, removed at exit")
                      : "--store-root, never removed";
  return ["store      : " + r.root + " (" + fate + ")"];
}

/** Removes a TEMP root the probe made. Anything else is left alone. */
function cleanup(r, keep, deps) {
  const f = (deps && deps.fs) || fs;
  if (!r || !r.ok || !r.temp || keep) return false;
  if (path.basename(r.root).indexOf(TEMP_PREFIX) !== 0) return false;
  try { f.rmSync(r.root, { recursive: true, force: true }); return true; }
  catch (e) { return false; }
}

module.exports = { resolve, describe, cleanup, isInside, TEMP_PREFIX };
