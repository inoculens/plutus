'use strict';
// Sync: record-attachment blobs (invoices / receipts).
//
// One encrypted object per file, flat next to the state file so every
// provider works unchanged: <base>-att-<hash>.enc.json (hex hash is safe
// in Drive names, Dropbox Latin1 paths, S3 keys and WebDAV URLs; the
// sanitizer passes it through byte-identical). The envelope reuses the
// state crypto: plaintext is JSON {v,name,mime,b64}, so binary rides the
// same text upload/download paths. Push uploads what this device holds
// (skip-if-exists); preview lazy-fetches what it lacks. Nothing is ever
// auto-deleted remotely: a hash missing here may be another device's
// pending upload.
function syncBlobFilename(cfg, hash) {
  return syncDisplayBasename(cfg.filename) + '-att-' + String(hash).toLowerCase() + '.enc.json';
}
function syncBlobCfgFor(cfg, filename) {
  var c = {};
  for (var k in cfg) { if (Object.prototype.hasOwnProperty.call(cfg, k)) c[k] = cfg[k]; }
  c.filename = filename;
  c.objectKey = filename;
  return c;
}
function syncBlobCfg(cfg, hash) {
  return syncBlobCfgFor(cfg, syncBlobFilename(cfg, hash));
}
// Parse our own blob names back to hashes: <base>-att-<hash>.enc.json.
// The base must match this destination's state file, so cleanup can never
// touch a stranger's files sharing the folder. Pure — covered by tests.
function syncBlobNameHash(name, base) {
  var s = String(name == null ? '' : name);
  var suffix = '.enc.json';
  if (s.length <= suffix.length + 6 || s.slice(-suffix.length) !== suffix) return null;
  var stem = s.slice(0, -suffix.length);
  var tag = '-att-';
  var i = stem.lastIndexOf(tag);
  if (i <= 0) return null;
  if (base !== undefined && stem.slice(0, i) !== String(base)) return null;
  var h = stem.slice(i + tag.length).toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(h)) return null;
  return h;
}
function syncAttachmentMetas(st) {
  var out = [], seen = {};
  (((st && st.trades) || [])).forEach(function (t) {
    if (t && t.attachment && isValidAttachment(t.attachment) && !seen[t.attachment.hash]) {
      seen[t.attachment.hash] = true;
      out.push(t.attachment);
    }
  });
  return out;
}
function attBlobToB64(blob) {
  return new Promise(function (resolve, reject) {
    try {
      var rd = new FileReader();
      rd.onload = function () {
        try { resolve(syncB64encode(new Uint8Array(rd.result))); }
        catch (e) { reject(new Error('sync failed: could not read the file.')); }
      };
      rd.onerror = function () { reject(new Error('sync failed: could not read the file.')); };
      rd.readAsArrayBuffer(blob);
    } catch (e) { reject(new Error('sync failed: could not read the file.')); }
  });
}
// Best-effort: resolves {up, skip} and never rejects, so blob trouble can
// never fail an already-synced state push — leftovers retry next push.
function syncPushAttachments(cfg, pass) {
  var metas = [];
  try { metas = syncAttachmentMetas(loadState()); } catch (e) { metas = []; }
  if (!metas.length || !pass) return Promise.resolve({ up: 0, skip: 0 });
  var up = 0, skipped = 0;
  var chain = Promise.resolve(true);
  metas.forEach(function (meta) {
    chain = chain.then(function () {
      return attGet(meta.hash).then(function (rec) {
        if (!rec || !rec.blob) { skipped++; return true; }
        var bc = syncBlobCfg(cfg, meta.hash);
        return syncRemoteExists(bc).then(function (exists) {
          if (exists) return true;
          return attBlobToB64(rec.blob).then(function (b64) {
            var plain = JSON.stringify({ v: 1, name: meta.name, mime: meta.mime, b64: b64 });
            return syncEncryptEnvelope(plain, pass).then(function (env) {
              return syncRemoteUpload(bc, env).then(function () { up++; return true; });
            });
          });
        });
      }, function () { skipped++; return true; });
    });
  });
  return chain.then(function () { return { up: up, skip: skipped }; },
    function () { return { up: up, skip: skipped }; });
}
function syncPullAttachment(cfg, pass, meta) {
  var bc = syncBlobCfg(cfg, meta.hash);
  return syncRemoteDownload(bc).then(function (envText) {
    return syncDecryptEnvelope(envText, pass);
  }).then(function (plain) {
    var d = JSON.parse(plain);
    if (!d || d.v !== 1 || typeof d.b64 !== 'string') throw new Error('sync failed: bad attachment file.');
    var bytes = syncB64decode(d.b64);
    var blob = new Blob([bytes], { type: d.mime || meta.mime });
    var full = { name: String(d.name || meta.name).slice(0, 120), mime: d.mime || meta.mime, size: bytes.length, hash: meta.hash };
    return attPut(meta.hash, blob, full).then(function () { return { blob: blob, meta: full }; });
  });
}

