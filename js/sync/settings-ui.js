'use strict';
// Sync: the Sync and Price Data tabs of the Settings dialog.

function syncReadForm() {
  var cfg = syncLoadConfig();
  function val(id, fb) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    return el ? el.value : fb;
  }
  function checked(id, fb) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    if (!el) return !!fb;
    return !!el.checked;
  }
  var prov = val('sy-provider', cfg.provider);
  if (syncIsProvider(prov)) cfg.provider = prov;
  if (cfg.provider === 'webdav') {
    cfg.url = val('sy-url', cfg.url);
    cfg.username = val('sy-user', cfg.username);
    cfg.filename = syncSanitizeFilename(val('sy-filename', cfg.filename));
    var pwField = val('sy-passwd', '');
    cfg.rememberPassword = checked('sy-remember', cfg.rememberPassword);
    if (cfg.rememberPassword) {
      if (pwField !== '') cfg.password = pwField;
    } else {
      cfg.password = '';
      if (pwField !== '') syncMemSecrets.password = pwField;
    }
  } else if (cfg.provider === 'megas3') {
    cfg.endpoint = val('sy-endpoint', cfg.endpoint);
    cfg.region = val('sy-region', cfg.region);
    cfg.bucket = val('sy-bucket', cfg.bucket);
    cfg.accessKey = val('sy-key', cfg.accessKey);
    cfg.objectKey = syncSanitizeFilename(val('sy-object', cfg.objectKey));
    cfg.folder = val('sy-folder3', cfg.folder);
    var skField = val('sy-skey', '');
    var rememberSk = checked('sy-remember2', cfg.rememberSecret);
    cfg.rememberSecret = rememberSk;
    if (rememberSk) {
      if (skField !== '') cfg.secretKey = skField;
    } else {
      cfg.secretKey = '';
      if (skField !== '') syncMemSecrets.secretKey = skField;
    }
  } else {
    cfg.clientId = val('sy-client', cfg.clientId);
    cfg.clientSecret = val('sy-secret', cfg.clientSecret);
    var fn = val('sy-filename2', cfg.filename);
    cfg.filename = syncSanitizeFilename(fn);
    cfg.folder = val('sy-folder2', cfg.folder);
  }
  var out = syncSanitizeConfig(cfg);
  out.autoSync = !!checked('sy-auto', cfg.autoSync);
  var formPass = val('sy-pass', '');
  var rememberPass = checked('sy-remember-pass', cfg.rememberPassphrase);
  out.rememberPassphrase = rememberPass;
  if (rememberPass) {
    if (formPass !== '') out.passphrase = formPass;
  } else {
    out.passphrase = '';
  }
  var passphrase = formPass || out.passphrase;
  return { cfg: out, passphrase: passphrase };
}

function syncPersistFormSecrets(cfg) {
  var el, memPw, memSk;
  if (typeof document === 'undefined') return;
  if (cfg.provider === 'webdav') {
    el = document.getElementById('sy-passwd');
    memPw = el ? el.value : '';
    if (cfg.rememberPassword) {
      if (memPw !== '') cfg.password = memPw;
      syncMemSecrets.password = '';
    } else {
      cfg.password = '';
      if (memPw !== '') syncMemSecrets.password = memPw;
    }
  }
  if (cfg.provider === 'megas3') {
    el = document.getElementById('sy-skey');
    memSk = el ? el.value : '';
    if (cfg.rememberSecret) {
      if (memSk !== '') cfg.secretKey = memSk;
      syncMemSecrets.secretKey = '';
    } else {
      cfg.secretKey = '';
      if (memSk !== '') syncMemSecrets.secretKey = memSk;
    }
  }
  syncSaveConfig(cfg);
}

function syncSetVal(id, v) {
  var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
  if (el) el.value = v;
}

