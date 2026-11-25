'use strict';
// Sync transports (ciphertext in, ciphertext out): WebDAV, Google Drive and
// Dropbox, plus the provider-neutral upload / download / stamp helpers.

function syncWebdavAuth(cfg) {
  var pw = syncPassword(cfg);
  if (!cfg.url) throw new Error('sync failed: enter the WebDAV server URL.');
  if (!pw) throw new Error('sync failed: enter the WebDAV password.');
  syncRequireHttpsUrl(cfg.url, 'WebDAV server');
  return 'Basic ' + syncB64encode(syncUtf8Encode(cfg.username + ':' + pw));
}

// Creates the destination collection and a few missing parents (MKCOL,
// capped depth, existing collections answer 405). Used before a first
// upload and as a one-time retry when a PUT hits a missing folder.
function syncWebdavMkdirP(cfg) {
  var auth;
  try {
    auth = syncWebdavAuth(cfg);
  } catch (e) {
    return Promise.reject(e);
  }
  var base = String(cfg.url).replace(/\s+$/g, '').replace(/\/+$/, '');
  var folder = syncJoinUrl(cfg.url, cfg.filename);
  var slash = folder.lastIndexOf('/');
  folder = (slash > 8) ? folder.slice(0, slash) : base;
  var chain = [];
  var cur = folder;
  var guard = 0;
  while (cur && cur.length > base.length && guard < 6) {
    chain.unshift(cur);
    var cut = cur.lastIndexOf('/');
    if (cut <= 8) break;
    cur = cur.slice(0, cut);
    guard++;
  }
  var p = Promise.resolve(true);
  chain.forEach(function (u) {
    p = p.then(function () {
      return syncFetch(u, { method: 'MKCOL', headers: { 'Authorization': auth } }, 'the WebDAV server').then(function (res) {
        if (res.ok || res.status === 405 || res.status === 412 || res.status === 200 || res.status === 207) return true;
        if (res.status === 401 || res.status === 403) {
          throw new Error('sync failed: WebDAV refused (HTTP ' + res.status + ') — check the app password and folder permissions.');
        }
        throw new Error('sync failed: WebDAV folder cannot be created (HTTP ' + res.status + '). Check the server URL.');
      });
    });
  });
  return p;
}

function syncWebdavUpload(cfg, text) {
  var auth;
  try {
    auth = syncWebdavAuth(cfg);
  } catch (e) {
    return Promise.reject(e);
  }
  var target = syncJoinUrl(cfg.url, cfg.filename);
  function putOnce() {
    return syncFetch(target, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: text
    }, 'the WebDAV server').then(function (res) {
      if (res.ok) return { done: true };
      if (res.status === 401 || res.status === 403) {
        throw new Error('sync failed: WebDAV login refused. Check the username and app password.');
      }
      if (res.status === 404) {
        throw new Error('sync failed: WebDAV folder not found. Check the server URL.');
      }
      if (res.status === 409) return { retryFolder: true };
      throw new Error('sync failed: WebDAV upload refused (HTTP ' + res.status + ').');
    });
  }
  return putOnce().then(function (r) {
    if (r.done) return true;
    return syncWebdavMkdirP(cfg).then(putOnce).then(function (r2) {
      if (r2.done) return true;
      throw new Error('sync failed: WebDAV upload refused (HTTP 409). Check the server URL.');
    });
  });
}

function syncWebdavDownload(cfg) {
  var pw = syncPassword(cfg);
  if (!cfg.url) return Promise.reject(new Error('sync failed: enter the WebDAV server URL.'));
  if (!pw) return Promise.reject(new Error('sync failed: enter the WebDAV password.'));
  try {
    syncRequireHttpsUrl(cfg.url, 'WebDAV server');
  } catch (e) {
    return Promise.reject(e);
  }
  var auth = 'Basic ' + syncB64encode(syncUtf8Encode(cfg.username + ':' + pw));
  return syncFetch(syncJoinUrl(cfg.url, cfg.filename), {
    method: 'GET',
    headers: { 'Authorization': auth }
  }, 'the WebDAV server').then(function (res) {
    if (res.ok) return syncReadTextLimited(res);
    if (res.status === 401 || res.status === 403) {
      throw new Error('sync failed: WebDAV login refused. Check the username and app password.');
    }
    if (res.status === 404) throw new Error('sync failed: no backup found on the server yet.');
    throw new Error('sync failed: WebDAV download refused (HTTP ' + res.status + ').');
  });
}