// --- Orphaned-blob cleanup ("Remove old cloud copies") ---
// Lists our <base>-att-<hash>.enc.json objects at the destination, keeps
// the ones no record on this device references, and deletes the rest only
// after an explicit confirm. Never automatic: a hash missing here may be
// another device's pending upload, so the confirm warns to sync everywhere
// first. Only names matching our own base pattern are ever touched.
function syncFilterBlobNames(names, base) {
  var out = [];
  (names || []).forEach(function (n) {
    var h = syncBlobNameHash(n, base);
    if (h) out.push({ name: String(n), hash: h });
  });
  return out;
}
function syncDriveListBlobs(access, cfg) {
  return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), false).then(function (fid) {
    if (!fid) return [];
    var q = "name contains '-att-' and '" + String(fid).replace(/'/g, '') + "' in parents and trashed = false";
    var base = syncDisplayBasename(cfg.filename);
    return syncDriveList(access, q).then(function (files) {
      var names = (files || []).map(function (f) { return f && f.name; });
      return syncFilterBlobNames(names, base);
    });
  });
}
function syncDropboxListBlobs(access, cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  var base = syncDisplayBasename(cfg.filename);
  var out = [];
  function page(cursor) {
    var url, body;
    if (!cursor) {
      url = 'https://api.dropboxapi.com/2/files/list_folder';
      body = JSON.stringify({ path: folder ? '/' + folder : '', recursive: false, limit: 2000 });
    } else {
      url = 'https://api.dropboxapi.com/2/files/list_folder/continue';
      body = JSON.stringify({ cursor: cursor });
    }
    return syncFetch(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' }, body: body }, 'Dropbox').then(function (res) {
      return syncReadMetaJson(res).then(function (data) {
        if (!res.ok) throw new Error('sync failed: Dropbox listing refused (HTTP ' + res.status + ').');
        ((data && data.entries) || []).forEach(function (e) {
          if (e && e['.tag'] === 'file' && typeof e.name === 'string') {
            var h = syncBlobNameHash(e.name, base);
            if (h) out.push({ name: e.name, hash: h });
          }
        });
        if (data && data.has_more && data.cursor) return page(data.cursor);
        return out;
      }, function () { throw new Error('sync failed: bad Dropbox response.'); });
    });
  }
  return page(null);
}
function syncS3ListBlobs(cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  var base = syncDisplayBasename(cfg.filename);
  var prefix = folder ? folder + '/' : '';
  var out = [];
  function escQ(s) { return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }
  function page(token) {
    var qs = 'list-type=2&max-keys=1000&prefix=' + escQ(prefix);
    if (token) qs = 'continuation-token=' + escQ(token) + '&' + qs;
    return syncS3SignQuery(cfg, 'GET', qs).then(function (s) {
      return syncFetch(s.url, { headers: s.headers }, 'the S3 endpoint').then(function (res) {
        return syncReadMetaText(res).then(function (body) {
          if (!res.ok) throw new Error('sync failed: S3 listing refused (HTTP ' + res.status + ').');
          var keys = [];
          try {
            var re = /<Key>([^<]*)<\/Key>/g, m;
            while ((m = re.exec(body)) !== null) keys.push(m[1]);
          } catch (e) { keys = []; }
          keys.forEach(function (k) {
            var name = String(k).split('/').pop();
            var h = syncBlobNameHash(name, base);
            if (h) out.push({ name: name, hash: h });
          });
          var trunc = /<IsTruncated>true<\/IsTruncated>/.test(body);
          var next = null;
          try { var nm = body.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/); next = nm ? nm[1] : null; } catch (e) { next = null; }
          if (trunc && next) return page(next);
          return out;
        });
      });
    });
  }
  return page(null);
}
function syncWebdavListBlobs(cfg) {
  var auth;
  try { auth = syncWebdavAuth(cfg); } catch (e) { return Promise.reject(e); }
  if (!cfg.url) return Promise.reject(new Error('sync failed: enter the WebDAV server URL.'));
  var base = syncDisplayBasename(cfg.filename);
  var root = String(cfg.url).replace(/\s+$/g, '').replace(/\/+$/, '');
  return syncFetch(root, {
    method: 'PROPFIND',
    headers: { 'Authorization': auth, 'Depth': '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><propname/></propfind>'
  }, 'the WebDAV server').then(function (res) {
    return syncReadMetaText(res).then(function (body) {
      if (!res.ok && res.status !== 207) throw new Error('sync failed: WebDAV listing refused (HTTP ' + res.status + ').');
      var names = [];
      try {
        var re = /<[^>]*href[^>]*>([^<]+)<\//gi, m;
        while ((m = re.exec(body)) !== null) {
          var parts = decodeURIComponent(m[1]).split('/');
          var last = parts.pop() || '';
          if (last) names.push(last);
        }
      } catch (e) { names = []; }
      return syncFilterBlobNames(names, base);
    });
  });
}
function syncRemoteListBlobs(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavListBlobs(cfg);
  if (cfg.provider === 'megas3') return syncS3ListBlobs(cfg);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') return syncDriveListBlobs(access, cfg);
    if (cfg.provider === 'dropbox') return syncDropboxListBlobs(access, cfg);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}
function syncRemoteDeleteBlob(cfg, name) {
  var bc = syncBlobCfgFor(cfg, name);
  if (cfg.provider === 'webdav') {
    var auth;
    try { auth = syncWebdavAuth(cfg); } catch (e) { return Promise.reject(e); }
    return syncFetch(syncJoinUrl(cfg.url, name), { method: 'DELETE', headers: { 'Authorization': auth } }, 'the WebDAV server').then(function (res) {
      if (res.ok || res.status === 404) return true;
      throw new Error('sync failed: WebDAV delete refused (HTTP ' + res.status + ').');
    });
  }
  if (cfg.provider === 'megas3') {
    return syncS3Sign(bc, 'DELETE', '').then(function (s) {
      var h = {};
      for (var k in s.headers) { if (Object.prototype.hasOwnProperty.call(s.headers, k) && k.toLowerCase() !== 'content-type') h[k] = s.headers[k]; }
      return syncFetch(s.url, { method: 'DELETE', headers: h }, 'the S3 endpoint').then(function (res) {
        if (res.ok || res.status === 404 || res.status === 204) return true;
        throw new Error('sync failed: S3 delete refused (HTTP ' + res.status + ').');
      });
    });
  }
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), false).then(function (fid) {
        if (!fid) return true;
        return syncDriveFind(access, name, fid).then(function (id) {
          if (!id) return true;
          return syncFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id), {
            method: 'DELETE', headers: { 'Authorization': 'Bearer ' + access }
          }, 'Google Drive').then(function (res) {
            if (res.ok || res.status === 404 || res.status === 204) return true;
            throw new Error('sync failed: Drive delete refused (HTTP ' + res.status + ').');
          });
        });
      });
    }
    if (cfg.provider === 'dropbox') {
      var folder = syncNormalizeFolder(cfg.folder);
      return syncFetch('https://api.dropboxapi.com/2/files/delete_v2', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/' + (folder ? folder + '/' : '') + name })
      }, 'Dropbox').then(function (res) {
        if (res.ok) return true;
        if (res.status === 409) return true; // already gone counts as cleaned
        throw new Error('sync failed: Dropbox delete refused (HTTP ' + res.status + ').');
      });
    }
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}
function syncCleanupFlow() {
  if (syncBusy) return;
  var cfg = syncReadForm().cfg;
  syncSetBusy(true, 'Listing cloud files…');
  var referenced = {};
  try {
    syncAttachmentMetas(loadState()).forEach(function (m) { referenced[m.hash] = true; });
  } catch (e) { /* ignore */ }
  syncRemoteListBlobs(cfg).then(function (items) {
    var orphans = (items || []).filter(function (it) { return it && it.hash && !referenced[it.hash]; });
    syncSetBusy(false);
    syncRefreshSyncPanel({ keepStatus: true });
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    if (!orphans.length) {
      syncSetStatus((items && items.length) ? 'Cloud files match your records — nothing orphaned.' : 'No invoice/receipt files in the drive folder yet.');
      return;
    }
    var count = orphans.length;
    confirmAction('Delete ' + count + ' orphaned file' + (count === 1 ? '' : 's') + '?',
      (count === 1)
      ? 'There is 1 cloud copy that belongs to no record on this device. Only continue if every device synced recently — a device that has not uploaded yet would lose its copy.'
      : 'There are ' + count + ' cloud copies that belong to no record on this device. Only continue if every device synced recently — a device that has not uploaded yet would lose its copy.',
      'Delete files').then(function (ok) {
      if (!ok) return;
      syncSetBusy(true, 'Deleting…');
      var done = 0, failed = 0;
      var chain = Promise.resolve(true);
      orphans.forEach(function (o) {
        chain = chain.then(function () {
          return syncRemoteDeleteBlob(cfg, o.name).then(function () { done++; }, function () { failed++; });
        });
      });
      chain.then(function () {
        syncSetBusy(false);
        syncRefreshSyncPanel({ keepStatus: true });
        try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
        syncSetStatus('Cleanup done: ' + done + ' deleted' + (failed ? ', ' + failed + ' failed' : '') + '.');
      });
    });
  }, function (err) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    showBanner('Cleanup failed — nothing was deleted.', 'error', {
      title: 'Sync error',
      lines: [String((err && err.message) || err)]
    });
  });
}
