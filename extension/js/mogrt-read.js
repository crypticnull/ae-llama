/*
 * mogrt-read.js — zero-dependency .mogrt (zip) reader and roster checker.
 *
 * A .mogrt is a zip archive: definition.json (Adobe's controller roster)
 * plus an embedded project and any media the comp used. export_mogrt
 * writes one and, before this file, never opened it: bytes on disk plus
 * a file that exists were the whole verdict. This module is the
 * independent instrument (docs/SELF-VERIFY-PLANS.md, section 1): it
 * parses the container itself, so the code that produced the file never
 * grades its own output.
 *
 * Runs in two hosts from one file:
 *   - Node (scripts/, tests/): `module.exports` — fs/zlib via require.
 *   - CEP panel (extension/index.html): `window.MogrtRead` — fs/zlib
 *     via AEBridge.nodeRequire, because bare require is not the panel's
 *     Node. CEP's bundled Node is old: zlib.crc32 does not exist there,
 *     so the CRC table is hand-rolled below; inflateRawSync does exist.
 *     ES5 only — no const/let/arrows/template literals.
 *
 * I/O is WINDOWED, never a whole-file read: fs.readFileSync throws
 * ERR_FS_FILE_TOO_LARGE above 2^31-1 bytes, and a media-heavy capsule
 * can pass that. The reader opens an fd and pulls: the tail window
 * (EOCD + up to a 65535-byte comment), the central directory slice, then
 * per entry the local header (30 bytes + name/extra) and the compressed
 * body ONLY when that entry is verified. In definitionOnly mode the only
 * body read is definition.json's.
 *
 * Two operating modes, one parser:
 *   - full: every entry inflated and CRC-checked (probe + tests).
 *   - definitionOnly: EOCD + central directory + local headers are read
 *     for every entry, but ONLY definition.json is inflated. This is the
 *     shipped in-panel post-export check; a media-heavy capsule inflated
 *     on the CEP thread would freeze the panel.
 *
 * Result fields that carry a verdict:
 *   readable  false when the file could not be opened or read at all
 *             (ENOENT, EBUSY, a short read) — the export is unjudged.
 *   ok        true when the file was read and nothing failed.
 *   zipValid  (verifyExport) reserved for a file that WAS read: false
 *             means it is not a valid zip; null when readable is false.
 *
 * Every failure is a grounded sentence naming the entry, the offset or
 * the number measured — the local model and the overnight log both read
 * these verbatim.
 */
