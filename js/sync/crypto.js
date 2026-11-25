'use strict';
// Sync: WebCrypto layer (async; guarded).

function syncCryptoObj() {
  try {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) return window.crypto;
    if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) return self.crypto;
    if (typeof crypto !== 'undefined' && crypto.subtle) return crypto;
  } catch (e) { /* ignore */ }
  return null;
}

function syncCryptoAvailable() {
  var c = syncCryptoObj();
  return !!(c && c.subtle && typeof c.subtle.importKey === 'function' && typeof c.getRandomValues === 'function');
}

function syncRandomBytes(n) {
  var c = syncCryptoObj();
  var out = new Uint8Array(n);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  // Never fall back to Math.random for salts, IVs or OAuth verifiers:
  // predictable randomness would break the encryption. Callers already
  // gate on syncCryptoAvailable(); this is a fail-closed backstop.
  throw new Error('sync failed: no secure randomness available in this browser.');
}

function syncSha256(bytes) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: WebCrypto unavailable.'));
  return c.subtle.digest('SHA-256', bytes).then(function (d) { return new Uint8Array(d); });
}

function syncHmac(keyBytes, dataBytes) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: WebCrypto unavailable.'));
  return c.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (k) {
    return c.subtle.sign('HMAC', k, dataBytes);
  }).then(function (sig) {
    return new Uint8Array(sig);
  });
}

function syncDeriveAesKey(passphrase, salt, iter) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  var pwBytes = syncUtf8Encode(passphrase);
  return c.subtle.importKey('raw', pwBytes, { name: 'PBKDF2' }, false, ['deriveBits']).then(function (base) {
    return c.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, base, 256);
  }).then(function (bits) {
    return c.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  });
}

function syncEncryptEnvelope(plaintext, passphrase) {
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable). Use Download backup instead.'));
  }
  if (!passphrase) return Promise.reject(new Error('sync failed: enter a sync passphrase.'));
  var salt = syncRandomBytes(16);
  var iv = syncRandomBytes(12);
  var data = syncUtf8Encode(plaintext);
  return syncDeriveAesKey(passphrase, salt, SYNC_PBKDF2_ITER).then(function (key) {
    var c = syncCryptoObj();
    return c.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);
  }).then(function (ct) {
    return syncEnvelopeWrap(syncB64encode(new Uint8Array(ct)), syncB64encode(salt), syncB64encode(iv), SYNC_PBKDF2_ITER);
  });
}

function syncDecryptEnvelope(envelopeText, passphrase) {
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  }
  if (!passphrase) return Promise.reject(new Error('sync failed: enter the sync passphrase.'));
  var env;
  try {
    env = syncEnvelopeParse(envelopeText);
  } catch (e) {
    return Promise.reject(e);
  }
  return syncDeriveAesKey(passphrase, env.salt, env.iter).then(function (key) {
    var c = syncCryptoObj();
    return c.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.ciphertext);
  }).then(function (pt) {
    return syncUtf8Decode(new Uint8Array(pt));
  }, function () {
    throw new Error('sync failed: wrong passphrase or corrupted file.');
  });
}

// Short display fingerprint so two devices can check they typed the same
// passphrase. Display-only; it never leaves the browser.
function syncFingerprint(passphrase) {
  if (!passphrase) return Promise.resolve('');
  return syncSha256(syncUtf8Encode('plutus-sync:' + passphrase)).then(function (h) {
    var hex = syncHex(h).slice(0, 12);
    return hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12);
  }, function () {
    return '';
  });
}
