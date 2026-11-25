'use strict';
// E2E encrypted sync to a drive of the user's choice. There is no INOCULENS PLUTUS
// server: the plaintext is always the exact exportState() JSON, it is
// encrypted in this browser with WebCrypto (PBKDF2-SHA256 -> AES-GCM-256),
// and only the ciphertext envelope below ever leaves the device:
//
//   {"app":"plutus.inoculens.com","v":1,"iter":N,"salt":b64,"iv":b64,
//    "ciphertext":b64}
//
// The passphrase lives only in the form (and, only if the user ticks
// Remember, in this browser's local storage — never on any server). To sync
// from another computer the user only needs the drive login plus the
// passphrase. A wrong passphrase fails closed (AES-GCM auth) and local data
// is never touched until a downloaded backup fully validates via importState().
// Providers: WebDAV/Nextcloud (Basic), Google Drive / Dropbox
// (OAuth one-click or PKCE with the user's own app), MEGA S4 (S3-compatible
// SigV4 with the user's own access keys).

var SYNC_APP = 'plutus.inoculens.com';
// Files written by the first release carry the old id; still accepted on
// read so early backups keep working. New files always use SYNC_APP.
var SYNC_APP_LEGACY = 'inoculens-plutus-sync';
var SYNC_VERSION = 1;
var SYNC_STORAGE_KEY = 'inoculens.sync.v1';
var PRICE_DATA_STORAGE_KEY = 'inoculens.price-data-sync.v1';
var PRICE_DATA_APP = 'plutus.price-data.inoculens.com';
var PRICE_DATA_FILENAME = 'price-data.plutus.inoculens.com.enc.json';
var PRICE_DATA_SERIES_MAX = 100;
var PRICE_DATA_SERIES_POINTS_MAX = 250000;
var PRICE_DATA_SERIES_SINGLE_MAX = 20000;
var SYNC_OAUTH_KEY = 'inoculens.oauth.v1';
var SYNC_DEFAULT_BASENAME = 'plutus.inoculens.com';
var SYNC_DEFAULT_FILENAME = 'plutus.inoculens.com.enc.json';
// Trust stamp for "this device synced this destination before". Bumped
// whenever the gate rules change so markers written by older app versions
// never count — the next push re-verifies instead of blindly overwriting.
var SYNC_LOC_V = 2;
var SYNC_PBKDF2_ITER = 600000;
var SYNC_PROVIDERS = [
  { id: 'webdav', label: 'WebDAV / Nextcloud', kind: 'basic' },
  { id: 'gdrive', label: 'Google Drive', kind: 'oauth' },
  { id: 'dropbox', label: 'Dropbox', kind: 'oauth' },
  { id: 'megas3', label: 'MEGA (S4 object storage)', kind: 's3' }
];
var SYNC_HINTS = {
  webdav: 'Nextcloud or any WebDAV host. Create a folder (e.g. INOCULENS-PLUTUS), paste its URL and sign in with an app password.',
  gdrive: 'One-click Google sign-in, or use your own OAuth app (Web application, Drive API enabled). The app only sees files it created. Sessions last about an hour; reconnect when asked.',
  dropbox: 'One-click Dropbox sign-in, or your own Dropbox app (Scoped access, App folder) with its app key. Files stay in the private app folder.',
  megas3: 'MEGA S4 object storage (needs a MEGA account with S4). Create a bucket and access keys under Object Storage, then fill in the fields.'
};

// Built-in OAuth app IDs for one-click sign-in (public by design, exactly
// like rclone/Joplin ship theirs — the ID only names the app to the
// provider; tokens and ciphertext still flow directly browser<->provider
// with no INOCULENS PLUTUS server anywhere). Empty until the app owner registers
// them; while empty, users fall back to their own OAuth app below.
var SYNC_SHARED_APPS = { gdrive: '593485863383-tcl6m894iqoqa2cqan3ui80ihau93fq9.apps.googleusercontent.com', dropbox: 'rractvt806na5rn' };

function syncSharedId(providerId) {
  var v = SYNC_SHARED_APPS[providerId];
  return (typeof v === 'string' && v.trim() !== '') ? v.trim() : '';
}