function syncRefreshSyncPanel(opts) {
  if (typeof document === 'undefined') return;
  if (!document.getElementById('sy-provider')) return;
  var cfg = syncLoadConfig();
  syncSetVal('sy-provider', cfg.provider);
  var groups = { webdav: 'sy-g-webdav', gdrive: 'sy-g-oauth', dropbox: 'sy-g-oauth', megas3: 'sy-g-megas3' };
  var i, g;
  var ids = ['sy-g-webdav', 'sy-g-oauth', 'sy-g-megas3'];
  for (i = 0; i < ids.length; i++) {
    g = document.getElementById(ids[i]);
    if (g) g.hidden = (groups[cfg.provider] !== ids[i]);
  }
  var hint = document.getElementById('sy-hint');
  if (hint) { hint.setAttribute('data-info', SYNC_HINTS[cfg.provider] || ''); hint.setAttribute('aria-label', SYNC_HINTS[cfg.provider] || 'More info'); hint.hidden = !SYNC_HINTS[cfg.provider]; }
  var sec = document.getElementById('sy-g-secret');
  if (sec) sec.hidden = (cfg.provider !== 'gdrive');
  var redir = document.getElementById('sy-redirect');
  if (redir) {
    var ru = syncRedirectUri();
    redir.textContent = (cfg.provider === 'webdav' || cfg.provider === 'megas3')
      ? ''
      : (ru || 'Open the hosted https:// page — OAuth cannot start from file://.');
  }
  var sharedNow = syncSharedId(cfg.provider);
  var note = document.getElementById('sy-oneclick-note');
  if (note) {
    note.textContent = sharedNow
      ? 'One-click sign-in ready'
      : 'Add your own OAuth app below';
  }
  var adv = document.getElementById('sy-adv');
  if (adv) {
    try { adv.open = !sharedNow; } catch (e) { /* ignore */ }
  }
  if (cfg.provider === 'webdav') {
    syncSetVal('sy-url', cfg.url);
    syncSetVal('sy-user', cfg.username);
    if (cfg.password) syncSetVal('sy-passwd', cfg.password);
    syncSetVal('sy-filename', syncDisplayBasename(cfg.filename));
    var rem = document.getElementById('sy-remember');
    if (rem) rem.checked = cfg.rememberPassword;
  } else if (cfg.provider === 'megas3') {
    syncSetVal('sy-endpoint', cfg.endpoint);
    syncSetVal('sy-region', cfg.region);
    syncSetVal('sy-bucket', cfg.bucket);
    syncSetVal('sy-key', cfg.accessKey);
    if (cfg.secretKey) syncSetVal('sy-skey', cfg.secretKey);
    syncSetVal('sy-object', syncDisplayBasename(cfg.objectKey));
    syncSetVal('sy-folder3', cfg.folder);
    var rem2 = document.getElementById('sy-remember2');
    if (rem2) rem2.checked = !!cfg.rememberSecret;
  } else {
    syncSetVal('sy-client', cfg.clientId);
    if (cfg.clientSecret) syncSetVal('sy-secret', cfg.clientSecret);
    syncSetVal('sy-filename2', syncDisplayBasename(cfg.filename));
    syncSetVal('sy-folder2', cfg.folder);
  }
  var connected = syncIsConnected(cfg);
  var autoBox = document.getElementById('sy-auto');
  if (autoBox) autoBox.checked = !!cfg.autoSync;
  if (cfg.passphrase) syncSetVal('sy-pass', cfg.passphrase);
  var rememberPassBox = document.getElementById('sy-remember-pass');
  if (rememberPassBox) rememberPassBox.checked = !!cfg.rememberPassphrase;
  var last = cfg.lastSyncAt ? (' Last sync ' + fmtDateTimeDmy(cfg.lastSyncAt) + '.') : '';
  // keepStatus: early exits (cancel/dismiss/conflict) already set a specific
  // status line — refresh buttons + indicator but leave their message alone.
  var keepStatus = !!(opts && opts.keepStatus);
  if (!syncBusy && !keepStatus) syncSetStatus((connected ? ('Connected to ' + syncProviderLabel(cfg.provider) + '.') : 'Not connected.') + last + (syncPendingRemote ? ' Drive and this device disagree — open Sync to resolve.' : ''));
  // Connection state is unmistakable on every visit: Connect locks once
  // established, Disconnect unlocks, and the status line turns green.
  // (While busy, syncSetBusy owns the disabled flags — don't fight it.)
  if (!syncBusy) {
    var connectBtn = document.getElementById('sy-connect');
    if (connectBtn) connectBtn.disabled = connected;
    var disconnectBtn = document.getElementById('sy-disconnect');
    if (disconnectBtn) disconnectBtn.disabled = !connected;
  }
  var statusEl = document.getElementById('sy-status');
  if (statusEl && statusEl.classList) {
    try {
      if (connected) statusEl.classList.add('sync-live');
      else statusEl.classList.remove('sync-live');
    } catch (e) { /* ignore */ }
  }
  var fp = document.getElementById('sy-fp');
  var passEl = document.getElementById('sy-pass');
  if (fp && passEl && passEl.value) {
    var v0 = passEl.value;
    syncFingerprint(v0).then(function (f) {
      var cur = document.getElementById('sy-pass');
      if (cur && cur.value === v0) {
        var fel = document.getElementById('sy-fp');
        if (fel) fel.textContent = 'Key fingerprint ' + (f || '—');
      }
    });
  } else if (fp) {
    fp.textContent = 'Key fingerprint —';
  }
  try { syncToggleEncButtons(); } catch (e) { /* ignore */ }
  try { priceDataRefreshPanel(); } catch (e2) { /* separate cache settings must not break Records Data sync */ }
}

