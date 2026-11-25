'use strict';
// Sync: background watchers. Open devices follow both drive files without
// reloads.
//
// The page-load check only runs once, so a second device left open would sit
// on stale data forever. Every SYNC_WATCH_MS the provider is asked for a
// cheap change stamp (ETag / rev / modifiedTime); Price Data is downloaded
// and merged only when its own destination stamp changes. Paused while a
// dialog, confirm or text field owns the screen.
var SYNC_WATCH_MS = 10000;
var SYNC_WATCH_UNKNOWN_EVERY = 6; // providers with no cheap stamp: full check ~1/min
var syncWatchTimer = null;
var syncWatchWired = false;
var syncWatchStamp = '';
var syncWatchSeen = false;
var syncWatchUnknown = 0;
var syncWatchLoc = '';
var syncWatchQuietNext = false;
var priceDataWatchBusy = false;
var priceDataWatchStamp = '';
var priceDataWatchSeen = false;
var priceDataWatchUnknown = 0;
var priceDataWatchLoc = '';

// Our own push/pull just moved the drive. The next tick still verifies the
// file (another device may have pushed in between) but stays quiet instead of
// spinning the cloud for the copy we ourselves wrote.
function syncWatchNoteLocalSync() {
  syncWatchQuietNext = true;
}

function syncWatchInputBusy() {
  try {
    var el = document.activeElement;
    if (!el) return false;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
  } catch (e) { /* ignore */ }
  return false;
}

function syncWatchDialogBusy() {
  if (typeof document === 'undefined') return false;
  try {
    for (var i = 0; i < MODAL_IDS.length; i++) {
      var d = document.getElementById(MODAL_IDS[i]);
      if (d && d.open) return true;
    }
  } catch (e) { /* ignore */ }
  if (typeof confirmSettle !== 'undefined' && confirmSettle) return true;
  if (typeof confirmSettle3 !== 'undefined' && confirmSettle3) return true;
  return false;
}

// Queued by a manual push that arrived while a background read owned the
// connection; run right after that read settles so the newest state still
// goes up.
function syncWatchFlush() {
  if (syncAfterCheck === 'push' || syncAfterCheck === 'auto') {
    var auto = syncAfterCheck === 'auto';
    syncAfterCheck = '';
    try { syncPushFlow({ auto: auto }); } catch (e) { /* ignore */ }
  }
}

function priceDataWatchTick() {
  if (syncBusy || syncChecking || priceDataSyncBusy || priceDataWatchBusy) return Promise.resolve('busy');
  try {
    if (typeof document === 'undefined' || document.hidden) return Promise.resolve('hidden');
    if (syncWatchDialogBusy() || syncWatchInputBusy()) return Promise.resolve('ui-busy');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve('offline');
    var rd = syncReadForm();
    var cfg = priceDataDestination(rd.cfg);
    var pass = rd.passphrase;
    if (!syncIsConnected(cfg) || !pass || !syncCryptoAvailable()) return Promise.resolve('skipped');
    var locKey = syncLocationKey(cfg);
    if (locKey !== priceDataWatchLoc) {
      priceDataWatchLoc = locKey;
      priceDataWatchStamp = '';
      priceDataWatchSeen = false;
      priceDataWatchUnknown = 0;
    }
    priceDataWatchBusy = true;
    return syncRemoteStamp(cfg).then(function (stamp) {
      stamp = stamp || '';
      if (stamp && priceDataWatchSeen && stamp === priceDataWatchStamp) return 'same';
      if (!stamp) {
        priceDataWatchUnknown++;
        if (priceDataWatchSeen && (priceDataWatchUnknown % SYNC_WATCH_UNKNOWN_EVERY) !== 0) return 'throttled';
      } else {
        priceDataWatchUnknown = 0;
      }
      priceDataWatchStamp = stamp;
      priceDataWatchSeen = true;
      return priceDataSyncFlow({ automatic: true }).then(function (outcome) {
        if (outcome === 'failed' || outcome === 'skipped' || outcome === 'busy') priceDataWatchSeen = false;
        return outcome;
      });
    }).then(function (outcome) {
      priceDataWatchBusy = false;
      return outcome;
    }, function () {
      priceDataWatchBusy = false;
      priceDataWatchSeen = false;
      return 'unreachable';
    });
  } catch (e) {
    priceDataWatchBusy = false;
    return Promise.resolve('unavailable');
  }
}