// Effective client ID: the built-in one-click app wins when configured,
// otherwise the user's own app from the advanced box.
function syncEffectiveClientId(cfg) {
  var shared = syncSharedId(cfg.provider);
  if (shared) return shared;
  return (typeof cfg.clientId === 'string') ? cfg.clientId : '';
}

var syncBusy = false;
// True while the background watcher is downloading + comparing the drive
// copy. Kept separate from syncBusy so a poll can't block a manual push but
// still paints the spinning cloud and re-arms auto-push.
var syncChecking = false;
var syncWatchBusy = false;
// 'push' when a manual push arrived while a background read held the
// connection: it runs the moment that read settles.
var syncAfterCheck = '';
var syncMemSecrets = { password: '', secretKey: '' };
// True once a drive check proves the two sides disagree (drive newer or a
// real conflict) and nothing has resolved it since. Drives the header icon
// and the panel hint so "up to date" is never claimed on local hashes alone.
var syncPendingRemote = false;

// --- Envelope + pure helpers ---

// Resource limits for downloaded sync files. A legitimate envelope holds the
// JSON backup (a few MB) or one attachment (<= ATTACH_MAX_BYTES, base64 twice
// over), so 64 MiB leaves wide headroom while refusing a hostile or runaway
// remote file BEFORE it is parsed, base64-decoded or run through PBKDF2.
var SYNC_MAX_ENVELOPE_CHARS = 64 * 1024 * 1024;
var SYNC_MAX_PBKDF2_ITER = 2000000;
// An OAuth authorization is single use and only honoured for a few minutes
// after the popup opened; a late or replayed callback is ignored.
var SYNC_OAUTH_TTL_MS = 10 * 60 * 1000;
function syncOAuthExpired(startedAt, now) {
  return !(typeof startedAt === 'number') || !((now === undefined ? Date.now() : now) - startedAt <= SYNC_OAUTH_TTL_MS);
}

// Read a response body as text, refusing oversized payloads up front: via
// Content-Length when the server sends it, and again on the text length.
// Remote bodies are read as a byte stream with the limit enforced on the bytes
// that actually arrive. Content-Length is untrusted (missing or understated) and
// is only used to reject early. Nothing is decoded until the limit is satisfied,
// the reader is cancelled and released on every exit, and a client without
// streaming support is refused rather than falling back to an unbounded read.
var SYNC_MAX_META_BYTES = 4 * 1024 * 1024; // listings, token replies, API error bodies

function syncReadBodyLimited(res, maxBytes, tooBigMessage) {
  var len = NaN;
  try { len = Number(res && res.headers && res.headers.get && res.headers.get('content-length')); } catch (e) { len = NaN; }
  if (isFinite(len) && len > maxBytes) return Promise.reject(new Error(tooBigMessage));
  var body = res && res.body;
  if (body === null) return Promise.resolve(''); // no content (204, HEAD)
  if (!body || typeof body.getReader !== 'function' || typeof TextDecoder === 'undefined') {
    return Promise.reject(new Error('sync failed: this browser cannot read the server response safely.'));
  }
  var reader = body.getReader();
  var chunks = [];
  var total = 0;
  var release = function () {
    try { reader.releaseLock(); } catch (e) { /* already released */ }
    try { if (res.syncStop) res.syncStop(); } catch (e) { /* ignore */ }
  };
  return new Promise(function (resolve, reject) {
    var fail = function (err) {
      try { var c = reader.cancel(); if (c && c.catch) c.catch(function () {}); } catch (e) { /* ignore */ }
      release();
      reject(err);
    };
    var step = function () {
      var p;
      try { p = reader.read(); } catch (e) { fail(new Error('sync failed: the connection dropped while downloading.')); return; }
      p.then(function (r) {
        if (r.done) {
          var buf = new Uint8Array(total), at = 0;
          for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], at); at += chunks[i].length; }
          var text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {
            release();
            reject(new Error('sync failed: the server response is not valid UTF-8 text.'));
            return;
          }
          release();
          resolve(text);
          return;
        }
        var v = r.value;
        if (!v || typeof v.length !== 'number') { fail(new Error('sync failed: unreadable server response.')); return; }
        total += v.length;
        if (total > maxBytes) { fail(new Error(tooBigMessage)); return; }
        chunks.push(v);
        step();
      }, function (err) {
        if (err && err.name === 'AbortError' && res.syncTimedOut) fail(res.syncTimedOut());
        else fail(new Error('sync failed: the connection dropped while downloading.'));
      });
    };
    step();
  });
}

