'use strict';
// Wipe every byte this app keeps in the browser (Clear all data).

// Everything this app keeps in the browser besides the main state. The
// cookie-consent choice is deliberately NOT listed: it holds no personal data
// and keeping it stops the banner from reappearing after a wipe.
var WIPE_LOCAL_KEYS = [
  'inoculens.sync.v1', 'inoculens.price-data-sync.v1', 'inoculens.oauth.v1',
  'inoculens.fxcache.v1', 'inoculens.histcache.v1', 'inoculens.tradepagesize.v1',
  'plutus.networth-history.v1', 'plutus.networth-history-ranges.v1'
];
var WIPE_IDB_NAMES = ['inoculens.plutus.attachments', 'plutus.networth-history'];

// Resolves (never rejects) once the database is gone, blocked or unavailable.
// A blocked delete still completes when the page reloads and the last
// connection closes, so waiting on it forever would only freeze the UI.
function wipeIndexedDb(name) {
  return new Promise(function (resolve) {
    try {
      if (typeof indexedDB === 'undefined') { resolve(false); return; }
      var req = indexedDB.deleteDatabase(name);
      req.onsuccess = function () { resolve(true); };
      req.onerror = function () { resolve(false); };
      req.onblocked = function () { resolve(false); };
    } catch (e) { resolve(false); }
  });
}

function wipeAllBrowserData() {
  WIPE_LOCAL_KEYS.forEach(function (k) {
    try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
  });
  return Promise.all(WIPE_IDB_NAMES.map(wipeIndexedDb));
}