function priceDataSetVal(id, value) {
  var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
  if (el) el.value = value == null ? '' : value;
}

function priceDataReadForm() {
  var cfg = priceDataLoadConfig();
  function val(id, fallback) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    return el ? el.value : fallback;
  }
  function checked(id, fallback) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    return el ? !!el.checked : !!fallback;
  }
  cfg.sameAsRecords = checked('pd-same', cfg.sameAsRecords);
  if (cfg.sameAsRecords) return priceDataSanitizeConfig(cfg);
  var provider = val('pd-provider', cfg.provider);
  if (syncIsProvider(provider)) cfg.provider = provider;
  cfg.filename = priceDataSanitizeFilename(val('pd-filename', cfg.filename));
  cfg.objectKey = cfg.filename;
  cfg.folder = syncNormalizeFolder(val('pd-folder', cfg.folder));
  if (cfg.provider === 'webdav') {
    cfg.url = val('pd-url', cfg.url).trim().slice(0, 512);
    cfg.username = val('pd-user', cfg.username).slice(0, 256);
    var password = val('pd-passwd', '');
    cfg.rememberPassword = checked('pd-remember', cfg.rememberPassword);
    if (cfg.rememberPassword) {
      if (password) cfg.password = password;
    } else {
      cfg.password = '';
      if (password) syncMemSecrets.pricePassword = password;
    }
  } else if (cfg.provider === 'megas3') {
    cfg.endpoint = val('pd-endpoint', cfg.endpoint).trim().replace(/\/+$/, '').slice(0, 256);
    cfg.region = val('pd-region', cfg.region).trim().slice(0, 64);
    cfg.bucket = val('pd-bucket', cfg.bucket).trim().slice(0, 128);
    cfg.accessKey = val('pd-key', cfg.accessKey).trim().slice(0, 256);
    var secret = val('pd-skey', '');
    cfg.rememberSecret = checked('pd-remember2', cfg.rememberSecret);
    if (cfg.rememberSecret) {
      if (secret) cfg.secretKey = secret;
    } else {
      cfg.secretKey = '';
      if (secret) syncMemSecrets.priceSecretKey = secret;
    }
  }
  return priceDataSanitizeConfig(cfg);
}

