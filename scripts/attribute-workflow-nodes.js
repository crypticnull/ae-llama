#!/usr/bin/env node
/*
 * attribute-workflow-nodes.js -- who ships every node a workflow uses?
 *
 * A bundled workflow is only installable if the manifest next to it names
 * every pack the graph needs. Guessing that list from memory is how the H3
 * i2v manifest ended up missing ComfyUI-sol-attn and ComfyLiterals while
 * the shipped API template used both: the graph would simply not load on a
 * machine that had neither, and nothing in the repo said so.
 *
 * So do not guess. A running ComfyUI answers /object_info with a
 * `python_module` per class, which is the loader's own record of where the
 * class came from -- "nodes" or "comfy_extras.*" for core, and
 * "custom_nodes.<folder>" for a pack. The folder name then resolves to a
 * repo URL from that pack's own .git/config or pyproject.toml.
 *
 * Usage:
 *   node scripts/attribute-workflow-nodes.js [opts] <workflow.json> ...
 *
 *   --url <base>          running ComfyUI (default http://127.0.0.1:8188)
 *   --object-info <file>  read a saved /object_info dump instead of fetching
 *   --nodes-root <dir>    custom_nodes dir to resolve repos from (repeatable;
 *                         also read from COMFY_NODES_ROOT, ';'-separated)
 *   --json                print the manifest customNodes/frontendOnly blocks
 *   --write               splice those blocks into <workflow>.manifest.json,
 *                         preserving every other byte of the file
 *
 * --write MERGES: an existing entry for the same pack keeps its note, its
 * `optional` flag and its repo when the disk has none. Only the `nodes` list
 * is replaced by what was measured. Curated prose survives; stale prose is
 * still yours to fix by hand.
 *
 * Both workflow formats are accepted -- the authored UI format (a `nodes`
 * array of `type`) and the adapted API format (an object of `class_type`) --
 * and UI subgraph definitions are recursed into, because a subgraph's inner
 * nodes are dependencies exactly like any other.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

// The ComfyUI frontend draws these; the backend has never heard of them, so
// they are absent from /object_info and that absence is CORRECT, not a
// missing install. Anything else absent is reported as unresolved.
var KNOWN_VIRTUAL = {
  'Note': 'core frontend annotation node',
  'MarkdownNote': 'core frontend annotation node',
  'Reroute': 'core frontend wire helper',
  'PrimitiveNode': 'core frontend widget proxy',
  'Label (rgthree)': 'rgthree-comfy frontend-only canvas label',
  'Fast Groups Bypasser (rgthree)': 'rgthree-comfy frontend-only group toggle'
};

function fail(msg) {
  console.error('attribute-workflow-nodes: ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  var opts = { url: 'http://127.0.0.1:8188', objectInfo: null, roots: [],
               json: false, write: false, files: [] };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--url') opts.url = argv[++i];
    else if (a === '--object-info') opts.objectInfo = argv[++i];
    else if (a === '--nodes-root') opts.roots.push(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--write') opts.write = true;
    else if (a.charAt(0) === '-') fail('unknown option ' + a);
    else opts.files.push(a);
  }
  if (!opts.files.length) fail('no workflow file given');
  return opts;
}

function defaultRoots() {
  var roots = [];
  if (process.env.COMFY_NODES_ROOT) {
    process.env.COMFY_NODES_ROOT.split(';').forEach(function (r) {
      if (r.trim()) roots.push(r.trim());
    });
  }
  var home = process.env.USERPROFILE || process.env.HOME || '';
  var local = process.env.LOCALAPPDATA || '';
  if (home) roots.push(path.join(home, 'Documents', 'ComfyUI', 'custom_nodes'));
  if (local) {
    roots.push(path.join(local, 'Comfy-Desktop', 'ComfyUI-Installs',
                         'ComfyUI', 'ComfyUI', 'custom_nodes'));
  }
  return roots;
}

function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    var mod = url.indexOf('https:') === 0 ? https : http;
    var req = mod.get(url, function (res) {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(url + ' -> HTTP ' + res.statusCode));
      }
      var buf = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { buf += d; });
      res.on('end', function () {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('bad JSON from ' + url + ': ' + e.message)); }
      });
    });
    req.on('error', function (e) {
      reject(new Error('cannot reach ' + url + ' (' + e.message + '). Start ' +
                       'ComfyUI, or pass --object-info <saved dump>.'));
    });
    req.setTimeout(180000, function () {
      req.destroy(new Error('timed out after 180s'));
    });
  });
}

/* ---- workflow -> the set of class names it needs ---------------------- */