function syncDriveList(access, q) {
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
    '&fields=' + encodeURIComponent('files(id,name,modifiedTime)') + '&spaces=drive';
  return syncFetch(url, { headers: { 'Authorization': 'Bearer ' + access } }, 'Google Drive').then(function (res) {
    return syncReadMetaJson(res).then(function (data) {
      if (!res.ok) throw new Error('sync failed: Drive lookup refused (HTTP ' + res.status + ').');
      return (data && data.files) || [];
    }, function () {
      throw new Error('sync failed: bad Drive response.');
    });
  });
}

function syncDriveFind(access, name, folderId) {
  var parent = String(folderId || 'root').replace(/'/g, '');
  var q = "name = '" + String(name).replace(/'/g, '') + "' and '" + parent + "' in parents and trashed = false";
  return syncDriveList(access, q).then(function (files) {
    return (files.length && files[0].id) ? files[0].id : null;
  });
}

// Walks/creates a 'a/b/c' folder tree under Drive root. With create=false it
// only resolves (missing segment -> null) so downloads never create folders.
function syncDriveFolderId(access, folder, create) {
  var segs = String(folder || '').split('/').filter(function (s) { return s !== ''; });
  var chain = Promise.resolve('root');
  segs.forEach(function (seg) {
    chain = chain.then(function (pid) { return syncDriveFolderStep(access, seg, pid, create); });
  });
  return chain;
}

function syncDriveFolderStep(access, name, parentId, create) {
  if (parentId === null) return Promise.resolve(null);
  var clean = String(name).replace(/'/g, '');
  var q = "mimeType = 'application/vnd.google-apps.folder' and name = '" + clean +
    "' and '" + String(parentId).replace(/'/g, '') + "' in parents and trashed = false";
  return syncDriveList(access, q).then(function (files) {
    if (files.length && files[0].id) return files[0].id;
    if (!create) return null;
    return syncFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: clean, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    }, 'Google Drive').then(function (res) {
      return syncReadMetaJson(res).then(function (data) {
        if (!res.ok || !data || !data.id) {
          throw new Error('sync failed: Drive could not create the folder (HTTP ' + res.status + ').');
        }
        return data.id;
      }, function () {
        throw new Error('sync failed: bad Drive response.');
      });
    });
  });
}

function syncDrivePutMedia(access, id, text) {
  return syncFetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=media', {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
    body: text
  }, 'Google Drive').then(function (res) {
    if (res.ok) return true;
    throw new Error('sync failed: Drive upload refused (HTTP ' + res.status + ').');
  });
}

function syncDriveUpload(access, cfg, text) {
  var folder = syncNormalizeFolder(cfg.folder);
  return syncDriveFolderId(access, folder, true).then(function (fid) {
    return syncDriveFind(access, cfg.filename, fid).then(function (id) {
      if (id) return syncDrivePutMedia(access, id, text);
      return syncFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cfg.filename, mimeType: 'application/json', parents: [fid] })
      }, 'Google Drive').then(function (res) {
        return syncReadMetaJson(res).then(function (data) {
          if (!res.ok || !data || !data.id) {
            throw new Error('sync failed: Drive could not create the file (HTTP ' + res.status + ').');
          }
          return syncDrivePutMedia(access, data.id, text);
        }, function () {
          throw new Error('sync failed: bad Drive response.');
        });
      });
    });
  });
}