function priceDataRefreshPanel() {
  if (typeof document === 'undefined' || !document.getElementById('pd-same')) return;
  var cfg = priceDataLoadConfig();
  var same = document.getElementById('pd-same');
  if (same) same.checked = !!cfg.sameAsRecords;
  var independent = document.getElementById('pd-independent');
  if (independent) independent.hidden = !!cfg.sameAsRecords;
  priceDataSetVal('pd-provider', cfg.provider);
  priceDataSetVal('pd-filename', syncDisplayBasename(cfg.filename));
  priceDataSetVal('pd-folder', cfg.folder);
  priceDataSetVal('pd-url', cfg.url);
  priceDataSetVal('pd-user', cfg.username);
  if (cfg.password) priceDataSetVal('pd-passwd', cfg.password);
  priceDataSetVal('pd-endpoint', cfg.endpoint);
  priceDataSetVal('pd-region', cfg.region);
  priceDataSetVal('pd-bucket', cfg.bucket);
  priceDataSetVal('pd-key', cfg.accessKey);
  if (cfg.secretKey) priceDataSetVal('pd-skey', cfg.secretKey);
  var rem = document.getElementById('pd-remember');
  if (rem) rem.checked = !!cfg.rememberPassword;
  var rem2 = document.getElementById('pd-remember2');
  if (rem2) rem2.checked = !!cfg.rememberSecret;
  var groups = { webdav: 'pd-g-webdav', gdrive: 'pd-g-oauth', dropbox: 'pd-g-oauth', megas3: 'pd-g-megas3' };
  ['pd-g-webdav', 'pd-g-oauth', 'pd-g-megas3'].forEach(function (id) {
    var group = document.getElementById(id);
    if (group) group.hidden = !!cfg.sameAsRecords || groups[cfg.provider] !== id;
  });
  var status = document.getElementById('pd-status');
  if (status && !priceDataSyncBusy) {
    status.textContent = cfg.sameAsRecords
      ? 'Stored with your records.'
      : 'Price history destination: ' + syncProviderLabel(cfg.provider) + ' / ' + cfg.filename;
  }
}

function priceDataSaveForm() {
  var cfg = priceDataReadForm();
  return priceDataSaveConfig(cfg);
}

function priceDataConnectOAuth(cfg) {
  if (cfg.provider === 'gdrive') {
    return syncGoogleOneClick(cfg).then(function (tokens) {
      cfg.tokens = tokens;
      priceDataSaveConfig(cfg);
      return true;
    });
  }
  if (cfg.provider !== 'dropbox') return Promise.reject(new Error('Choose a supported Price Data provider.'));
  var clientId = syncSharedId('dropbox') || cfg.clientId;
  var redirect = syncRedirectUri();
  if (!clientId) return Promise.reject(new Error('Dropbox one-click sign-in is not configured.'));
  if (!redirect) return Promise.reject(new Error('OAuth needs the hosted https:// page.'));
  return syncPkcePair().then(function (pair) {
    return new Promise(function (resolve, reject) {
      var state = 'plutus-price-dropbox-' + syncB64UrlEncode(syncRandomBytes(12));
      var url = syncOAuthAuthUrl('dropbox', clientId, redirect, pair.challenge, state);
      var popup = null;
      try { popup = window.open(url, 'plutus-price-oauth', 'width=540,height=680'); } catch (e) { popup = null; }
      if (!popup) {
        reject(new Error('Popup blocked — allow popups for this page, then try again.'));
        return;
      }
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        reject(new Error('Dropbox sign-in was cancelled or timed out.'));
      }, 180000);
      var startedAt = Date.now();
      function onMessage(event) {
        var data = event && event.data;
        if (!data || data.type !== 'plutus-oauth' || data.state !== state) return;
        if (event.origin !== window.location.origin || done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (syncOAuthExpired(startedAt)) {
          reject(new Error('Dropbox sign-in expired — try again.'));
          return;
        }
        if (data.error || !data.code) {
          reject(new Error(data.error || 'Dropbox sign-in returned no authorization code.'));
          return;
        }
        syncOAuthTokenExchange('dropbox', cfg, data.code, pair.verifier).then(resolve, reject);
      }
      window.addEventListener('message', onMessage);
    });
  }).then(function (tokens) {
    cfg.tokens = tokens;
    priceDataSaveConfig(cfg);
    return true;
  });
}

function priceDataConnectFlow() {
  var cfg = priceDataReadForm();
  if (cfg.sameAsRecords) return priceDataSyncFlow({ manual: true });
  cfg.priceDataAuth = true;
  priceDataSaveConfig(cfg);
  var status = document.getElementById('pd-status');
  if (status) status.textContent = 'Connecting to ' + syncProviderLabel(cfg.provider) + '…';
  var connected;
  if (cfg.provider === 'gdrive' || cfg.provider === 'dropbox') {
    connected = priceDataConnectOAuth(cfg);
  } else {
    connected = Promise.resolve(true);
  }
  return connected.then(function () {
    return priceDataSyncFlow({ manual: true });
  }).catch(function (err) {
    priceDataReportFailure(err, false);
    throw err;
  });
}