function classesOf(file) {
  var wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  var seen = Object.create(null);   // class -> count
  var subgraphIds = Object.create(null);
  var defs = (wf.definitions && wf.definitions.subgraphs) || [];
  defs.forEach(function (s) { subgraphIds[String(s.id)] = s; });

  function addNodes(nodes, where) {
    (nodes || []).forEach(function (n) {
      var t = n.type || n.class_type;
      if (!t) return;
      if (subgraphIds[t]) {
        // A subgraph node is a container. Its inner nodes are dependencies
        // just like any other; the container itself is not a class.
        var sub = subgraphIds[t];
        addNodes(sub.nodes, (sub.name || t));
        return;
      }
      seen[t] = (seen[t] || 0) + 1;
    });
    void where;
  }

  if (Array.isArray(wf.nodes)) addNodes(wf.nodes, 'graph');
  else addNodes(Object.keys(wf).map(function (k) { return wf[k]; }), 'api');

  return Object.keys(seen).sort(function (a, b) {
    return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
  });
}

/* ---- pack folder -> repo URL ----------------------------------------- */

var repoCache = Object.create(null);

function repoForPack(pack, roots) {
  if (pack in repoCache) return repoCache[pack];
  var found = null;
  for (var i = 0; i < roots.length && !found; i++) {
    var root = roots[i];
    var entries;
    try { entries = fs.readdirSync(root); } catch (e) { continue; }
    for (var j = 0; j < entries.length; j++) {
      // python_module casing does not always match the folder on disk.
      if (entries[j].toLowerCase() === pack.toLowerCase()) {
        found = path.join(root, entries[j]);
        break;
      }
    }
  }
  var url = null;
  if (found) {
    try {
      var cfg = fs.readFileSync(path.join(found, '.git', 'config'), 'utf8');
      var m = /^\s*url\s*=\s*(\S+)/m.exec(cfg);
      if (m) url = m[1];
    } catch (e) { /* not a git checkout */ }
    if (!url) {
      try {
        var py = fs.readFileSync(path.join(found, 'pyproject.toml'), 'utf8');
        var p = /^\s*(?:Repository|repository|homepage|Homepage)\s*=\s*"([^"]+)"/m.exec(py);
        if (p) url = p[1];
      } catch (e) { /* no pyproject */ }
    }
  }
  if (url) url = url.replace(/\.git$/, '');
  repoCache[pack] = url;
  return url;
}

/* ---- attribution ------------------------------------------------------ */

function attribute(classes, objectInfo, roots) {
  var packs = Object.create(null);   // pack -> [class]
  var core = [];
  var virtual = [];
  var unresolved = [];

  classes.forEach(function (c) {
    var def = objectInfo[c];
    if (!def) {
      if (KNOWN_VIRTUAL[c]) virtual.push({ type: c, note: KNOWN_VIRTUAL[c] });
      else unresolved.push(c);
      return;
    }
    var mod = def.python_module || '';
    if (mod === 'nodes' || mod.indexOf('comfy_extras.') === 0) {
      core.push(c);
      return;
    }
    if (mod.indexOf('custom_nodes.') === 0) {
      var pack = mod.slice('custom_nodes.'.length);
      (packs[pack] || (packs[pack] = [])).push(c);
      return;
    }
    unresolved.push(c + ' (python_module "' + mod + '")');
  });

  var entries = Object.keys(packs).sort(function (a, b) {
    return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
  }).map(function (pack) {
    return { pack: pack, repo: repoForPack(pack, roots), nodes: packs[pack].sort() };
  });
  if (core.length) entries.push({ pack: '(comfy-core)', nodes: core.sort() });

  return { customNodes: entries, frontendOnly: virtual, unresolved: unresolved };
}

/* ---- manifest merge + splice ------------------------------------------ */

function manifestPathFor(file) {
  return file.replace(/\.json$/i, '.manifest.json');
}

function mergeWithExisting(entries, existing) {
  var byPack = Object.create(null);
  (existing || []).forEach(function (e) {
    if (e && e.pack) byPack[String(e.pack).toLowerCase()] = e;
  });
  return entries.map(function (e) {
    var old = byPack[e.pack.toLowerCase()];
    var out = { pack: e.pack };
    if (e.repo) out.repo = e.repo;
    else if (old && old.repo) out.repo = old.repo;
    out.nodes = e.nodes;
    if (old && old.optional) out.optional = old.optional;
    if (old && old.note) out.note = old.note;
    return out;
  });
}