(function (root, factory) {
  "use strict";
  var hasModule = typeof module === "object" && module &&
                  typeof module.exports === "object";
  var api = factory(function (name) {
    // Panel first: AEBridge is the only sanctioned route to CEP's Node.
    if (root && root.AEBridge &&
        typeof root.AEBridge.nodeRequire === "function") {
      return root.AEBridge.nodeRequire(name);
    }
    if (typeof require === "function") return require(name);
    throw new Error("mogrt-read: no Node require available for " + name);
  });
  if (hasModule) module.exports = api;
  if (typeof window !== "undefined") window.MogrtRead = api;
})(typeof window !== "undefined" ? window : null, function (nodeRequire) {
  "use strict";

  var fs = null, zlib = null, NodeBuffer = null;
  function ensureNode() {
    if (fs) return;
    fs = nodeRequire("fs");
    zlib = nodeRequire("zlib");
    NodeBuffer = nodeRequire("buffer").Buffer;
  }

  // ------------------------------------------------------------ CRC-32
  // IEEE 802.3 polynomial, reflected (0xEDB88320) — the zip CRC. Table
  // built once on first use.
  var CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var t = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }
  function crc32(buf) {
    var t = crcTable();
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) {
      c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ------------------------------------------------------ zip constants
  var SIG_LOCAL = 0x04034b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_EOCD = 0x06054b50;
  var EOCD_MIN = 22;
  var ZIP_COMMENT_MAX = 0xFFFF;
  var LOCAL_FIXED = 30;
  var CENTRAL_FIXED = 46;
  var FLAG_ENCRYPTED = 0x0001;
  var FLAG_DESCRIPTOR = 0x0008;   // bit 3: sizes/CRC live after the data
  var FLAG_UTF8 = 0x0800;         // bit 11: name bytes are UTF-8
  var METHOD_STORED = 0;
  var METHOD_DEFLATE = 8;
  var DEFINITION_NAME = "definition.json";
  var DEFAULT_MAX_INFLATE = 64 * 1024 * 1024;
  // The central directory is held in memory whole; 65535 entries with
  // ordinary names fit in a few MiB, so a size above this is a defect.
  var CENTRAL_DIR_CAP = 256 * 1024 * 1024;

  function hex(n) { return "0x" + (n >>> 0).toString(16); }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  function decodeName(bytes, utf8) {
    // Bit 11 clear means CP437 by the spec; latin1 keeps every byte
    // addressable so a mismatch against the central name still shows.
    return bytes.toString(utf8 ? "utf8" : "latin1");
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // --------------------------------------------------------- sources
  // {length, read(offset, len) -> Buffer, close()}. A read failure is
  // thrown with `.aellRead = true` so readMogrt can answer readable:false
  // instead of a verdict about the zip.
  function readFailure(msg) {
    var err = new Error(msg);
    err.aellRead = true;
    return err;
  }

  function bufferSource(buf) {
    return {
      length: buf.length,
      read: function (offset, len) { return buf.slice(offset, offset + len); },
      close: function () {}
    };
  }

  function fileSource(path) {
    var fd;
    try {
      fd = fs.openSync(path, "r");
    } catch (err) {
      throw readFailure("cannot open " + path + ": " +
        String(err && err.message || err));
    }
    var size, st;
    try {
      st = fs.fstatSync(fd);
      size = st.size;
    } catch (err2) {
      try { fs.closeSync(fd); } catch (ignore) {}
      throw readFailure("cannot stat " + path + ": " +
        String(err2 && err2.message || err2));
    }
    // Windows opens a DIRECTORY handle without complaint and fstat
    // reports it as 0 bytes (measured on windows-latest CI 2026-09-01);
    // Linux only fails at the first read. A directory is unreadable as
    // a capsule, never a "0-byte zip" verdict.
    if (st && typeof st.isDirectory === "function" && st.isDirectory()) {
      try { fs.closeSync(fd); } catch (ignore2) {}
      throw readFailure("cannot read " + path + ": it is a directory, " +
        "not a .mogrt file");
    }
    return {
      length: size,
      read: function (offset, len) {
        var out = NodeBuffer.alloc(len);
        var got = 0;
        try {
          while (got < len) {
            var n = fs.readSync(fd, out, got, len - got, offset + got);
            if (n <= 0) break;
            got += n;
          }
        } catch (err3) {
          throw readFailure("cannot read " + len + " bytes at offset " +
            offset + " of " + path + ": " + String(err3 && err3.message || err3));
        }
        if (got !== len) {
          throw readFailure("short read at offset " + offset + " of " + path +
            ": wanted " + len + " bytes, got " + got + " (file is " + size +
            " bytes; changed underneath the reader?)");
        }
        return out;
      },
      close: function () { try { fs.closeSync(fd); } catch (ignore) {} }
    };
  }

  // ------------------------------------------------------------- EOCD
  // Scan the tail window backwards for the EOCD signature. A trailing
  // archive comment (up to 65535 bytes) can sit after it, and a comment
  // can itself contain a self-consistent fake record, so a candidate
  // wins only when (a) its comment length reaches end-of-file exactly
  // and (b) its cdOffset points at a central-directory signature. With
  // no candidate satisfying (b) — a ZIP64 sentinel offset, or a broken
  // archive — the first length-consistent one is reported so the
  // grounded error names what was found there.
  function parseEocdAt(tail, pos, base) {
    return {
      offset: base + pos,
      diskNumber: u16(tail, pos + 4),
      cdDisk: u16(tail, pos + 6),
      entriesOnDisk: u16(tail, pos + 8),
      entriesTotal: u16(tail, pos + 10),
      cdSize: u32(tail, pos + 12),
      cdOffset: u32(tail, pos + 16),
      commentLen: u16(tail, pos + 20)
    };
  }

  function findEocd(src) {
    var len = src.length;
    if (len < EOCD_MIN) {
      return { error: "file is " + len + " bytes; a zip needs at least " +
               EOCD_MIN + " for the end-of-central-directory record" };
    }
    var window = Math.min(len, EOCD_MIN + ZIP_COMMENT_MAX);
    var base = len - window;
    var tail = src.read(base, window);
    var fallback = null;
    for (var pos = window - EOCD_MIN; pos >= 0; pos--) {
      if (u32(tail, pos) !== SIG_EOCD) continue;
      if (base + pos + EOCD_MIN + u16(tail, pos + 20) !== len) continue;
      var cand = parseEocdAt(tail, pos, base);
      if (cand.cdOffset + 4 <= cand.offset) {
        var sig;
        if (cand.cdOffset >= base) sig = u32(tail, cand.cdOffset - base);
        else sig = u32(src.read(cand.cdOffset, 4), 0);
        if (sig === SIG_CENTRAL) return cand;
        cand.cdSignature = sig;
      }
      if (!fallback) fallback = cand;
    }
    if (fallback) return fallback;
    return { error: "no end-of-central-directory record: signature " +
             hex(SIG_EOCD) + " with a consistent comment length was not " +
             "found in the last " + window + " bytes of a " + len +
             "-byte file" };
  }

  // ------------------------------------------------- central directory
  function readCentral(src, eocd, errors, warnings) {
    var entries = [];
    // ZIP64 first: its sentinels would otherwise read as "directory past
    // the EOCD" and hide the real reason.
    if (eocd.entriesTotal === 0xFFFF || eocd.cdOffset === 0xFFFFFFFF ||
        eocd.cdSize === 0xFFFFFFFF) {
      errors.push("EOCD carries ZIP64 sentinel values (entries " +
        eocd.entriesTotal + ", cd offset " + eocd.cdOffset + ", cd size " +
        eocd.cdSize + "); ZIP64 archives are not readable here");
      return entries;
    }
    if (eocd.diskNumber !== 0 || eocd.cdDisk !== 0) {
      errors.push("multi-disk archive (disk " + eocd.diskNumber +
        ", central directory on disk " + eocd.cdDisk + ") is not readable");
      return entries;
    }
    var cdEnd = eocd.cdOffset + eocd.cdSize;
    if (cdEnd > eocd.offset) {
      errors.push("central directory claims offset " + eocd.cdOffset +
        " + size " + eocd.cdSize + " = " + cdEnd + ", past the EOCD at " +
        eocd.offset + " (file truncated or offsets wrong)");
      return entries;
    }
    if (eocd.cdSize > CENTRAL_DIR_CAP) {
      errors.push("central directory declares " + eocd.cdSize +
        " bytes, above the " + CENTRAL_DIR_CAP + " the reader holds in memory");
      return entries;
    }
    if (typeof eocd.cdSignature === "number") {
      errors.push("central directory offset " + eocd.cdOffset +
        " holds signature " + hex(eocd.cdSignature) + ", not " +
        hex(SIG_CENTRAL));
      return entries;
    }
    var cd = src.read(eocd.cdOffset, eocd.cdSize);
    var base = eocd.cdOffset;
    var pos = 0;
    for (var i = 0; i < eocd.entriesTotal; i++) {
      if (pos + CENTRAL_FIXED > cd.length) {
        errors.push("central directory entry " + i + " at offset " +
          (base + pos) + " runs past the directory end " + cdEnd +
          " (expected " + eocd.entriesTotal + " entries)");
        break;
      }
      var sig = u32(cd, pos);
      if (sig !== SIG_CENTRAL) {
        errors.push("central directory entry " + i + " at offset " +
          (base + pos) + ": signature " + hex(sig) + " is not " +
          hex(SIG_CENTRAL));
        break;
      }
      var flags = u16(cd, pos + 8);
      var nameLen = u16(cd, pos + 28);
      var extraLen = u16(cd, pos + 30);
      var commentLen = u16(cd, pos + 32);
      var nameEnd = pos + CENTRAL_FIXED + nameLen;
      if (nameEnd + extraLen + commentLen > cd.length) {
        errors.push("central directory entry " + i + " at offset " +
          (base + pos) + ": name/extra/comment (" + nameLen + "/" + extraLen +
          "/" + commentLen + " bytes) run past the directory end " + cdEnd);
        break;
      }
      var nameBytes = cd.slice(pos + CENTRAL_FIXED, nameEnd);
      var e = {
        index: i,
        name: decodeName(nameBytes, !!(flags & FLAG_UTF8)),
        nameBytes: nameBytes,
        flags: flags,
        utf8: !!(flags & FLAG_UTF8),
        dataDescriptor: !!(flags & FLAG_DESCRIPTOR),
        method: u16(cd, pos + 10),
        crc: u32(cd, pos + 16),
        compressedSize: u32(cd, pos + 20),
        size: u32(cd, pos + 24),
        localOffset: u32(cd, pos + 42),
        crcOk: null,
        inflated: false
      };
      entries.push(e);
      pos = nameEnd + extraLen + commentLen;
    }
    if (entries.length === eocd.entriesTotal && pos !== cd.length) {
      warnings.push("central directory walked " + entries.length +
        " entries ending at " + (base + pos) +
        " but its declared size ends at " + cdEnd);
    }
    var seen = {};
    for (var j = 0; j < entries.length; j++) {
      var nm = entries[j].name;
      if (seen[nm]) {
        warnings.push("entry \"" + nm + "\" appears " + (seen[nm] + 1) +
          " times in the central directory");
      }
      seen[nm] = (seen[nm] || 0) + 1;
    }
    return entries;
  }

  // ------------------------------------------------------ local header
  // Reads only the header (30 bytes, then name + extra). Returns the
  // data start offset or null after pushing a grounded error. Bit-3
  // entries carry zero CRC/sizes here and the truth in the central
  // record, so only non-descriptor entries are compared field by field;
  // the data descriptor that follows the body is NOT read — the central
  // record is trusted for those three values.
  function checkLocal(src, e, errors) {
    var who = "entry \"" + e.name + "\"";
    var lo = e.localOffset;
    if (lo + LOCAL_FIXED > src.length) {
      errors.push(who + ": local header at offset " + lo +
        " lies past the end of a " + src.length + "-byte file");
      return null;
    }
    var h = src.read(lo, LOCAL_FIXED);
    var sig = u32(h, 0);
    if (sig !== SIG_LOCAL) {
      errors.push(who + ": local header at offset " + lo + " has signature " +
        hex(sig) + ", not " + hex(SIG_LOCAL));
      return null;
    }
    var lFlags = u16(h, 6);
    var lMethod = u16(h, 8);
    var lCrc = u32(h, 14);
    var lCsize = u32(h, 18);
    var lUsize = u32(h, 22);
    var lNameLen = u16(h, 26);
    var lExtraLen = u16(h, 28);
    var nameEnd = lo + LOCAL_FIXED + lNameLen;
    if (nameEnd > src.length) {
      errors.push(who + ": local header name (" + lNameLen +
        " bytes at " + (lo + LOCAL_FIXED) + ") runs past the end of the file");
      return null;
    }
    // Raw bytes, not decoded strings: a writer that sets bit 11 in one
    // header only must not read as a renamed entry.
    var lNameBytes = src.read(lo + LOCAL_FIXED, lNameLen);
    if (!sameBytes(lNameBytes, e.nameBytes)) {
      errors.push(who + ": local header names it \"" +
        decodeName(lNameBytes, !!(lFlags & FLAG_UTF8)) + "\"");
      return null;
    }
    if (lMethod !== e.method) {
      errors.push(who + ": local header method " + lMethod +
        " differs from central directory method " + e.method);
      return null;
    }
    if (!(lFlags & FLAG_DESCRIPTOR)) {
      if (lCrc !== e.crc) {
        errors.push(who + ": local header CRC " + hex(lCrc) +
          " differs from central directory CRC " + hex(e.crc));
        return null;
      }
      if (lCsize !== e.compressedSize || lUsize !== e.size) {
        errors.push(who + ": local header sizes " + lCsize + "/" + lUsize +
          " differ from central directory sizes " + e.compressedSize + "/" +
          e.size);
        return null;
      }
    }
    var dataStart = nameEnd + lExtraLen;
    var dataEnd = dataStart + e.compressedSize;
    if (dataEnd > src.length) {
      errors.push(who + ": data spans " + dataStart + "-" + dataEnd +
        " but the file is " + src.length + " bytes (truncated by " +
        (dataEnd - src.length) + ")");
      return null;
    }
    return dataStart;
  }

  // Read + inflate + CRC one entry. Sets e.crcOk and returns the bytes,
  // or null after a grounded error / cap warning. The body is read only
  // here, and only once the cap has been checked.
  function readEntryData(src, e, dataStart, maxInflate, errors, warnings) {
    var who = "entry \"" + e.name + "\"";
    if (e.method !== METHOD_STORED && e.method !== METHOD_DEFLATE) {
      errors.push(who + ": compression method " + e.method +
        " is not readable here (only 0 stored and 8 deflate are); " +
        "the entry cannot be verified");
      e.crcOk = false;
      return null;
    }
    if (e.size > maxInflate || e.compressedSize > maxInflate) {
      warnings.push(who + ": uncompressed size " + e.size +
        " exceeds the inflate cap " + maxInflate + "; not inflated, " +
        "CRC unverified");
      return null;
    }
    var out = null;
    if (e.method === METHOD_STORED) {
      if (e.compressedSize !== e.size) {
        errors.push(who + ": stored (method 0) but compressed size " +
          e.compressedSize + " differs from uncompressed size " + e.size);
        e.crcOk = false;
        return null;
      }
      out = src.read(dataStart, e.compressedSize);
    } else {
      var raw = src.read(dataStart, e.compressedSize);
      try {
        // maxOutputLength: a header that under-declares its size cannot
        // grow the buffer without bound; the length check below reports
        // the mismatch on a Node that ignores the option.
        out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size + 1) });
      } catch (err) {
        if (err && err.code === "ERR_BUFFER_TOO_LARGE") {
          errors.push(who + ": inflates past the declared " + e.size +
            " bytes");
        } else {
          errors.push(who + ": deflate stream does not inflate (" +
            String(err && err.message || err) + ")");
        }
        e.crcOk = false;
        return null;
      }
    }
    e.inflated = true;
    if (out.length !== e.size) {
      errors.push(who + ": inflated to " + out.length +
        " bytes, central directory declares " + e.size);
      e.crcOk = false;
      return null;
    }
    var got = crc32(out);
    if (got !== e.crc) {
      errors.push(who + ": CRC32 of the data is " + hex(got) +
        ", central directory declares " + hex(e.crc));
      e.crcOk = false;
      return null;
    }
    e.crcOk = true;
    return out;
  }

  function isDefinitionEntry(name) {
    return name.toLowerCase() === DEFINITION_NAME;
  }
  function isDefinitionBasename(name) {
    var i = name.lastIndexOf("/");
    return name.slice(i + 1).toLowerCase() === DEFINITION_NAME;
  }

  // Strip a UTF-8 BOM (EF BB BF) before JSON.parse — JSON.parse rejects
  // it, and a BOM'd definition.json is one of the forms the plan requires
  // the reader to accept. A UTF-16 BOM is reported, not decoded.
  function parseDefinition(bytes, errors, warnings) {
    if (bytes.length >= 2 &&
        ((bytes[0] === 0xFF && bytes[1] === 0xFE) ||
         (bytes[0] === 0xFE && bytes[1] === 0xFF))) {
      errors.push("definition.json begins with a UTF-16 byte-order mark " +
        "(" + hex(bytes[0]) + " " + hex(bytes[1]) + "); only UTF-8 is read");
      return { raw: null, parsed: null };
    }
    var start = 0;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB &&
        bytes[2] === 0xBF) {
      start = 3;
      warnings.push("definition.json carries a UTF-8 byte-order mark");
    }
    var raw = bytes.slice(start).toString("utf8");
    try {
      return { raw: raw, parsed: JSON.parse(raw) };
    } catch (err) {
      errors.push("definition.json does not parse as JSON: " +
        String(err && err.message || err) + " (" + raw.length + " chars)");
      return { raw: raw, parsed: null };
    }
  }

  /**
   * readMogrt(path, opts) -> {
   *   readable, ok, bytes, entries: [{name, method, compressedSize, size,
   *   crcOk, flags, utf8, dataDescriptor}], definition, definitionRaw,
   *   errors, warnings, definitionOnly }
   *
   * opts.definitionOnly  — inflate only definition.json (panel mode).
   * opts.maxInflate      — byte cap; a larger entry becomes a warning.
   * opts.buffer          — parse these bytes instead of reading `path`.
   */
  function readMogrt(path, opts) {
    ensureNode();
    opts = opts || {};
    var errors = [], warnings = [];
    var result = {
      readable: true, ok: false, path: path, bytes: 0, entries: [],
      definition: null, definitionRaw: null, definitionEntry: null,
      definitionOnly: !!opts.definitionOnly, errors: errors,
      warnings: warnings
    };
    var maxInflate = (typeof opts.maxInflate === "number" && opts.maxInflate > 0)
      ? opts.maxInflate : DEFAULT_MAX_INFLATE;

    var src = null;
    try {
      if (opts.buffer) {
        src = bufferSource(NodeBuffer.isBuffer(opts.buffer)
          ? opts.buffer : NodeBuffer.from(opts.buffer));
      } else {
        src = fileSource(path);
      }
      result.bytes = src.length;
      parseArchive(src, path, opts, maxInflate, result, errors, warnings);
    } catch (err) {
      if (err && err.aellRead) {
        result.readable = false;
        errors.push(String(err.message));
      } else {
        throw err;
      }
    } finally {
      if (src) src.close();
    }
    result.ok = result.readable && errors.length === 0;
    return result;
  }

  function parseArchive(src, path, opts, maxInflate, result, errors, warnings) {
    var eocd = findEocd(src);
    if (eocd.error) {
      errors.push(eocd.error + " (" + path + ")");
      return;
    }
    if (eocd.commentLen) {
      warnings.push("archive carries a " + eocd.commentLen +
        "-byte trailing comment");
    }
    var entries = readCentral(src, eocd, errors, warnings);
    result.entries = entries;
    if (errors.length) return;
    if (entries.length === 0) {
      errors.push("archive lists zero entries (" + path + ")");
      return;
    }

    // Locate definition.json: the exact root name first, a nested one
    // second (with a warning naming the path it was found at).
    var defEntry = null;
    for (var i = 0; i < entries.length; i++) {
      if (isDefinitionEntry(entries[i].name)) { defEntry = entries[i]; break; }
    }
    if (!defEntry) {
      for (var j = 0; j < entries.length; j++) {
        if (isDefinitionBasename(entries[j].name)) {
          defEntry = entries[j];
          warnings.push("definition.json found only at \"" + defEntry.name +
            "\", not at the archive root");
          break;
        }
      }
    }

    for (var k = 0; k < entries.length; k++) {
      var e = entries[k];
      var who = "entry \"" + e.name + "\"";
      if (e.flags & FLAG_ENCRYPTED) {
        errors.push(who + ": encrypted (general-purpose bit 0); cannot be read");
        continue;
      }
      if (e.method !== METHOD_STORED && e.method !== METHOD_DEFLATE) {
        // Named in every mode: an unreadable method is a defect, not a
        // skip, whether or not this pass would have inflated it.
        errors.push(who + ": compression method " + e.method +
          " is not readable here (only 0 stored and 8 deflate are); " +
          "the entry cannot be verified");
        e.crcOk = false;
        continue;
      }
      var dataStart = checkLocal(src, e, errors);
      if (dataStart === null) { e.crcOk = false; continue; }
      var wantData = !opts.definitionOnly || e === defEntry;
      if (!wantData) continue;
      var data = readEntryData(src, e, dataStart, maxInflate, errors, warnings);
      if (data && e === defEntry) {
        result.definitionEntry = e.name;
        var parsed = parseDefinition(data, errors, warnings);
        result.definitionRaw = parsed.raw;
        result.definition = parsed.parsed;
      }
    }
    if (!defEntry) {
      var names = [];
      for (var n = 0; n < entries.length; n++) names.push(entries[n].name);
      errors.push("no definition.json among the " + entries.length +
        " entries: " + names.join(", "));
    }
  }

  // -------------------------------------------- definition.json (PROVISIONAL)
  //
  // Adobe's definition.json field names are NOT pinned. Everything in
  // this block is a best-effort read of the roster that the plan gates on
  // a measured fixture: an export that real Premiere accepted, captured
  // by the local session (SELF-VERIFY-PLANS section 1, build step 4).
  // When that fixture lands, THIS block is the one place that changes —
  // readMogrt and verifyExport do not care what the keys are called.
  //
  // Keys tried, in order:
  //   controller array : clientControls, controls, controllers, then a
  //                      depth-limited scan for the first array of
  //                      objects that ALL carry a name-like key and a
  //                      type-like key (or a nested controls array) — a
  //                      fonts list {name: "Arial"} does not qualify
  //   controller name  : uiName, name, displayName, title, label
  //   controller type  : controlType, type, capsuleType
  //   template name    : capsuleName, name, templateName, title
  // A controller carrying its own controls/clientControls/controllers
  // array is a GROUP: its leaves are emitted, its own name is not.
  // A value shaped {strDB: [{localeString, localeStr}]} is unwrapped to
  // its en_US string, else its first localeString.
  //
  // readRoster reports HOW the roster was found: `via` names the key
  // ("clientControls", "clientControls (nested)", "fallback:widgets") and
  // `provisional` is true whenever it was not a flat read under a known
  // key — the shipped hook reports those verdicts as evidence, not as a
  // defect.
  var CONTROL_ARRAY_KEYS = ["clientControls", "controls", "controllers"];
  var NAME_KEYS = ["uiName", "name", "displayName", "title", "label"];
  var TYPE_KEYS = ["controlType", "type", "capsuleType"];
  var TEMPLATE_NAME_KEYS = ["capsuleName", "name", "templateName", "title"];
  var GROUP_DEPTH_MAX = 8;
  var SCAN_DEPTH_MAX = 4;

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function unwrapString(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v === "object") {
      var db = v.strDB;
      if (isArray(db)) {
        var first = null;
        for (var i = 0; i < db.length; i++) {
          var row = db[i];
          if (!row || typeof row !== "object") continue;
          var s = row.localeString;
          if (typeof s !== "string") continue;
          if (first === null) first = s;
          if (row.localeStr === "en_US") return s;
        }
        return first;
      }
      if (typeof v.localeString === "string") return v.localeString;
    }
    return null;
  }

  function pickKey(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, keys[i])) {
        return keys[i];
      }
    }
    return null;
  }

  function childArrayKey(obj) {
    for (var i = 0; i < CONTROL_ARRAY_KEYS.length; i++) {
      if (obj && isArray(obj[CONTROL_ARRAY_KEYS[i]])) return CONTROL_ARRAY_KEYS[i];
    }
    return null;
  }

  function looksLikeControllerArray(v) {
    if (!isArray(v) || v.length === 0) return false;
    for (var i = 0; i < v.length; i++) {
      var c = v[i];
      if (!c || typeof c !== "object" || isArray(c)) return false;
      if (pickKey(c, NAME_KEYS) === null) return false;
      if (pickKey(c, TYPE_KEYS) === null && childArrayKey(c) === null) return false;
    }
    return true;
  }

  function findControllerArray(def) {
    if (!def || typeof def !== "object") return { list: null, via: null, provisional: true };
    for (var i = 0; i < CONTROL_ARRAY_KEYS.length; i++) {
      var k = CONTROL_ARRAY_KEYS[i];
      if (isArray(def[k])) return { list: def[k], via: k, provisional: false };
    }
    // Fallback: breadth-first over nested objects, depth-limited. strDB
    // rows carry localeString, not a name key, so they never qualify.
    var queue = [{ obj: def, path: "" }];
    var depth = 0;
    while (queue.length && depth < SCAN_DEPTH_MAX) {
      var next = [];
      for (var q = 0; q < queue.length; q++) {
        var obj = queue[q].obj;
        for (var key in obj) {
          if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
          var v = obj[key];
          var p = queue[q].path ? queue[q].path + "." + key : key;
          if (looksLikeControllerArray(v)) {
            return { list: v, via: "fallback:" + p, provisional: true };
          }
          if (v && typeof v === "object" && !isArray(v)) next.push({ obj: v, path: p });
        }
      }
      queue = next;
      depth++;
    }
    return { list: null, via: null, provisional: true };
  }

  // Flatten groups: a controller with its own controls array contributes
  // its leaves. `state.nested` records that at least one group was opened.
  function collectLeaves(list, out, via, state, depth) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || typeof c !== "object") continue;
      var ck = childArrayKey(c);
      if (ck !== null && depth < GROUP_DEPTH_MAX) {
        state.nested = true;
        collectLeaves(c[ck], out, via, state, depth + 1);
        continue;
      }
      var nk = pickKey(c, NAME_KEYS);
      var tk = pickKey(c, TYPE_KEYS);
      out.push({
        name: nk === null ? null : unwrapString(c[nk]),
        type: tk === null ? null : c[tk],
        index: out.length,
        via: via,
        raw: c
      });
    }
  }

  /**
   * readRoster(definition) -> {controllers, via, provisional, nested}
   * PROVISIONAL field names — see the block comment above.
   */
  function readRoster(definition) {
    var found = findControllerArray(definition);
    var out = { controllers: [], via: found.via, provisional: found.provisional,
                nested: false };
    if (!found.list) return out;
    var state = { nested: false };
    collectLeaves(found.list, out.controllers, found.via, state, 0);
    if (state.nested) {
      out.nested = true;
      out.provisional = true;
      out.via = found.via + " (nested)";
      for (var i = 0; i < out.controllers.length; i++) out.controllers[i].via = out.via;
    }
    return out;
  }

  /** extractControllers(definition) -> [{name, type, index, via, raw}] */
  function extractControllers(definition) {
    return readRoster(definition).controllers;
  }

  /** templateNameOf(definition) -> string|null (PROVISIONAL keys). */
  function templateNameOf(definition) {
    if (!definition || typeof definition !== "object") return null;
    for (var i = 0; i < TEMPLATE_NAME_KEYS.length; i++) {
      var k = TEMPLATE_NAME_KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(definition, k)) continue;
      var s = unwrapString(definition[k]);
      if (typeof s === "string") return s;
    }
    return null;
  }

  // ---------------------------------------------------------- verdict
  function countNames(list) {
    var counts = {};
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      counts[n] = (counts[n] || 0) + 1;
    }
    return counts;
  }

  /**
   * verifyExport({path, expectedControllers, templateName, definitionOnly,
   *               maxInflate, buffer}) -> {
   *   readable, zipValid, entryCount, definitionFound, templateNameInFile,
   *   templateNameMatches, controllersInFile, controllerTypes, rosterVia,
   *   rosterProvisional, missing, extra, duplicateCounts, warnings,
   *   errors, entries }
   *
   * Roster parity is a MULTISET: a controller expected twice and present
   * once is a missing controller, and the same name collapsed by the
   * writer is caught even when every distinct name is present.
   * controllersInFile is always an array.
   */
  function verifyExport(req) {
    req = req || {};
    var path = req.path;
    var read = readMogrt(path, {
      definitionOnly: !!req.definitionOnly,
      maxInflate: req.maxInflate,
      buffer: req.buffer
    });
    var errors = read.errors.slice();
    var warnings = read.warnings.slice();
    var v = {
      path: path,
      readable: read.readable,
      zipValid: null,
      entryCount: read.entries.length,
      definitionFound: !!read.definition,
      templateNameInFile: null,
      templateNameMatches: null,
      controllersInFile: [],
      controllerTypes: [],
      rosterVia: null,
      rosterProvisional: null,
      missing: [],
      extra: [],
      duplicateCounts: {},
      entries: read.entries,
      warnings: warnings,
      errors: errors
    };
    // zipValid is a verdict about bytes that were read: an unreadable
    // file stays null. Roster errors are appended below and do not
    // retract a valid container.
    if (!read.readable) return v;
    v.zipValid = read.errors.length === 0;

    if (!read.definition) return v;

    var def = read.definition;
    v.templateNameInFile = templateNameOf(def);
    if (typeof req.templateName === "string") {
      if (v.templateNameInFile === null) {
        warnings.push("template name not located in definition.json under " +
          TEMPLATE_NAME_KEYS.join("/") + " (keys present: " +
          Object.keys(def).join(", ") + ") in " + path);
      } else {
        v.templateNameMatches = v.templateNameInFile === req.templateName;
        if (!v.templateNameMatches) {
          // AE may transform the name on the way out (export_mogrt's
          // nameNote is the file-name branch); the roster below is the
          // hard verdict, so this is a warning naming both strings.
          warnings.push("template name expected \"" + req.templateName +
            "\", measured \"" + v.templateNameInFile + "\" in " + path);
        }
      }
    }

    var roster = readRoster(def);
    var controllers = roster.controllers;
    v.rosterVia = roster.via;
    v.rosterProvisional = roster.provisional;
    var namesInFile = [];
    for (var i = 0; i < controllers.length; i++) {
      namesInFile.push(controllers[i].name === null ? "" : controllers[i].name);
      v.controllerTypes.push(controllers[i].type);
    }
    v.controllersInFile = namesInFile;
    if (controllers.length === 0) {
      warnings.push("no controller array located in definition.json " +
        "(keys tried: " + CONTROL_ARRAY_KEYS.join("/") + ", then any array " +
        "of objects with " + NAME_KEYS.join("/") + " and " +
        TYPE_KEYS.join("/") + "; top-level keys present: " +
        Object.keys(def).join(", ") + ") in " + path);
    } else if (roster.provisional) {
      warnings.push("controller roster read via " + roster.via +
        " (provisional: field names unpinned) in " + path);
    }

    var expected = isArray(req.expectedControllers) ? req.expectedControllers : null;
    var have = countNames(namesInFile);
    for (var name in have) {
      if (have[name] > 1) v.duplicateCounts[name] = have[name];
    }
    if (expected) {
      var want = countNames(expected);
      var nm;
      for (nm in want) {
        var deficit = want[nm] - (have[nm] || 0);
        for (var d = 0; d < deficit; d++) v.missing.push(nm);
        if (deficit > 0) {
          errors.push("controller \"" + nm + "\" expected " + want[nm] +
            " time" + (want[nm] === 1 ? "" : "s") + ", measured " +
            (have[nm] || 0) + " in definition.json of " + path);
        }
      }
      for (nm in have) {
        var surplus = have[nm] - (want[nm] || 0);
        for (var s = 0; s < surplus; s++) v.extra.push(nm);
        if (surplus > 0) {
          errors.push("controller \"" + nm + "\" measured " + have[nm] +
            " time" + (have[nm] === 1 ? "" : "s") + ", expected " +
            (want[nm] || 0) + " in definition.json of " + path);
        }
      }
    }
    return v;
  }

  return {
    readMogrt: readMogrt,
    readRoster: readRoster,
    extractControllers: extractControllers,
    templateNameOf: templateNameOf,
    verifyExport: verifyExport,
    crc32: crc32,
    DEFINITION_NAME: DEFINITION_NAME,
    DEFAULT_MAX_INFLATE: DEFAULT_MAX_INFLATE,
    // Exposed so the measure pass can print what the reader assumed.
    PROVISIONAL_KEYS: {
      controllerArray: CONTROL_ARRAY_KEYS,
      controllerName: NAME_KEYS,
      controllerType: TYPE_KEYS,
      templateName: TEMPLATE_NAME_KEYS
    }
  };
});