function priceDataWireSettings() {
  if (typeof document === 'undefined') return;
  var checkbox = document.getElementById('pd-same');
  if (checkbox && !checkbox.getAttribute('data-wired')) {
    checkbox.setAttribute('data-wired', '1');
    checkbox.addEventListener('change', function () {
      priceDataSaveForm();
      priceDataRefreshPanel();
    });
  }
  var provider = document.getElementById('pd-provider');
  if (provider && !provider.getAttribute('data-wired')) {
    provider.setAttribute('data-wired', '1');
    provider.addEventListener('change', function () {
      priceDataSaveForm();
      priceDataRefreshPanel();
    });
  }
  ['pd-filename', 'pd-folder', 'pd-url', 'pd-user', 'pd-passwd', 'pd-endpoint', 'pd-region',
    'pd-bucket', 'pd-key', 'pd-skey', 'pd-remember', 'pd-remember2'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && !el.getAttribute('data-wired')) {
      el.setAttribute('data-wired', '1');
      el.addEventListener('change', priceDataSaveForm);
    }
  });
  var connect = document.getElementById('pd-connect');
  if (connect && !connect.getAttribute('data-wired')) {
    connect.setAttribute('data-wired', '1');
    connect.addEventListener('click', function () {
      priceDataConnectFlow().catch(function () {});
    });
  }
  var sync = document.getElementById('pd-sync');
  if (sync && !sync.getAttribute('data-wired')) {
    sync.setAttribute('data-wired', '1');
    sync.addEventListener('click', function () {
      priceDataSyncFlow({ manual: true }).catch(function () {});
    });
  }
}

function syncClearOAuthAttempt() {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SYNC_OAUTH_KEY);
  } catch (e) { /* ignore */ }
}

function syncPassphraseOrBanner() {
  var pass = '';
  try {
    var el = (typeof document !== 'undefined') ? document.getElementById('sy-pass') : null;
    pass = el ? el.value : '';
    if (!pass) {
      var cfg = syncLoadConfig();
      if (cfg.rememberPassphrase && cfg.passphrase) pass = cfg.passphrase;
    }
  } catch (e) { pass = ''; }
  if (!pass) {
    showBanner('Enter a sync passphrase first — sync only works encrypted.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['Type a passphrase in the Sync tab. It encrypts everything you upload and is never sent anywhere.']
    });
    return null;
  }
  return pass;
}