/*
 * Replace one top-level "key": [...] block in the raw text, leaving every
 * other byte alone. A JSON round-trip would reflow the whole file and
 * un-escape the — sequences in the enhancer instructions, turning a
 * three-line change into an unreviewable diff.
 */
function spliceBlock(text, key, valueText) {
  var needle = '"' + key + '":';
  var at = text.indexOf(needle);
  if (at < 0) return null;
  var open = text.indexOf('[', at + needle.length);
  if (open < 0) return null;
  var depth = 0, inStr = false, esc = false, end = -1;
  for (var i = open; i < text.length; i++) {
    var ch = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  return text.slice(0, open) + valueText + text.slice(end);
}

function indentJson(value, spaces) {
  return JSON.stringify(value, null, 2).split('\n').join('\n' + spaces);
}

/* ---- main ------------------------------------------------------------- */

function report(file, result) {
  console.log('');
  console.log('=== ' + file);
  result.customNodes.forEach(function (e) {
    var head = e.pack === '(comfy-core)' ? e.pack
             : e.pack + (e.repo ? '  ' + e.repo : '  (repo NOT resolved on this disk)');
    console.log('  ' + head);
    e.nodes.forEach(function (n) { console.log('      ' + n); });
  });
  if (result.frontendOnly.length) {
    console.log('  (frontend-only, never reaches the server)');
    result.frontendOnly.forEach(function (v) {
      console.log('      ' + v.type + ' -- ' + v.note);
    });
  }
  if (result.unresolved.length) {
    console.log('  !! UNRESOLVED -- absent from /object_info and not a known');
    console.log('     frontend node, so this pack is NOT INSTALLED here:');
    result.unresolved.forEach(function (u) { console.log('      ' + u); });
  }
}

function main() {
  var opts = parseArgs(process.argv.slice(2));
  var roots = opts.roots.length ? opts.roots : defaultRoots();

  var load = opts.objectInfo
    ? Promise.resolve(JSON.parse(fs.readFileSync(opts.objectInfo, 'utf8')))
    : fetchJson(opts.url.replace(/\/+$/, '') + '/object_info');

  return load.then(function (objectInfo) {
    var anyUnresolved = false;
    opts.files.forEach(function (file) {
      var result = attribute(classesOf(file), objectInfo, roots);
      report(file, result);
      if (result.unresolved.length) anyUnresolved = true;

      var mf = manifestPathFor(file);
      var raw = null;
      try { raw = fs.readFileSync(mf, 'utf8'); } catch (e) { /* none */ }
      var existing = raw ? (JSON.parse(raw).customNodes || []) : [];
      var merged = mergeWithExisting(result.customNodes, existing);

      if (opts.json) {
        console.log('  --- manifest blocks ---');
        console.log('  "customNodes": ' + indentJson(merged, '  ') + ',');
        console.log('  "frontendOnly": ' + indentJson(result.frontendOnly, '  '));
      }

      if (opts.write) {
        if (!raw) fail('no manifest at ' + mf);
        var next = spliceBlock(raw, 'customNodes', indentJson(merged, '  '));
        if (next === null) fail('no "customNodes": [...] block in ' + mf);
        if (result.frontendOnly.length) {
          var fo = spliceBlock(next, 'frontendOnly', indentJson(result.frontendOnly, '  '));
          if (fo === null) {
            // No block yet -- add one right after customNodes.
            var marker = indentJson(merged, '  ');
            var pos = next.indexOf(marker) + marker.length;
            fo = next.slice(0, pos) + ',\n  "frontendOnly": ' +
                 indentJson(result.frontendOnly, '  ') + next.slice(pos);
          }
          next = fo;
        }
        JSON.parse(next);   // never write a manifest that does not parse
        // Keep the file's own line endings: a checkout with core.autocrlf
        // is CRLF on disk, and splicing LF-only lines in leaves it mixed.
        if (raw.indexOf('\r\n') >= 0) next = next.replace(/\r?\n/g, '\r\n');
        fs.writeFileSync(mf, next);
        console.log('  wrote ' + mf);
      }
    });
    if (anyUnresolved) process.exitCode = 2;
  });
}

// Required as a module by tests/test-workflow-manifests.js, which checks the
// checked-in manifests against this same enumerator -- so the test cannot
// drift from the tool that wrote them.
module.exports = {
  KNOWN_VIRTUAL: KNOWN_VIRTUAL,
  classesOf: classesOf,
  attribute: attribute,
  mergeWithExisting: mergeWithExisting,
  manifestPathFor: manifestPathFor,
  spliceBlock: spliceBlock
};

if (require.main === module) main().catch(function (e) { fail(e.message); });
