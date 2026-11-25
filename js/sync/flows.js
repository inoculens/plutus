'use strict';
// Sync: push / pull orchestration (local data is only replaced after full
// validation), auto-push, load-time check and encrypted file backup.

function syncSetStatus(text) {
  var el = (typeof document !== 'undefined') ? document.getElementById('sy-status') : null;
  if (el) el.textContent = String(text);
}

function syncSetBusy(on, note) {
  syncBusy = !!on;
  var ids = ['sy-connect', 'sy-disconnect', 'sy-push', 'sy-pull', 'sy-cleanup', 'sy-enc-download'];
  var i, el;
  for (i = 0; i < ids.length; i++) {
    el = (typeof document !== 'undefined') ? document.getElementById(ids[i]) : null;
    if (el) el.disabled = syncBusy;
  }
  if (on && note) syncSetStatus(note);
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
}

function syncLocalExportedAt(json) {
  try {
    var d = JSON.parse(json);
    if (d && typeof d.exportedAt === 'string') return d.exportedAt;
  } catch (e) { /* ignore */ }
  return '';
}

// Dirty tracking without crypto: a fast non-crypto hash (djb2 pair) over the
// stable backup projection (exportedAt excluded, or every push would look
// dirty). Used only to decide "same as last upload", never for security.
function syncStateHash(str) {
  var h1 = 5381;
  var h2 = 52711;
  var s = String(str);
  var i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    h1 = ((h1 * 33) ^ c) >>> 0;
    h2 = ((h2 * 33) ^ c) >>> 0;
  }
  return (h1 >>> 0).toString(16) + '-' + (h2 >>> 0).toString(16);
}

function syncHashOfExport(json) {
  try {
    var d = JSON.parse(String(json));
    return syncStateHash(JSON.stringify({
      settings: (d && d.settings) || {},
      accounts: (d && d.accounts) || [],
      trades: (d && d.trades) || [],
      priceOverrides: (d && d.priceOverrides) || {}
    }));
  } catch (e) {
    return '';
  }
}

function syncCurrentHash(st) {
  var s = st;
  try {
    if (!s) s = loadState();
    return syncHashOfExport(exportState(s));
  } catch (e) {
    return '';
  }
}

// "Connected" = enough filled in to attempt a sync right now (secrets may
// live only in the form for this session). The panel status and the header
// icon share this so they can never disagree.
function syncIsConnected(cfg) {
  if (!cfg) return false;
  if (cfg.provider === 'webdav') {
    var password = cfg.priceDataAuth ? syncMemSecrets.pricePassword : syncMemSecrets.password;
    return !!(cfg.url && (cfg.password || password));
  }
  if (cfg.provider === 'megas3') {
    var secretKey = cfg.priceDataAuth ? syncMemSecrets.priceSecretKey : syncMemSecrets.secretKey;
    return !!(cfg.endpoint && cfg.bucket && cfg.accessKey && (cfg.secretKey || secretKey));
  }
  return !!(cfg.tokens && cfg.tokens.access);
}

function syncSetSyncIcon(state, label) {
  var btn = (typeof document !== 'undefined') ? document.getElementById('tb-sync') : null;
  if (!btn) return;
  try { btn.setAttribute('data-sync', state); } catch (e) { /* ignore */ }
  try { btn.setAttribute('aria-label', label); } catch (e) { /* ignore */ }
  try { btn.title = label; } catch (e) { /* ignore */ }
  try {
    var img = document.getElementById('tb-sync-img');
    if (img) {
      img.src = state === 'busy' ? '/icons/sync-busy.png'
        : state === 'stale' ? '/icons/sync-stale.png'
        : '/icons/sync-ok.png';
    }
  } catch (e) { /* ignore */ }
}

function syncRefreshHeaderIcon(st) {
  var btn = (typeof document !== 'undefined') ? document.getElementById('tb-sync') : null;
  if (!btn) return;
  if (syncBusy || syncWatchBusy) {
    btn.hidden = false;
    syncSetSyncIcon('busy', syncBusy ? 'Sync: uploading…' : 'Sync: pulling changes…');
    return;
  }
  var cfg = syncLoadConfig();
  if (!syncIsConnected(cfg)) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (syncPendingRemote) {
    syncSetSyncIcon('stale', 'Sync: drive and this device disagree. Open sync settings to resolve.');
    return;
  }
  var cur = '';
  try { cur = syncCurrentHash(st); } catch (e) { cur = ''; }
  if (cur && cfg.lastSyncedHash && cur === cfg.lastSyncedHash) {
    syncSetSyncIcon('ok', 'Sync: up to date. Open sync settings.');
  } else {
    syncSetSyncIcon('stale', 'Sync: changes pending. Open sync settings to sync now.');
  }
}