function syncStartOAuth() {
  if (syncBusy) return;
  if (!syncPassphraseOrBanner()) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  // WebDAV / MEGA have no OAuth dance: Connect simply tests the login.
  if (cfg.provider !== 'gdrive' && cfg.provider !== 'dropbox') {
    syncTestConnection();
    return;
  }
  if (!syncCryptoAvailable()) {
    showBanner('This browser cannot do encrypted sync (WebCrypto unavailable).', 'error', {
      title: 'Sync unavailable',
      lines: ['Use Download backup in the Backup & restore tab instead.']
    });
    return;
  }
  var shared = syncSharedId(cfg.provider);
  var clientId = shared || cfg.clientId;
  if (!clientId) {
    showBanner('One-click sign-in is not set up for ' + syncProviderLabel(cfg.provider) + ' yet.', 'error', {
      title: 'Connect',
      lines: ['Expand "Bring your own OAuth app" below, create an app with the provider, register the redirect URI shown, then paste its client ID.']
    });
    return;
  }
  if (cfg.provider === 'gdrive' && !shared && !cfg.clientSecret) {
    showBanner('Enter the OAuth client secret too (Google needs it for your own app).', 'error', {
      title: 'Connect',
      lines: ['Google Web-application clients always have a secret — paste it alongside the client ID.']
    });
    return;
  }
  // Google one-click uses Google's own sign-in library (loaded only now,
  // never on page load): no secret, no redirect URI, just your login.
  if (cfg.provider === 'gdrive' && shared) {
    syncPersistFormSecrets(cfg);
    syncSetBusy(true, 'Waiting for ' + syncProviderLabel(cfg.provider) + '…');
    syncGoogleOneClick(cfg).then(function (tok) {
      cfg.tokens = tok;
      syncSaveConfig(cfg);
      syncSetBusy(false);
      syncConnectThenSync();
    }, function (err) {
      syncSetBusy(false);
      syncRefreshSyncPanel();
      showBanner('Sign-in failed — your data was left untouched.', 'error', {
        title: 'Connect',
        lines: [String((err && err.message) || err)]
      });
    });
    return;
  }
  var redirect = syncRedirectUri();
  if (!redirect) {
    showBanner('OAuth needs the hosted https:// page.', 'error', {
      title: 'Connect',
      lines: ['Sign-in cannot start from a file:// window. Open your deployed site URL, then connect.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  syncClearOAuthAttempt();
  syncSetBusy(true, 'Waiting for ' + syncProviderLabel(cfg.provider) + '…');
  syncPkcePair().then(function (pair) {
    var state = 'plutus-' + cfg.provider + '-' + syncB64UrlEncode(syncRandomBytes(12));
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SYNC_OAUTH_KEY, JSON.stringify({ state: state, provider: cfg.provider, at: Date.now() }));
      }
    } catch (e) { /* ignore */ }
    var url = syncOAuthAuthUrl(cfg.provider, clientId, redirect, pair.challenge, state);
    var popup = null;
    try {
      popup = window.open(url, 'plutus-oauth', 'width=540,height=680');
    } catch (e) {
      popup = null;
    }
    if (!popup) {
      syncSetBusy(false);
      showBanner('Popup blocked — allow popups for this page, then try Connect again.', 'error', {
        title: 'Connect',
        lines: ['The drive sign-in opens in a popup window.']
      });
      return;
    }
    var done = false;
    var timer = null;
    var startedAt = Date.now();
    function onMsg(e) {
      var d = e && e.data;
      if (!d || d.type !== 'plutus-oauth') return;
      try {
        if (e.origin !== window.location.origin) return;
      } catch (e2) { /* ignore */ }
      if (!d.state || d.state !== state) return;
      if (done) return;
      done = true;
      syncClearOAuthAttempt();
      if (syncOAuthExpired(startedAt)) {
        try { window.removeEventListener('message', onMsg); } catch (e3) { /* ignore */ }
        try { if (timer) clearInterval(timer); } catch (e4) { /* ignore */ }
        syncSetBusy(false);
        showBanner('Sign-in expired — try Connect again.', 'error', { title: 'Connect', lines: ['The authorization window stayed open too long.'] });
        return;
      }
      try { window.removeEventListener('message', onMsg); } catch (e3) { /* ignore */ }
      try { if (timer) clearInterval(timer); } catch (e4) { /* ignore */ }
      if (d.error) {
        syncSetBusy(false);
        showBanner('Sign-in refused by the provider.', 'error', {
          title: 'Connect',
          lines: [String(d.error).slice(0, 200)]
        });
        return;
      }
      syncOAuthTokenExchange(cfg.provider, cfg, d.code, pair.verifier).then(function (tok) {
        cfg.tokens = tok;
        syncSaveConfig(cfg);
        syncSetBusy(false);
        syncConnectThenSync();
      }, function (err) {
        syncSetBusy(false);
        showBanner('Sign-in failed — your data was left untouched.', 'error', {
          title: 'Connect',
          lines: [String((err && err.message) || err)]
        });
      });
    }
    try { window.addEventListener('message', onMsg); } catch (e5) { /* ignore */ }
    timer = setInterval(function () {
      var closed = false;
      try { closed = !popup || popup.closed; } catch (e6) { closed = true; }
      if (closed) {
        try { clearInterval(timer); } catch (e7) { /* ignore */ }
        try { window.removeEventListener('message', onMsg); } catch (e8) { /* ignore */ }
        if (!done) {
          done = true;
          syncSetBusy(false);
          syncRefreshSyncPanel();
        }
      }
    }, 500);
  }, function () {
    syncSetBusy(false);
    showBanner('Could not start sign-in (WebCrypto unavailable).', 'error', {
      title: 'Connect',
      lines: ['Use Download backup in the Backup & restore tab instead.']
    });
  });
}

function syncDisconnect() {
  var cfg = syncLoadConfig();
  // Forget the whole connection: tokens, remembered passwords/keys and
  // session secrets — plus the location trust, so the next push treats the
  // destination as unknown and refuses to blindly overwrite it.
  // Boring config (provider, urls, names) stays.
  cfg.tokens = null;
  cfg.password = '';
  cfg.rememberPassword = false;
  cfg.secretKey = '';
  cfg.rememberSecret = false;
  cfg.passphrase = '';
  cfg.rememberPassphrase = false;
  cfg.lastLocation = null;
  cfg.locV = null;
  cfg.lastIdentity = null;
  cfg.lastSyncedHash = null;
  cfg.lastRemoteAt = null;
  cfg.lastSyncAt = null;
    syncMemSecrets.password = '';
  syncMemSecrets.secretKey = '';
  syncSaveConfig(cfg);
  syncClearOAuthAttempt();
  syncSetVal('sy-passwd', '');
  syncSetVal('sy-skey', '');
  syncSetVal('sy-pass', '');
  var rememberPassBox = (typeof document !== 'undefined') ? document.getElementById('sy-remember-pass') : null;
  if (rememberPassBox) rememberPassBox.checked = false;
  syncRefreshSyncPanel();
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  clearBanner();
}

// Google one-click sign-in via Google's own sign-in library. The script is
// loaded lazily on first Connect — never on page load — and only needs the
// public client ID: you just log in with Google, no app to register.
var syncGisLoading = null;

function syncLoadGis() {
  try {
    if (typeof window !== 'undefined' && window.google && window.google.accounts && window.google.accounts.oauth2) {
      return Promise.resolve(window.google.accounts.oauth2);
    }
  } catch (e) { /* ignore */ }
  if (syncGisLoading) return syncGisLoading;
  syncGisLoading = new Promise(function (resolve, reject) {
    try {
      if (typeof document === 'undefined') throw new Error('sync failed: cannot load Google sign-in here.');
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = function () {
        try {
          resolve(window.google.accounts.oauth2);
        } catch (e) {
          syncGisLoading = null;
          reject(new Error('sync failed: could not start Google sign-in.'));
        }
      };
      s.onerror = function () {
        syncGisLoading = null;
        reject(new Error('sync failed: could not load Google sign-in. Check your connection.'));
      };
      document.head.appendChild(s);
    } catch (e) {
      syncGisLoading = null;
      reject(e);
    }
  });
  return syncGisLoading;
}

function syncGoogleOneClick(cfg) {
  return syncLoadGis().then(function (oauth2) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = null;
      try {
        if (typeof setTimeout !== 'undefined') {
          timer = setTimeout(function () {
            if (done) return;
            done = true;
            reject(new Error('sync cancelled — the Google window was closed.'));
          }, 180000);
        }
      } catch (e) { /* ignore */ }
      function settle(fn, arg) {
        if (done) return;
        done = true;
        try { if (timer) clearTimeout(timer); } catch (e2) { /* ignore */ }
        fn(arg);
      }
      try {
        var client = oauth2.initTokenClient({
          client_id: syncSharedId('gdrive'),
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: function (resp) {
            if (resp && resp.access_token) settle(resolve, resp);
            else settle(reject, new Error('sync failed: Google sign-in gave no token.'));
          }
        });
        client.requestAccessToken({ prompt: 'consent' });
      } catch (e) {
        settle(reject, new Error('sync failed: could not start Google sign-in.'));
      }
    });
  }).then(function (resp) {
    var exp = Number(resp.expires_in);
    if (!isFinite(exp) || exp <= 0) exp = 3600;
    return { access: resp.access_token, refresh: '', expiry: Date.now() + exp * 1000 };
  });
}