function syncReadTextLimited(res) {
  return syncReadBodyLimited(res, SYNC_MAX_ENVELOPE_CHARS, 'sync failed: the remote file is too large to be a valid backup.');
}

function syncReadMetaText(res) {
  return syncReadBodyLimited(res, SYNC_MAX_META_BYTES, 'sync failed: the server response is unexpectedly large.');
}

function syncReadMetaJson(res) {
  return syncReadMetaText(res).then(function (t) {
    try { return JSON.parse(t); } catch (e) { throw new Error('sync failed: the server returned an unreadable response.'); }
  });
}

function syncEnvelopeWrap(ctB64, saltB64, ivB64, iter) {
  return JSON.stringify({ app: SYNC_APP, v: SYNC_VERSION, iter: iter, salt: saltB64, iv: ivB64, ciphertext: ctB64 });
}

function syncEnvelopeParse(text) {
  var data;
  if (String(text).length > SYNC_MAX_ENVELOPE_CHARS) throw new Error('sync failed: file is too large to be a valid sync file.');
  try {
    data = JSON.parse(String(text));
  } catch (e) {
    throw new Error('sync failed: file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('sync failed: bad envelope.');
  if (data.app !== SYNC_APP && data.app !== SYNC_APP_LEGACY) throw new Error('sync failed: not an INOCULENS PLUTUS sync file.');
  if (data.v !== SYNC_VERSION) throw new Error('sync failed: unsupported sync version.');
  var iter = Number(data.iter);
  if (!isFinite(iter) || Math.floor(iter) !== iter || iter < 1000 || iter > SYNC_MAX_PBKDF2_ITER) {
    throw new Error('sync failed: bad envelope parameters.');
  }
  if (typeof data.salt !== 'string' || typeof data.iv !== 'string' || typeof data.ciphertext !== 'string') {
    throw new Error('sync failed: bad envelope parameters.');
  }
  var salt, iv, ct;
  try {
    salt = syncB64decode(data.salt);
    iv = syncB64decode(data.iv);
    ct = syncB64decode(data.ciphertext);
  } catch (e) {
    throw new Error('sync failed: bad envelope encoding.');
  }
  if (salt.length !== 16) throw new Error('sync failed: bad envelope salt.');
  if (iv.length !== 12) throw new Error('sync failed: bad envelope nonce.');
  if (ct.length < 16) throw new Error('sync failed: ciphertext too short.');
  return { iter: iter, salt: salt, iv: iv, ciphertext: ct };
}

// True when the text is one of our encrypted envelopes (a sync file or an
// encrypted download) rather than a plain backup. Pure and safe to probe
// with before importState(), whose 'unknown app' error would only confuse.
function syncIsEncryptedBackup(text) {
  try {
    syncEnvelopeParse(String(text));
    return true;
  } catch (e) {
    return false;
  }
}

// Three-way sync decision from content hashes — never wall clocks. A fresh
// exportState() stamps exportedAt with "now", so comparing exportedAt values
// always reads local-newer and a stale device silently overwrites the drive
// (and every restore warns "drive copy is older", even for newer copies).
// baseHash is the last agreed sync point (cfg.lastSyncedHash):
//   in-sync     — both sides hold the same content
//   remote-only — this device is untouched; the drive moved (safe to pull)
//   local-only  — the drive is untouched; this device moved (safe to push)
//   conflict    — both moved, or no agreed point to judge by (ask the user)
//   unknown     — a hash is missing (fail closed: never guess)
function syncDirection(curHash, remoteHash, baseHash) {
  var c = String(curHash || '');
  var r = String(remoteHash || '');
  var b = String(baseHash || '');
  if (!c || !r) return 'unknown';
  if (c === r) return 'in-sync';
  if (b && c === b) return 'remote-only';
  if (b && r === b) return 'local-only';
  return 'conflict';
}

function syncIsProvider(id) {
  var i;
  for (i = 0; i < SYNC_PROVIDERS.length; i++) {
    if (SYNC_PROVIDERS[i].id === id) return true;
  }
  return false;
}

function syncProviderById(id) {
  var i;
  for (i = 0; i < SYNC_PROVIDERS.length; i++) {
    if (SYNC_PROVIDERS[i].id === id) return SYNC_PROVIDERS[i];
  }
  return null;
}

function syncProviderLabel(id) {
  var p = syncProviderById(id);
  return p ? p.label : String(id);
}

function syncJoinUrl(base, name) {
  var b = String(base || '').replace(/\s+$/g, '').replace(/\/+$/, '');
  return b + '/' + encodeURIComponent(String(name));
}

function syncSanitizeFilename(name) {
  // User-editable basename, fixed extension: strip any pasted extension,
  // unsafe characters and dot-segments, then lock '.enc.json' back on.
  // Idempotent: already-correct names pass through unchanged. Non-Latin1
  // characters become '_' so the name stays valid in HTTP headers too
  // (Dropbox carries the path in Dropbox-API-Arg, which must be Latin1).
  var s = String(name == null ? '' : name).trim();
  s = s.replace(/^[/\\.\s]+/, '');
  s = s.replace(/(\.enc\.json|\.json|\.enc)$/i, '');
  s = s.replace(/[/\\'"]/g, '');
  s = s.replace(/[^\x20-\xFF]/g, '_');
  s = s.replace(/[. ]+$/, '').slice(0, 100);
  if (!s) s = SYNC_DEFAULT_BASENAME;
  return s + '.enc.json';
}

function syncDisplayBasename(name) {
  return String(name == null ? '' : name).replace(/\.enc\.json$/i, '');
}

// Folder path inside the drive (Drive folder tree, Dropbox subfolder, S3
// key prefix). '' = drive root. Normalizes slashes, drops '.' and '..'
// segments so paths can never escape upward.
function syncNormalizeFolder(raw) {
  var f = String(raw == null ? '' : raw).replace(/\\/g, '/').trim();
  f = f.replace(/^\/+|\/+$/g, '');
  var parts = f.split('/');
  var out = [];
  var i;
  for (i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^\.+$/, '');
    if (p === '' || p === '.' || p === '..') continue;
    out.push(p.slice(0, 128));
  }
  return out.join('/').slice(0, 256);
}

// Full identity of a save destination: the duplicate gate refuses to
// overwrite a file at a destination this device has never synced.
function syncLocationKey(cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  if (cfg.provider === 'webdav') return 'webdav|' + syncJoinUrl(cfg.url, cfg.filename);
  if (cfg.provider === 'megas3') return 'megas3|' + syncS3Url(cfg);
  return cfg.provider + '|' + folder + '/' + cfg.filename;
}

// Whose credentials the destination belongs to: switching app identity
// (another OAuth app, another username/key) must re-verify, because e.g.
// Drive's app-scoped files are invisible across different client IDs.
function syncTrustIdentity(cfg) {
  if (cfg.provider === 'gdrive' || cfg.provider === 'dropbox') {
    return 'oauth:' + syncEffectiveClientId(cfg);
  }
  if (cfg.provider === 'webdav') return 'basic:' + String(cfg.username || '');
  if (cfg.provider === 'megas3') return 's3:' + String(cfg.accessKey || '');
  return '';
}

function syncIsTrustedLocation(cfg, locKey) {
  if (!cfg.lastLocation || cfg.lastLocation !== locKey) return false;
  if (cfg.locV !== SYNC_LOC_V) return false;
  var ident = syncTrustIdentity(cfg);
  if (!ident) return false;
  return (cfg.lastIdentity || '') === ident;
}

function syncDefaultConfig() {
  return {
    provider: 'webdav',
    filename: SYNC_DEFAULT_FILENAME,
    url: '',
    username: '',
    password: '',
    rememberPassword: false,
    passphrase: '',
    rememberPassphrase: false,
    clientId: '',
    clientSecret: '',
    tokens: null,
    endpoint: 'https://s3.eu-amsterdam.megas4.com',
    region: 'eu-amsterdam',
    bucket: '',
    accessKey: '',
    secretKey: '',
    rememberSecret: false,
    objectKey: SYNC_DEFAULT_FILENAME,
    folder: '',
    lastLocation: null,
    locV: null,
    lastIdentity: null,
    autoSync: false,
    lastSyncedHash: null,
    lastSyncAt: null,
    lastRemoteAt: null
  };
}

function syncSanitizeConfig(raw) {
  var d = syncDefaultConfig();
  var c = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  var repairedRecordsFilename = false;
  if (syncIsProvider(c.provider)) d.provider = c.provider;
  if (typeof c.filename === 'string' && c.filename.trim() !== '') {
    d.filename = syncSanitizeFilename(c.filename);
    // Older Price Data token refreshes saved the chart filename over the
    // Records destination. Repair only that known collision; keep custom
    // Records filenames unchanged.
    if (d.filename === PRICE_DATA_FILENAME) {
      d.filename = SYNC_DEFAULT_FILENAME;
      repairedRecordsFilename = true;
    }
  }
  if (typeof c.url === 'string') d.url = c.url.trim().slice(0, 512);
  if (typeof c.username === 'string') d.username = c.username.slice(0, 256);
  if (typeof c.password === 'string') d.password = c.password.slice(0, 512);
  d.rememberPassword = (c.rememberPassword === true);
  if (!d.rememberPassword) d.password = '';
  // Sync passphrase: persisted only with explicit opt-in, exactly like the
  // drive passwords above. Needed for auto-sync across reloads.
  d.rememberPassphrase = (c.rememberPassphrase === true);
  if (d.rememberPassphrase && typeof c.passphrase === 'string') d.passphrase = c.passphrase.slice(0, 512);
  else d.passphrase = '';
  if (typeof c.clientId === 'string') d.clientId = c.clientId.trim().slice(0, 256);
  if (typeof c.clientSecret === 'string') d.clientSecret = c.clientSecret.slice(0, 512);
  if (c.tokens && typeof c.tokens === 'object' && typeof c.tokens.access === 'string' && c.tokens.access !== '') {
    d.tokens = {
      access: String(c.tokens.access).slice(0, 4096),
      refresh: (typeof c.tokens.refresh === 'string') ? String(c.tokens.refresh).slice(0, 4096) : '',
      expiry: (isFinite(Number(c.tokens.expiry))) ? Number(c.tokens.expiry) : 0
    };
  } else {
    d.tokens = null;
  }
  if (typeof c.endpoint === 'string' && c.endpoint.trim() !== '') d.endpoint = c.endpoint.trim().replace(/\/+$/, '').slice(0, 256);
  if (typeof c.region === 'string' && c.region.trim() !== '') d.region = c.region.trim().slice(0, 64);
  if (typeof c.bucket === 'string') d.bucket = c.bucket.trim().slice(0, 128);
  if (typeof c.accessKey === 'string') d.accessKey = c.accessKey.trim().slice(0, 256);
  // MEGA secret key is only persisted when the user explicitly opts in
  // (sy-remember2); otherwise it lives in memory for this session only.
  d.rememberSecret = (c.rememberSecret === true);
  if (d.rememberSecret && typeof c.secretKey === 'string') d.secretKey = c.secretKey.slice(0, 512);
  else d.secretKey = '';
  if (typeof c.objectKey === 'string' && c.objectKey.trim() !== '') d.objectKey = c.objectKey.trim().replace(/^\/+/, '').slice(0, 256) || SYNC_DEFAULT_FILENAME;
  // Migrate legacy full-path object keys (folder/file) into the split fields.
  var folderFromKey = '';
  if (d.provider === 'megas3' && d.objectKey.indexOf('/') !== -1) {
    var segs = d.objectKey.split('/');
    d.objectKey = segs.pop() || SYNC_DEFAULT_FILENAME;
    folderFromKey = syncNormalizeFolder(segs.join('/'));
  }
  d.objectKey = syncSanitizeFilename(d.objectKey);
  if (repairedRecordsFilename && d.objectKey === PRICE_DATA_FILENAME) {
    d.objectKey = SYNC_DEFAULT_FILENAME;
  }
  d.folder = syncNormalizeFolder(c.folder) || folderFromKey;
  if (typeof c.lastLocation === 'string' && c.lastLocation !== '') d.lastLocation = c.lastLocation.slice(0, 512);
  d.locV = (c.locV === SYNC_LOC_V) ? SYNC_LOC_V : null;
  if (d.locV === null) d.lastLocation = null;
  if (typeof c.lastIdentity === 'string' && c.lastIdentity !== '') d.lastIdentity = c.lastIdentity.slice(0, 512);
  if (d.locV === null) d.lastIdentity = null;
  d.autoSync = (c.autoSync === true);
  if (typeof c.lastSyncedHash === 'string' && c.lastSyncedHash !== '') d.lastSyncedHash = c.lastSyncedHash.slice(0, 64);
  if (typeof c.lastSyncAt === 'string' && isFinite(Date.parse(c.lastSyncAt))) d.lastSyncAt = c.lastSyncAt;
  if (typeof c.lastRemoteAt === 'string' && isFinite(Date.parse(c.lastRemoteAt))) d.lastRemoteAt = c.lastRemoteAt;
  // Keep the baseline only if it was recorded against this Records path.
  // A hash from the misdirected Price Data path is not a safe merge point.
  if (repairedRecordsFilename && d.lastLocation !== syncLocationKey(d)) {
    d.lastLocation = null;
    d.lastIdentity = null;
    d.locV = null;
    d.lastSyncedHash = null;
    d.lastSyncAt = null;
    d.lastRemoteAt = null;
  }
  return d;
}

function syncLoadConfig() {
  var raw = null;
  try {
    if (typeof localStorage === 'undefined') return syncDefaultConfig();
    var s = localStorage.getItem(SYNC_STORAGE_KEY);
    raw = s ? JSON.parse(s) : null;
  } catch (e) {
    raw = null;
  }
  return syncSanitizeConfig(raw);
}

function syncSaveConfig(cfg) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(syncSanitizeConfig(cfg)));
    return true;
  } catch (e) {
    return false;
  }
}