// Auto-sync (opt-in checkbox in the Sync tab): every persisted change
// schedules one debounced encrypted push using the passphrase currently in
// the form. Silent by design — failures only touch the status line, and a
// newer drive copy never triggers a surprise overwrite prompt.
var SYNC_AUTO_DELAY_MS = 8000;
var syncAutoTimer = null;

function syncAutoDelay(ms) {
  if (ms !== undefined && isFinite(Number(ms)) && Number(ms) >= 0) SYNC_AUTO_DELAY_MS = Number(ms);
  return SYNC_AUTO_DELAY_MS;
}

function syncScheduleAuto() {
  try {
    if (typeof setTimeout === 'undefined') return;
    if (typeof confirmSettle !== 'undefined' && confirmSettle) return; // a confirm dialog owns the user right now
    if (typeof confirmSettle3 !== 'undefined' && confirmSettle3) return;
    var cfg = syncLoadConfig();
    if (!cfg.autoSync) return;
    // Arm the debounce even while a sync is in flight: the upload already
    // snapshotted the state, so a change made during it needs a follow-up push.
    if (syncAutoTimer) {
      try { clearTimeout(syncAutoTimer); } catch (e) { /* ignore */ }
      syncAutoTimer = null;
    }
    syncAutoTimer = setTimeout(function () {
      syncAutoTimer = null;
      try { syncAutoPush(); } catch (e) { /* ignore */ }
    }, SYNC_AUTO_DELAY_MS);
  } catch (e) { /* ignore */ }
}

function syncCancelAuto() {
  if (syncAutoTimer) {
    try { clearTimeout(syncAutoTimer); } catch (e) { /* ignore */ }
    syncAutoTimer = null;
  }
}

function syncAutoPush() {
  if (syncBusy || syncChecking) {
    // A save landed while an earlier sync (or a background drive read) held
    // the connection. Keep the debounce alive: when it settles, the next tick
    // pushes the current state instead of dropping the change.
    try { syncScheduleAuto(); } catch (e) { /* ignore */ }
    return;
  }
  var cfg;
  try {
    cfg = syncLoadConfig();
  } catch (e) {
    return;
  }
  if (!cfg.autoSync) return;
  // Same source as manual pushes: the typed value, falling back to the
  // remembered passphrase so auto-sync also works when Settings was never
  // opened this session. Without either, stay silent — the hourglass icon
  // already shows pending work, and Connect/Sync enforce the passphrase
  // when pressed.
  var pass = '';
  try {
    pass = syncReadForm().passphrase;
  } catch (e) {
    pass = '';
  }
  if (!pass) return;
  try {
    syncPushFlow({ auto: true });
  } catch (e) { /* ignore */ }
}

// Adopts an already-downloaded + decrypted drive backup (used by the
// taken-name prompt's "Download instead"). Validates fully before touching
// anything, like the pull flow; the confirm already happened, so no snapshot
// dance is needed. Keeps the settings dialog open with a status line.
function syncAdoptRemote(cfg, remotePlain) {
  var next;
  try {
    next = parseImportedState(remotePlain);
  } catch (e) {
    if (isStorageWriteError(e)) throw e;
    throw new Error('sync failed: the drive backup is invalid (' + String((e && e.message) || e).slice(0, 160) + ').');
  }
  if (!saveStateGuarded(next)) return 'failed';
  cfg.lastSyncAt = new Date().toISOString();
  try {
    var d = JSON.parse(remotePlain);
    if (d && typeof d.exportedAt === 'string') cfg.lastRemoteAt = d.exportedAt;
  } catch (e) { /* ignore */ }
  cfg.lastSyncedHash = syncHashOfExport(remotePlain);
  cfg.lastLocation = syncLocationKey(cfg);
  cfg.lastIdentity = syncTrustIdentity(cfg);
  cfg.locV = SYNC_LOC_V;
  syncPendingRemote = false;
    syncSaveConfig(cfg);
  // The pull just made local == drive: no follow-up auto-push is needed.
  syncCancelAuto();
  syncRefreshSyncPanel();
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  clearBanner();
  syncSetStatus('Restored from ' + syncProviderLabel(cfg.provider) + '.');
  refreshPrices();
  return 'pulled';
}