// WebDAV / MEGA have no OAuth: Connect simply proves the login works.
// Both "backup found" and "no backup yet" mean the login is good.
// Connect only proves the login; the first real sync happens right here so
// users never stare at an empty drive wondering why nothing uploaded.
function syncConnectThenSync() {
  var st = null;
  try {
    st = loadState();
  } catch (e) {
    st = null;
  }
  if (!st || ((!st.accounts || !st.accounts.length) && (!st.trades || !st.trades.length))) {
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    clearBanner();
    syncSetStatus('Connected — this wallet is empty. Restore from drive or add data, then sync.');
    return;
  }
  try {
    syncPushFlow();
  } catch (e) {
    showBanner('Sync failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((e && e.message) || e)]
    });
  }
}

function syncTestConnection() {
  if (syncBusy) return;
  if (!syncPassphraseOrBanner()) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  syncPersistFormSecrets(cfg);
  syncSetBusy(true, 'Checking connection…');
  return syncRemoteDownload(cfg).then(function () {
    syncSetBusy(false);
    syncSaveConfig(cfg);
    syncConnectThenSync();
  }, function (err) {
    syncSetBusy(false);
    var m = String((err && err.message) || err);
    if (m.indexOf('no backup found') !== -1) {
      syncSaveConfig(cfg);
      syncConnectThenSync();
      return;
    }
    syncRefreshSyncPanel();
    showBanner('Connection failed — your data was left untouched.', 'error', {
      title: 'Connect',
      lines: [m]
    });
  });
}

