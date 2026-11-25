'use strict';
// Record attachments (invoices / receipts): metadata validation and the
// IndexedDB blob store, addressed by content hash.

// --- Record attachments (invoices / receipts) ---
// One file per record: PDF, PNG or JPG, max ATTACH_MAX_BYTES. The trade
// carries only small metadata {name, mime, size, hash}; the binary lives
// in IndexedDB (never in localStorage, which caps at ~5-10 MB per origin).
// Cloud sync / zip backup (phase 2) move the same blobs by content hash.
var ATTACH_MAX_BYTES = 10 * 1024 * 1024;
var ATTACH_MIMES = ['application/pdf', 'image/png', 'image/jpeg'];
function isValidAttachment(v) {
  if (v === undefined || v === null) return true; // absent is valid
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof v.name !== 'string' || v.name.trim().length < 1 || v.name.trim().length > 120) return false;
  if (ATTACH_MIMES.indexOf(String(v.mime)) === -1) return false;
  if (typeof v.size !== 'number' || !isFinite(v.size) || v.size <= 0 || v.size > ATTACH_MAX_BYTES) return false;
  if (typeof v.hash !== 'string' || !/^[0-9a-f]{8,64}$/.test(v.hash)) return false;
  return true;
}
// Small promise-free IndexedDB blob store keyed by content hash.
// Every helper resolves (never rejects) so a missing/private-mode IDB can
// never break saving: callers treat null/false as "blob unavailable".
var ATTACH_DB = 'inoculens.plutus.attachments';
var ATTACH_STORE = 'blobs';
function attDb() {
  return new Promise(function (resolve) {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      var req = indexedDB.open(ATTACH_DB, 1);
      req.onupgradeneeded = function () {
        try { req.result.createObjectStore(ATTACH_STORE); } catch (e) { /* exists */ }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    } catch (e) { resolve(null); }
  });
}
function attPut(hash, blob, meta) {
  return attDb().then(function (db) {
    if (!db) return false;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(ATTACH_STORE, 'readwrite');
        tx.oncomplete = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(true); };
        tx.onerror = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(false); };
        tx.objectStore(ATTACH_STORE).put({ hash: hash, blob: blob, name: meta.name, mime: meta.mime, size: meta.size, createdAt: new Date().toISOString() }, hash);
      } catch (e) { try { db.close(); } catch (e2) { /* ignore */ } resolve(false); }
    });
  });
}
function attGet(hash) {
  return attDb().then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(ATTACH_STORE, 'readonly');
        var rq = tx.objectStore(ATTACH_STORE).get(hash);
        rq.onsuccess = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(rq.result || null); };
        rq.onerror = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(null); };
      } catch (e) { try { db.close(); } catch (e2) { /* ignore */ } resolve(null); }
    });
  });
}
function attDelete(hash) {
  return attDb().then(function (db) {
    if (!db) return false;
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(ATTACH_STORE, 'readwrite');
        tx.oncomplete = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(true); };
        tx.onerror = function () { try { db.close(); } catch (e) { /* ignore */ } resolve(false); };
        tx.objectStore(ATTACH_STORE).delete(hash);
      } catch (e) { try { db.close(); } catch (e2) { /* ignore */ } resolve(false); }
    });
  });
}
// Attachment blobs are content-addressed: two records that attach the same
// file share one blob. A blob may therefore only go once NO stored record
// references its hash, and only after the metadata change is really saved.
function attHashesOfState(state) {
  var out = dict();
  var list = state && Array.isArray(state.trades) ? state.trades : [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i] && list[i].attachment;
    if (a && typeof a.hash === 'string' && /^[0-9a-f]{8,64}$/.test(a.hash)) out[a.hash] = true;
  }
  return out;
}
function attHashesOfRaw(raw) {
  try { return attHashesOfState(JSON.parse(raw)); } catch (e) { return null; }
}
// Hashes the previous stored state referenced that the new state does not.
function attReleasedHashes(prevRaw, nextState) {
  if (typeof prevRaw !== 'string' || prevRaw.indexOf('"attachment"') === -1) return [];
  var before = attHashesOfRaw(prevRaw);
  if (!before) return []; // unreadable previous state: never delete on a guess
  var after = attHashesOfState(nextState);
  return Object.keys(before).filter(function (h) { return !after[h]; });
}
function attHashBytes(buf) {
  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) { var h = bytes[i].toString(16); s += (h.length < 2 ? '0' : '') + h; }
    return s;
  }
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', buf).then(function (d) { return hex(new Uint8Array(d)); });
    }
  } catch (e) { /* fall through to FNV */ }
  return Promise.resolve().then(function () {
    var b = new Uint8Array(buf);
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 16777619) >>> 0; h2 = Math.imul(h2 + b[i], 16777619) >>> 0; }
    function p(n) { var s = n.toString(16); while (s.length < 8) s = '0' + s; return s; }
    return (p(h1) + p(h2)).toLowerCase();
  });
}