function syncPushFlow(opts) {  if (syncBusy) return;
  if (syncChecking) {
    // A background drive read owns the connection right now; run the push as
    // soon as it settles so the newest state still goes up.
    syncAfterCheck = (opts && opts.auto) ? 'auto' : 'push';
    return;
  }
  var auto = !!(opts && opts.auto);
  var rd = syncReadForm();
  var cfg = rd.cfg;
  var pass = rd.passphrase;
  if (!pass) {
    // Auto-sync without a passphrase stays silent (hourglass icon shows it);
    // manual attempts get the banner.
    if (auto) return;
    showBanner('Enter a sync passphrase first — it encrypts everything you upload.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['Type a passphrase in the Sync tab. It is never sent anywhere.']
    });
    return;
  }
  var st = loadState();
  if ((!st.accounts || !st.accounts.length) && (!st.trades || !st.trades.length)) {
    if (auto) {
      try { syncSetStatus('Nothing to sync yet.'); } catch (e) { /* ignore */ }
      return;
    }
    showBanner('Nothing to sync yet — add an account first.', 'error', {
      title: 'Sync',
      lines: ['Uploading an empty wallet could overwrite a good drive copy. Add data first.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  var plain;
  try {
    plain = exportStateStrict(st);
  } catch (e) {
    // Auto-sync stays quiet (status line only) so a persistent problem never
    // spams banners; a manual push explains it.
    try { syncSetStatus('Sync paused — some stored records are invalid. Nothing was uploaded.'); } catch (e2) { /* ignore */ }
    if (!auto) {
      showBanner('Sync stopped — nothing was uploaded.', 'error', {
        title: 'Sync',
        lines: [String((e && e.message) || e)]
      });
    }
    return;
  }
  syncSetBusy(true, 'Encrypting…');
  var localAt = syncLocalExportedAt(plain);
  var curHash = syncHashOfExport(plain);
  var baseHash = cfg.lastSyncedHash || '';
  syncEncryptEnvelope(plain, pass).then(function (env) {
    syncSetStatus('Uploading to ' + syncProviderLabel(cfg.provider) + '…');
    var locKey = syncLocationKey(cfg);
    // First save to a destination this device has never synced (or under
    // changed credentials): never clobber a stranger's file (e.g. another
    // profile's backup sharing the same drive). Trusted destinations
    // upload freely.
    if (!syncIsTrustedLocation(cfg, locKey)) {
      return syncRemoteExists(cfg).then(function (taken) {
        if (!taken) {
          return syncRemoteEnsureFolder(cfg).then(function () {
            return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
          });
        }
        return syncRemoteDownload(cfg).then(function (remoteText) {
          return syncDecryptEnvelope(remoteText, pass).then(function (remotePlain) {
            if (curHash && syncHashOfExport(remotePlain) === curHash) {
              // Same content (e.g. reconnect with nothing changed): adopt
              // silently — no prompt, no pointless re-upload.
              cfg.lastLocation = locKey;
              cfg.lastIdentity = syncTrustIdentity(cfg);
              cfg.locV = SYNC_LOC_V;
              cfg.lastRemoteAt = syncLocalExportedAt(remotePlain);
              cfg.lastSyncedHash = curHash;
              syncSaveConfig(cfg);
              syncSetBusy(false);
              syncRefreshSyncPanel();
              try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
              syncSetStatus('Already up to date.');
              return 'adopted';
            }
            // Different content under our name: both directions, explicit.
            // (Auto-sync never prompts either: it stands down for the user.)
            syncSetBusy(false);
            if (auto) {
              syncRefreshSyncPanel();
              try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
              syncSetStatus('Drive holds a different copy — open Sync to resolve.');
              return 'conflict-remote';
            }
            return confirmAction3(
              'Name already taken',
              'A different backup named "' + cfg.filename + '" already exists in this folder. Download it (replaces this device) or upload yours (overwrites the drive file)?',
              'Download instead',
              'Upload mine'
            ).then(function (choice) {
              if (choice === 'primary') return syncAdoptRemote(cfg, remotePlain);
              if (choice === 'secondary') {
                syncSetBusy(true, 'Uploading to ' + syncProviderLabel(cfg.provider) + '…');
                return syncRemoteEnsureFolder(cfg).then(function () {
                  return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
                });
              }
              syncSetStatus('Kept the drive file. Change the name or folder to sync here.');
              return 'cancelled';
            });
          }, function () {
            throw new Error('sync failed: "' + cfg.filename + '" already exists in this folder, under a different passphrase. Choose a different name or folder — or delete that file on the drive if it is yours.');
          });
        });
      });
    }
    // Trusted destination: reconcile against the drive copy using content
    // hashes, never wall clocks. The fresh exportedAt above always reads
    // "now", so a timestamp compare can never see a newer drive copy — a
    // stale device would report success while overwriting it. A clean local
    // tree still verifies the drive instead of assuming "up to date".
    if (curHash && baseHash && curHash === baseHash) {
      // Nothing local to upload — but prove the drive agrees first.
      return syncRemoteDownload(cfg).then(function (remoteText) {
        return syncDecryptEnvelope(remoteText, pass).then(function (remotePlain) {
          var remoteHash = syncHashOfExport(remotePlain);
          if (remoteHash && remoteHash === curHash) {
            cfg.lastLocation = locKey;
            cfg.lastIdentity = syncTrustIdentity(cfg);
            cfg.locV = SYNC_LOC_V;
            cfg.lastRemoteAt = syncLocalExportedAt(remotePlain);
            cfg.lastSyncedHash = curHash;
            syncSaveConfig(cfg);
            syncPendingRemote = false;
            syncSetBusy(false);
            syncRefreshSyncPanel();
            try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
            syncSetStatus('Already up to date.');
            return 'adopted';
          }
          // The drive moved while this device stood still: pull it in.
          // Nothing local to lose (local == last sync point).
          var pulledAt = syncAdoptRemote(cfg, remotePlain);
          syncSetStatus('Pulled newer changes from ' + syncProviderLabel(cfg.provider) + '.');
          try { render(); } catch (e) { /* ignore */ }
          return pulledAt;
        }, function () {
          // Drive file exists but this passphrase cannot open it: stop, do not overwrite blindly.
          throw new Error('sync failed: the drive file uses a different passphrase. Enter that passphrase, or clear the drive file first.');
        });
      }, function (dlErr) {
        // File gone (deleted remotely?) with nothing local to upload: stay
        // quiet — the next real change recreates it.
        if (dlErr && dlErr.message && dlErr.message.indexOf('no backup found') !== -1) {
          syncPendingRemote = false;
          syncSetBusy(false);
          syncRefreshSyncPanel();
          try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
          syncSetStatus('Already up to date.');
          return 'verified';
        }
        throw dlErr;
      });
    }
    // Dirty local tree: three-way decision against the last sync point.
    // Only-local-changed uploads freely; only-remote-changed is never
    // overwritten; both-changed asks the user (auto-sync stands down).
    syncSetStatus('Checking drive for newer changes…');
    return syncRemoteDownload(cfg).then(function (remoteText) {
      return syncDecryptEnvelope(remoteText, pass).then(function (remotePlain) {
        var remoteHash = syncHashOfExport(remotePlain);
        var dir = syncDirection(curHash, remoteHash, baseHash);
        if (dir === 'in-sync') {
          cfg.lastLocation = locKey;
          cfg.lastIdentity = syncTrustIdentity(cfg);
          cfg.locV = SYNC_LOC_V;
          cfg.lastRemoteAt = syncLocalExportedAt(remotePlain);
          cfg.lastSyncedHash = curHash;
          syncSaveConfig(cfg);
          syncPendingRemote = false;
          syncSetBusy(false);
          syncRefreshSyncPanel();
          try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
          syncSetStatus('Already up to date.');
          return 'adopted';
        }
        if (dir === 'local-only') {
          // Only this device changed: fast-forward upload, no prompt.
          syncSetStatus('Uploading to ' + syncProviderLabel(cfg.provider) + '…');
          return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
        }
        // remote-only or a true conflict: never overwrite blindly.
        // (Auto-sync never prompts: it stands down for the user.)
        syncPendingRemote = true;
        syncSetBusy(false);
        if (auto) {
          syncRefreshSyncPanel();
          try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
          syncSetStatus(dir === 'remote-only'
            ? 'Drive holds a newer copy — open Sync to resolve.'
            : 'Devices disagree — open Sync to resolve.');
          return 'conflict-remote';
        }
        return confirmAction3(
          dir === 'remote-only' ? 'Drive copy is newer' : 'Sync conflict',
          dir === 'remote-only'
            ? 'The drive backup changed since this device last synced, and this device has no new changes. Download it (replaces this device) or upload yours (overwrites the drive file)?'
            : 'Both this device and the drive changed since the last sync. Download the drive copy (replaces this device) or upload yours (overwrites the drive file)?',
          'Download instead',
          'Upload mine'
        ).then(function (choice) {
          if (choice === 'primary') {
            var pulledAt = syncAdoptRemote(cfg, remotePlain);
            try { render(); } catch (e) { /* ignore */ }
            return pulledAt;
          }
          if (choice === 'secondary') {
            syncSetBusy(true, 'Uploading to ' + syncProviderLabel(cfg.provider) + '…');
            return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
          }
          syncSetStatus('Upload cancelled — drive copy kept.');
          return 'cancelled';
        });
      }, function (decErr) {
        // Drive file exists but this passphrase cannot open it: stop, do not overwrite blindly.
        throw new Error('sync failed: the drive file uses a different passphrase. Enter that passphrase, or clear the drive file first.');
      });
    }, function (dlErr) {
      // Known destination but nothing there (deleted remotely?): recreate it.
      if (dlErr && dlErr.message && dlErr.message.indexOf('no backup found') !== -1) {
        return syncRemoteEnsureFolder(cfg).then(function () {
          return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
        });
      }
      throw dlErr;
    });
  }).then(function (outcome) {
    syncSetBusy(false);
    if (outcome === 'pushed' || outcome === 'adopted' || outcome === 'pulled' || outcome === 'verified') syncPendingRemote = false;
    if (outcome === 'cancelled' || outcome === 'conflict-remote' || outcome === 'adopted' || outcome === 'pulled' || outcome === 'verified') {
      // Dismissals and already-handled outcomes: re-lock the buttons to the
      // connection state but keep the specific status line that was set.
      syncRefreshSyncPanel({ keepStatus: true });
      try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
      if (outcome === 'adopted' || outcome === 'pulled' || outcome === 'verified') {
        priceDataSyncFlow({ automatic: auto });
      }
      return;
    }
    var now = new Date().toISOString();
    cfg.lastSyncAt = now;
    cfg.lastRemoteAt = localAt;
    cfg.lastSyncedHash = curHash;
    cfg.lastLocation = syncLocationKey(cfg);
    cfg.lastIdentity = syncTrustIdentity(cfg);
    cfg.locV = SYNC_LOC_V;
        syncSaveConfig(cfg);
    if (outcome === 'pushed') syncWatchNoteLocalSync();
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    clearBanner();
    syncSetStatus('Synced ' + fmtDateTimeDmy(now) + '.');
    priceDataSyncFlow({ automatic: auto });
    // Attachments ride along: upload this device's blobs (skip-if-exists)
    // after the state lands. Best-effort — state is already synced, blobs
    // retry on the next push, so this never fails the sync itself.
    if (outcome === 'pushed') {
      try {
        syncPushAttachments(cfg, pass).then(function (r) {
          if (r && r.up > 0) syncSetStatus('Synced ' + fmtDateTimeDmy(now) + ' + ' + r.up + ' file' + (r.up === 1 ? '' : 's') + '.');
        });
      } catch (e) { /* blobs retry next push */ }
    }
  }, function (err) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    // Auto-sync fails quietly into the status line (it retries on the next
    // change); only manual attempts raise the banner.
    if (auto) {
      syncSetStatus('Auto-sync will retry on the next change.');
      return;
    }
    showBanner('Sync failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((err && err.message) || err)]
    });
  });
}

function syncPullFlow() {
  if (syncBusy || syncChecking) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  var pass = rd.passphrase;
  if (!pass) {
    showBanner('Enter the sync passphrase to restore.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['The drive copy is encrypted — the passphrase never leaves this browser.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  syncSetBusy(true, 'Downloading from ' + syncProviderLabel(cfg.provider) + '…');
  // Snapshot for the stale-copy comparison only: the backup is validated with
  // parseImportedState() and written after the user confirms, never before.
  var beforeJson = null;
  try {
    beforeJson = exportState(loadState());
  } catch (e) {
    beforeJson = null;
  }
  syncRemoteDownload(cfg).then(function (remoteText) {
    return syncDecryptEnvelope(remoteText, pass);
  }).then(function (plain) {
    var next;
    try {
      next = parseImportedState(plain);
    } catch (e) {
      if (isStorageWriteError(e)) throw e;
      throw new Error('sync failed: the drive backup is invalid (' + String((e && e.message) || e).slice(0, 160) + ').');
    }
    syncSetBusy(false);
    // Stale-drive warning, decided by content — not by a fresh exportedAt
    // stamp (which always reads "now" and cried "older" even when the drive
    // copy was newer). Only when the drive still holds our last sync point
    // while this device moved on is the drive copy truly older.
    var remoteHashP = syncHashOfExport(plain);
    var curBeforeP = '';
    try { curBeforeP = syncHashOfExport(beforeJson || ''); } catch (e) { curBeforeP = ''; }
    var stale = (syncDirection(curBeforeP, remoteHashP, (cfg.lastSyncedHash || '')) === 'local-only');
    return confirmAction(
      stale ? 'Drive copy is older' : 'Replace this device?',
      stale
        ? 'The drive backup is older than this device. Restore it anyway? This replaces all accounts, trades and settings on this device with the older copy.'
        : 'Restore the drive backup here? This replaces all accounts, trades and settings on this device.',
      stale ? 'Restore older copy' : 'Restore backup',
      true
    ).then(function (ok) {
      if (!ok) {
        // Nothing was written before this prompt, so a cancel changes nothing.
        // The drive still disagrees after a cancelled restore (unless the
        // drive copy is simply older): keep the stale icon + panel hint.
        try {
          var curAfter = '';
          try { curAfter = syncHashOfExport(beforeJson || ''); } catch (e5) { curAfter = ''; }
          var dirAfter = syncDirection(curAfter, remoteHashP, (cfg.lastSyncedHash || ''));
          syncPendingRemote = (dirAfter === 'remote-only' || dirAfter === 'conflict');
        } catch (e6) { /* flag stays as-is */ }
        syncSetStatus('Restore cancelled.');
        syncRefreshSyncPanel({ keepStatus: true });
        try { syncRefreshHeaderIcon(); } catch (e3) { /* ignore */ }
        return 'cancelled';
      }
      if (!saveStateGuarded(next)) {
        syncRefreshSyncPanel({ keepStatus: true });
        try { syncRefreshHeaderIcon(); } catch (e4) { /* ignore */ }
        return 'failed';
      }
      cfg.lastSyncAt = new Date().toISOString();
      try {
        var d = JSON.parse(plain);
        if (d && typeof d.exportedAt === 'string') cfg.lastRemoteAt = d.exportedAt;
      } catch (e) { /* ignore */ }
      cfg.lastSyncedHash = syncHashOfExport(plain);
      cfg.lastLocation = syncLocationKey(cfg); // adopt: future pushes update this file
      cfg.locV = SYNC_LOC_V;
      cfg.lastIdentity = syncTrustIdentity(cfg);
      syncPendingRemote = false;
            syncSaveConfig(cfg);
      syncWatchNoteLocalSync();
      syncCancelAuto();
      syncRefreshSyncPanel();
      try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
      clearBanner();
      syncSetStatus('Restored from ' + syncProviderLabel(cfg.provider) + '.');
      refreshPrices();
      priceDataSyncFlow({ automatic: false });
      closeDialog('settings-dialog');
      return 'pulled';
    });
  }, function (err) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    showBanner('Restore failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((err && err.message) || err)]
    });
  });
}

// One remote check, shared by the page-load hook below: download,
// decrypt and reconcile against the last sync point. Never overwrites local
// work blindly — remote-only changes are pulled, local-only changes are left
// for the next push, conflicts only raise the stale flag + status.
// Resolves 'in-sync' | 'pulled' | 'local-only' | 'conflict' | 'skipped' |
// 'unavailable' | 'unreachable' | 'unknown' | 'invalid' | 'busy'. Never rejects.
function syncCheckRemoteNow() {
  if (syncBusy || syncChecking) return Promise.resolve('busy');
  var rd = null;
  try {
    rd = syncReadForm();
  } catch (e) {
    return Promise.resolve('unavailable');
  }
  var cfg = rd.cfg;
  var pass = rd.passphrase;
  if (!syncIsConnected(cfg) || !pass) return Promise.resolve('skipped');
  if (!syncCryptoAvailable()) return Promise.resolve('unavailable');
  syncChecking = true;
  // A push or pull that lands while this read is in flight moves the last
  // sync point. Adopting the older snapshot after it would silently undo the
  // newer upload, so capture the point now and re-check before applying.
  var baseAtStart = cfg.lastSyncedHash || '';
  function done(outcome) {
    syncChecking = false;
    try { syncWatchFlush(); } catch (e) { /* ignore */ }
    return outcome;
  }
  return (function () {
    try { return syncRemoteDownload(cfg); } catch (e8) { return Promise.reject(e8); }
  })().then(function (remoteText) {
    return syncDecryptEnvelope(remoteText, pass);
  }).then(function (remotePlain) {
    if (syncBusy) return done('stale-check');
    var baseNow = '';
    try { baseNow = syncLoadConfig().lastSyncedHash || ''; } catch (e7) { baseNow = baseAtStart; }
    if (baseNow !== baseAtStart) return done('stale-check');
    var remoteHash = syncHashOfExport(remotePlain);
    var curHash = '';
    try {
      curHash = syncCurrentHash();
    } catch (e) {
      curHash = '';
    }
    if (!remoteHash || !curHash) return done('unknown');
    var dir = syncDirection(curHash, remoteHash, cfg.lastSyncedHash || '');
    if (dir === 'in-sync') {
      if (cfg.lastSyncedHash !== curHash) {
        cfg.lastSyncedHash = curHash;
        try {
          var d0 = JSON.parse(remotePlain);
          if (d0 && typeof d0.exportedAt === 'string') cfg.lastRemoteAt = d0.exportedAt;
        } catch (e0) { /* ignore */ }
        syncSaveConfig(cfg);
      }
      syncPendingRemote = false;
      syncRefreshSyncPanel();
      try {
        syncRefreshHeaderIcon();
      } catch (e1) { /* ignore */ }
      return done('in-sync');
    }
    if (dir === 'remote-only') {
      // Safe: this device holds no unsynced work, so adopting loses nothing.
      var pulled = null;
      try {
        pulled = syncAdoptRemote(cfg, remotePlain);
      } catch (e6) {
        return done('invalid');
      }
      if (pulled !== 'pulled') return done(pulled);
      try {
        render();
      } catch (e2) { /* ignore */ }
      syncSetStatus('Pulled newer changes from ' + syncProviderLabel(cfg.provider) + '.');
      return done('pulled');
    }
    if (dir === 'local-only') {
      syncPendingRemote = false;
      if (cfg.autoSync) {
        try {
          syncScheduleAuto();
        } catch (e3) { /* ignore */ }
      }
      syncRefreshSyncPanel();
      try {
        syncRefreshHeaderIcon();
      } catch (e4) { /* ignore */ }
      return done('local-only');
    }
    syncPendingRemote = true;
    if (!cfg.lastSyncedHash) syncSetStatus('Drive holds a copy — open Sync to resolve.');
    else syncSetStatus('Devices disagree — open Sync to resolve.');
    syncRefreshSyncPanel({ keepStatus: true });
    try {
      syncRefreshHeaderIcon();
    } catch (e5) { /* ignore */ }
    return done('conflict');
  }).then(function (outcome) {
    return outcome;
  }, function () {
    // Silent on a background check: offline, missing file, or a passphrase
    // the drive file does not accept. Manual sync still reports these. Also
    // funnels an unexpected throw from the branch above through done() so
    // the in-flight flag can never stick.
    return done('unreachable');
  });
}

// Page-load hook: when this device wakes up behind another one, say so (or
// catch up) instead of claiming "up to date" on local hashes alone. Runs
// once per page load and never breaks boot.
var syncLoadChecked = false;
function syncCheckOnLoad() {
  if (syncLoadChecked) return;
  syncLoadChecked = true;
  try {
    if (syncBusy) return;
    var cfg = null;
    try {
      cfg = syncLoadConfig();
    } catch (e) {
      return;
    }
    var pass = '';
    try {
      pass = syncReadForm().passphrase;
    } catch (e) {
      pass = '';
    }
    if (!pass || !syncCryptoAvailable()) return;
    var check = Promise.resolve('skipped');
    if (syncIsConnected(cfg)) {
      check = syncCheckRemoteNow().then(function (outcome) {
        if (outcome === 'pulled') syncAnnouncePull();
        return outcome;
      }, function () { return 'unreachable'; });
    }
    priceDataStartupPromise = check.then(function () {
      if (syncIsConnected(priceDataDestination(cfg))) {
        return priceDataSyncFlow({ automatic: true });
      }
      return 'skipped';
    }).then(function (outcome) {
      return outcome;
    }, function () {
      return 'failed';
    });
  } catch (e) { /* never break boot */ }
}

// Shared "a newer drive copy landed here" announcement: recount, refresh
// quotes, and show one calm info line. Used by the page-load check and the
// background watcher.
function syncAnnouncePull() {
  var nAcc = 0;
  var nTr = 0;
  try {
    var s = loadState();
    nAcc = (s.accounts || []).length;
    nTr = (s.trades || []).length;
  } catch (e) { /* ignore */ }
  try {
    refreshPrices();
  } catch (e2) { /* ignore */ }
  try {
    showBanner('Pulled newer changes from the drive — this device had no unsynced changes, so nothing was lost (' + nAcc + ' accounts, ' + nTr + ' trades).', 'info', {
      title: 'Sync',
      lines: ['Pulled the newer drive copy (' + nAcc + ' accounts, ' + nTr + ' trades). This device had no unsynced changes, so nothing was lost.']
    });
  } catch (e3) { /* ignore */ }
}

function syncDownloadEncrypted() {
  if (syncBusy) return;
  var pass = uiVal('sy-pass', '');
  if (!pass) {
    showBanner('Enter a sync passphrase first — it encrypts the file.', 'error', {
      title: 'Encrypted file',
      lines: ['Type a passphrase in the Sync tab. It is never sent anywhere.']
    });
    return;
  }
  syncSetBusy(true, 'Encrypting…');
  Promise.resolve().then(function () {
    return syncEncryptEnvelope(exportStateStrict(loadState()), pass);
  }).then(function (env) {
    syncSetBusy(false);
    downloadTextFile('plutus.inoculens.com-' + backupStamp() + '.enc.json', env, 'application/json');
    clearBanner();
    syncSetStatus('Encrypted file downloaded. Keep it or upload it anywhere.');
  }, function (err) {
    syncSetBusy(false);
    showBanner('Encrypt failed.', 'error', {
      title: 'Encrypted file',
      lines: [String((err && err.message) || err)]
    });
  });
}

function syncRestoreEncryptedFile(file) {
  var pass = uiVal('sy-pass', '');
  if (!file) return;
  if (!pass) {
    showBanner('Enter the sync passphrase to open the file.', 'error', {
      title: 'Encrypted file',
      lines: ['The file is encrypted — the passphrase never leaves this browser.']
    });
    return;
  }
  var reader = new FileReader();
  reader.onload = function () {
    syncDecryptEnvelope(String(reader.result), pass).then(function (plain) {
      var next;
      try {
        next = parseImportedState(plain);
      } catch (e) {
        if (isStorageWriteError(e)) {
          showBanner(e.message === 'storage-unreadable' ? 'Save blocked — stored data could not be checked.' : 'Storage unavailable — change was not saved.', 'error', {
            title: e.message === 'storage-unreadable' ? 'Save blocked' : 'Storage error',
            lines: ['Your data was left untouched. Make storage accessible (leave private mode, free space), then retry.']
          });
          return;
        }
        showBanner('Import failed — your data was left untouched.', 'error', {
          title: 'Import error',
          lines: [String((e && e.message) || e)]
        });
        return;
      }
      confirmAction(
        'Replace this device?',
        'Restore this file here? This replaces all accounts, trades and settings on this device.',
        'Restore file',
        true
      ).then(function (ok) {
        if (!ok) {
          // Nothing was written before this prompt, so a cancel changes nothing.
          syncSetStatus('Restore cancelled.');
          return;
        }
        if (!saveStateGuarded(next)) return;
        clearBanner();
        syncSetStatus('Restored from encrypted file.');
        refreshPrices();
        closeDialog('settings-dialog');
      });
    }, function (err) {
      showBanner('Import failed — your data was left untouched.', 'error', {
        title: 'Import error',
        lines: [String((err && err.message) || err)]
      });
    });
  };
  reader.onerror = function () {
    showBanner('Import failed — could not read the file.', 'error', {
      title: 'Import error',
      lines: ['Pick an INOCULENS PLUTUS encrypted backup (.enc.json) and retry.']
    });
  };
  reader.readAsText(file);
}