// The encrypted-file buttons need a passphrase to do anything, so they
// stay visibly disabled until one is typed (the flows keep their own
// guards as backstop).
function syncToggleEncButtons() {
  if (typeof document === 'undefined') return;
  var passEl = document.getElementById('sy-pass');
  var has = !!(passEl && passEl.value);
  var up = document.getElementById('sy-enc-upload');
  if (up) up.disabled = !has;
  var down = document.getElementById('sy-enc-download');
  if (down) down.disabled = !has;
}

function buildSyncSettings() {
  if (typeof document === 'undefined') return;
  var prov = document.getElementById('sy-provider');
  if (!prov || prov.getAttribute('data-wired')) return;
  prov.setAttribute('data-wired', '1');
  if (!syncCryptoAvailable()) {
    var st0 = document.getElementById('sy-status');
    if (st0) st0.textContent = 'Encrypted sync needs WebCrypto — this browser cannot do it. Use Download backup instead.';
  }
  prov.addEventListener('change', function () {
    var cfg = syncReadForm().cfg;
    syncSaveConfig(cfg);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  });
  var autoBox = document.getElementById('sy-auto');
  if (autoBox && !autoBox.getAttribute('data-wired')) {
    autoBox.setAttribute('data-wired', '1');
    autoBox.addEventListener('change', function () {
      var cfg = syncReadForm().cfg;
      syncSaveConfig(cfg);
      syncRefreshSyncPanel();
      if (autoBox.checked) {
        syncSetStatus('Auto-sync on — changes upload a few seconds after you make them.');
      }
      try { syncScheduleAuto(); } catch (e) { /* ignore */ }
    });
  }
  var passEl = document.getElementById('sy-pass');
  if (passEl) {
    passEl.addEventListener('input', function () {
      var v = passEl.value || '';
      var fp = document.getElementById('sy-fp');
      if (!v) {
        if (fp) fp.textContent = 'Key fingerprint —';
      } else {
        syncFingerprint(v).then(function (f) {
          var cur = document.getElementById('sy-pass');
          if (cur && cur.value === v) {
            var fel = document.getElementById('sy-fp');
            if (fel) fel.textContent = 'Key fingerprint ' + (f || '—');
          }
        });
      }
      try { syncToggleEncButtons(); } catch (e) { /* ignore */ }
    });
  }
  function wireBtn(id, fn) {
    var b = document.getElementById(id);
    if (b && !b.getAttribute('data-wired')) {
      b.setAttribute('data-wired', '1');
      b.addEventListener('click', fn);
    }
  }
  wireBtn('sy-connect', syncStartOAuth);
  wireBtn('sy-disconnect', syncDisconnect);
  wireBtn('sy-push', syncPushFlow);
  wireBtn('sy-pull', syncPullFlow);
  wireBtn('sy-cleanup', syncCleanupFlow);
  wireBtn('sy-enc-download', syncDownloadEncrypted);
  var up = document.getElementById('sy-enc-upload');
  if (up && !up.getAttribute('data-wired')) {
    up.setAttribute('data-wired', '1');
    up.addEventListener('change', function (e) {
      var input = e.target;
      var f = input && input.files && input.files[0];
      if (!f) return;
      syncRestoreEncryptedFile(f);
      try { input.value = ''; } catch (e2) { /* ignore */ }
    });
  }
  priceDataWireSettings();
  syncRefreshSyncPanel();
}