function syncDriveDownload(access, cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  return syncDriveFolderId(access, folder, false).then(function (fid) {
    if (!fid) throw new Error('sync failed: no backup found on the server yet.');
    return syncDriveFind(access, cfg.filename, fid).then(function (id) {
      if (!id) throw new Error('sync failed: no backup found on the server yet.');
      return syncFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
        headers: { 'Authorization': 'Bearer ' + access }
      }, 'Google Drive').then(function (res) {
        if (res.ok) return syncReadTextLimited(res);
        throw new Error('sync failed: Drive download refused (HTTP ' + res.status + ').');
      });
    });
  });
}

// Full Dropbox path including the optional subfolder (uploads auto-create it).
function syncDropboxFullPath(cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  return '/' + (folder ? folder + '/' : '') + cfg.filename;
}

function syncDropboxUpload(access, cfg, text) {
  return syncFetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: syncDropboxFullPath(cfg), mode: 'overwrite', autorename: false, mute: true })
    },
    body: text
  }, 'Dropbox').then(function (res) {
    if (res.ok) return true;
    throw new Error('sync failed: Dropbox upload refused (HTTP ' + res.status + ').');
  });
}

function syncDropboxDownload(access, cfg) {
  var arg = JSON.stringify({ path: syncDropboxFullPath(cfg) });
  return syncFetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Dropbox-API-Arg': arg
    }
  }, 'Dropbox').then(function (res) {
    if (res.ok) return syncReadTextLimited(res);
    // 409 means the API refused the call: only treat path/not_found as
    // "no backup yet" — anything else is a real refusal, not a first sync.
    if (res.status === 409) {
      return syncReadMetaText(res).then(function (body) {
        if (body && body.indexOf('not_found') !== -1) {
          throw new Error('sync failed: no backup found on the server yet.');
        }
        throw new Error('sync failed: Dropbox refused the request (HTTP 409).');
      }, function () {
        throw new Error('sync failed: Dropbox download refused (HTTP 409).');
      });
    }
    throw new Error('sync failed: Dropbox download refused (HTTP ' + res.status + ').');
  });
}

function syncDropboxExists(access, cfg) {
  return syncFetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: syncDropboxFullPath(cfg) })
  }, 'Dropbox').then(function (res) {
    if (res.ok) return true;
    if (res.status === 409) {
      return syncReadMetaText(res).then(function (body) {
        if (body && body.indexOf('not_found') !== -1) return false;
        throw new Error('sync failed: Dropbox refused the request (HTTP 409).');
      }, function () {
        throw new Error('sync failed: Dropbox lookup refused (HTTP 409).');
      });
    }
    throw new Error('sync failed: Dropbox lookup refused (HTTP ' + res.status + ').');
  });
}