function priceDataSanitizeFilename(value) {
  // Same rule as the Records file: user-editable basename, fixed '.enc.json'
  // extension (also upgrades older saved extension-less names).
  var raw = String(value == null ? '' : value).trim();
  if (!raw) return PRICE_DATA_FILENAME;
  return syncSanitizeFilename(raw);
}

function priceDataDefaultConfig() {
  var cfg = syncDefaultConfig();
  cfg.sameAsRecords = true;
  cfg.filename = PRICE_DATA_FILENAME;
  cfg.objectKey = PRICE_DATA_FILENAME;
  return cfg;
}

function priceDataSanitizeConfig(raw) {
  var c = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  var out = syncSanitizeConfig(c);
  out.sameAsRecords = (c.sameAsRecords !== false);
  out.filename = priceDataSanitizeFilename(c.filename);
  out.objectKey = out.filename;
  out.lastLocation = null;
  out.lastIdentity = null;
  out.locV = null;
  out.lastSyncedHash = null;
  out.lastSyncAt = null;
  out.lastRemoteAt = null;
  return out;
}

function priceDataLoadConfig() {
  try {
    if (typeof localStorage === 'undefined') return priceDataDefaultConfig();
    var raw = localStorage.getItem(PRICE_DATA_STORAGE_KEY);
    return priceDataSanitizeConfig(raw ? JSON.parse(raw) : null);
  } catch (e) {
    return priceDataDefaultConfig();
  }
}

function priceDataSaveConfig(cfg) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(PRICE_DATA_STORAGE_KEY, JSON.stringify(priceDataSanitizeConfig(cfg)));
    return true;
  } catch (e) {
    return false;
  }
}

// Secrets the user chose NOT to remember live only in memory, never in storage.
function syncPassword(cfg) {
  if (cfg.password) return cfg.password;
  if (cfg.priceDataAuth) return syncMemSecrets.pricePassword || '';
  return syncMemSecrets.password || '';
}

function syncSecret(cfg) {
  if (cfg.secretKey) return cfg.secretKey;
  if (cfg.priceDataAuth) return syncMemSecrets.priceSecretKey || '';
  return syncMemSecrets.secretKey || '';
}