function syncWatchTickAll() {
  return Promise.resolve().then(function () {
    return syncWatchTick();
  }).then(function () {
    return priceDataWatchTick();
  }, function () {
    return priceDataWatchTick();
  });
}

function syncWatchTick() {
  if (syncBusy || syncChecking) return Promise.resolve('busy');
  try {
    if (typeof document === 'undefined') return Promise.resolve('unavailable');
    if (document.hidden) return Promise.resolve('hidden');
    if (syncWatchDialogBusy()) return Promise.resolve('dialog');
    if (syncWatchInputBusy()) return Promise.resolve('typing');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve('offline');
    var rd = syncReadForm();
    var cfg = rd.cfg;
    var pass = rd.passphrase;
    if (!syncIsConnected(cfg) || !pass || !syncCryptoAvailable()) return Promise.resolve('skipped');
    var locKey = syncLocationKey(cfg);
    if (locKey !== syncWatchLoc) {
      syncWatchLoc = locKey;
      syncWatchStamp = '';
      syncWatchSeen = false;
      syncWatchUnknown = 0;
    }
    return syncRemoteStamp(cfg).then(function (stamp) {
      stamp = stamp || '';
      var have = !!stamp;
      if (have && syncWatchSeen && stamp === syncWatchStamp) return 'same';
      if (!have) {
        syncWatchUnknown++;
        // No cheap validator (odd server / provider): a full check is the
        // only way to know, so run it on a slower cadence instead of
        // downloading and decrypting every tick.
        if (syncWatchSeen && (syncWatchUnknown % SYNC_WATCH_UNKNOWN_EVERY) !== 0) return 'throttled';
      } else {
        syncWatchUnknown = 0;
      }
      var hadBaseline = syncWatchSeen;
      var quiet = syncWatchQuietNext;
      syncWatchQuietNext = false;
      syncWatchStamp = stamp;
      syncWatchSeen = true;
      // Only spin the cloud when the drive really moved, not on the first
      // quiet baseline read of a session or right after our own upload.
      var showBusy = have && hadBaseline && !quiet;
      if (showBusy) {
        syncWatchBusy = true;
        try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
      }
      function settle(outcome) {
        if (showBusy) {
          syncWatchBusy = false;
          try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
        }
        return outcome;
      }
      return syncCheckRemoteNow().then(function (outcome) {
        if (outcome === 'pulled') syncAnnouncePull();
        else if (outcome !== 'in-sync' && outcome !== 'local-only' && outcome !== 'conflict' && stamp !== 'missing') {
          // Offline, raced or unreadable: forget the baseline so the next
          // tick re-verifies instead of trusting a stamp we never checked.
          // A file the provider confirmed missing is a real baseline (no
          // repeated downloads until it appears).
          syncWatchSeen = false;
        }
        return settle(outcome);
      }, function () {
        syncWatchSeen = false;
        return settle('unreachable');
      });
    }, function () {
      return 'unreachable';
    });
  } catch (e) {
    return Promise.resolve('unavailable');
  }
}

function syncWatchStart() {
  try {
    if (typeof setInterval === 'undefined' || typeof document === 'undefined') return false;
    if (!syncWatchWired) {
      syncWatchWired = true;
      try {
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) { try { syncWatchTickAll(); } catch (e) { /* ignore */ } }
        });
      } catch (e) { /* ignore */ }
      try {
        window.addEventListener('focus', function () { try { syncWatchTickAll(); } catch (e) { /* ignore */ } });
      } catch (e) { /* ignore */ }
      try {
        window.addEventListener('pageshow', function () { try { syncWatchTickAll(); } catch (e) { /* ignore */ } });
      } catch (e) { /* ignore */ }
    }
    if (syncWatchTimer) return true;
    syncWatchTimer = setInterval(function () {
      try { syncWatchTickAll(); } catch (e) { /* a tick never breaks the page */ }
    }, SYNC_WATCH_MS);
    return true;
  } catch (e) {
    return false;
  }
}

function syncWatchStop() {
  if (syncWatchTimer) {
    try { clearInterval(syncWatchTimer); } catch (e) { /* ignore */ }
    syncWatchTimer = null;
  }
  return true;
}