function syncRemoteUpload(cfg, text) {
  if (cfg.provider === 'webdav') return syncWebdavUpload(cfg, text);
  if (cfg.provider === 'megas3') return syncS3Put(cfg, text);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') return syncDriveUpload(access, cfg, text);
    if (cfg.provider === 'dropbox') return syncDropboxUpload(access, cfg, text);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

function syncRemoteDownload(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavDownload(cfg);
  if (cfg.provider === 'megas3') return syncS3Get(cfg);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') return syncDriveDownload(access, cfg);
    if (cfg.provider === 'dropbox') return syncDropboxDownload(access, cfg);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

// Cheap "has the drive file moved?" probe for the background watcher: one
// metadata request instead of a full download + PBKDF2 decrypt every tick.
// Resolves a provider-specific stamp string, or '' when the provider cannot
// answer cheaply (the caller then falls back to the full check). Never
// rejects on a missing file — that resolves 'missing' so a deleted drive
// copy is noticed too.
function syncWebdavStamp(cfg) {
  var auth;
  try {
    auth = syncWebdavAuth(cfg);
  } catch (e) {
    return Promise.reject(e);
  }
  return syncFetch(syncJoinUrl(cfg.url, cfg.filename), {
    method: 'HEAD',
    headers: { 'Authorization': auth }
  }, 'the WebDAV server').then(function (res) {
    if (res.status === 404) return 'missing';
    if (!res.ok) return '';
    var h = res.headers;
    if (!h || typeof h.get !== 'function') return '';
    var etag = h.get('ETag') || '';
    var lastmod = h.get('Last-Modified') || '';
    // No validator at all: treat as unknown so the caller keeps doing full
    // checks instead of trusting a constant stamp forever.
    if (!etag && !lastmod) return '';
    return 'webdav|' + etag + '|' + lastmod;
  }, function () { return ''; });
}

function syncS3Stamp(cfg) {
  // HEAD is signed with the GET-style canonical headers (no content-type);
  // the method itself is part of the canonical request.
  return syncS3Sign(cfg, 'HEAD', '').then(function (s) {
    var headers = {};
    Object.keys(s.headers || {}).forEach(function (k) { headers[k] = s.headers[k]; });
    return syncFetch(s.url, { method: 'HEAD', headers: headers }, 'the S3 endpoint').then(function (res) {
      if (res.status === 404) return 'missing';
      if (!res.ok) return '';
      var h = res.headers;
      if (!h || typeof h.get !== 'function') return '';
      var etag = h.get('ETag') || '';
      var lastmod = h.get('Last-Modified') || '';
      if (!etag && !lastmod) return '';
      return 's3|' + etag + '|' + lastmod;
    }, function () { return ''; });
  }, function () { return ''; });
}

function syncRemoteStamp(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavStamp(cfg);
  if (cfg.provider === 'megas3') return syncS3Stamp(cfg);
  if (cfg.provider === 'gdrive') {
    return syncEnsureAccessToken(cfg).then(function (access) {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), false).then(function (fid) {
        if (!fid) return 'missing';
        return syncDriveList(access, "name = '" + String(cfg.filename).replace(/'/g, '') +
          "' and '" + String(fid).replace(/'/g, '') + "' in parents and trashed = false").then(function (files) {
          if (!files.length) return 'missing';
          // modifiedTime moves on every in-place save; without it the id
          // alone would never change, so stay unknown and keep checking.
          if (!files[0].modifiedTime) return '';
          return 'gdrive|' + files[0].modifiedTime;
        });
      });
    }, function () { return ''; });
  }
  if (cfg.provider === 'dropbox') {
    return syncEnsureAccessToken(cfg).then(function (access) {
      return syncFetch('https://api.dropboxapi.com/2/files/get_metadata', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: syncDropboxFullPath(cfg) })
      }, 'Dropbox').then(function (res) {
        if (res.status === 409) return 'missing';
        if (!res.ok) return '';
        return syncReadMetaJson(res).then(function (d) {
          var mark = (d && (d.rev || d.server_modified || d.content_hash)) || '';
          return mark ? 'dropbox|' + mark : '';
        }, function () { return ''; });
      }, function () { return ''; });
    }, function () { return ''; });
  }
  return Promise.resolve('');
}

// True when a file already lives at this destination. Auth and transport
// failures reject (never misread as "free") so the duplicate gate below
// can only pass on proof of absence.
function syncRemoteExists(cfg) {
  if (cfg.provider === 'webdav') {
    return syncWebdavDownload(cfg).then(function () { return true; }, function (err) {
      if (err && err.message && err.message.indexOf('no backup found') !== -1) return false;
      throw err;
    });
  }
  if (cfg.provider === 'megas3') {
    return syncS3Get(cfg).then(function () { return true; }, function (err) {
      if (err && err.message && err.message.indexOf('no backup found') !== -1) return false;
      throw err;
    });
  }
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), false).then(function (fid) {
        if (!fid) return false;
        return syncDriveFind(access, cfg.filename, fid).then(function (id) { return !!id; });
      });
    }
    if (cfg.provider === 'dropbox') return syncDropboxExists(access, cfg);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

// Idempotent folder preparation before an upload. WebDAV creates missing
// collections (MKCOL walking up at most a few levels); Drive walks and
// creates its folder tree; Dropbox and S3 need nothing (parents appear
// with the object itself).
function syncRemoteEnsureFolder(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavMkdirP(cfg);
  if (cfg.provider === 'megas3') return Promise.resolve(true);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), true).then(function () { return true; });
    }
    if (cfg.provider === 'dropbox') return true;
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}
