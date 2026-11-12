#!/usr/bin/env node
'use strict';
// Sync envelope, resource-limit and OAuth-lifetime hardening, using real
// WebCrypto (Node's webcrypto), not a mock: fresh salt/IV on every encrypt,
// AES-GCM authentication on tampering, wrong-passphrase rejection, size and
// iteration caps enforced before expensive work, bounded downloads, the OAuth
// lifetime rule, and the HTTPS/credential guard. app.js runs in a stubbed vm.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
let fetchImpl = () => Promise.reject(new Error('unset'));
const C = {
  console, setTimeout, clearTimeout, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date, AbortController,
  Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, atob, btoa,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: (u, o) => fetchImpl(u, o), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: webcrypto,
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });
const j = v => JSON.parse(JSON.stringify(v));

async function main() {
  const plain = JSON.stringify({ hello: 'world', n: 1 });
  const e1 = j(JSON.parse(await C.syncEncryptEnvelope(plain, 'correct horse')));
  const e2 = j(JSON.parse(await C.syncEncryptEnvelope(plain, 'correct horse')));

  // Format is unchanged (compatibility) and nonce/salt are never reused.
  assert.equal(e1.v, 1); assert.equal(e1.iter, 600000); assert.equal(e1.app, 'plutus.inoculens.com');
  assert.notEqual(e1.iv, e2.iv, 'IV must differ for every encryption under the same passphrase');
  assert.notEqual(e1.salt, e2.salt, 'salt must differ for every encryption');
  assert.notEqual(e1.ciphertext, e2.ciphertext);
  assert.equal(Buffer.from(e1.iv, 'base64').length, 12);
  assert.equal(Buffer.from(e1.salt, 'base64').length, 16);

  // Round trip, wrong passphrase, tampering: no unauthenticated plaintext.
  assert.equal(await C.syncDecryptEnvelope(JSON.stringify(e1), 'correct horse'), plain);
  await assert.rejects(() => C.syncDecryptEnvelope(JSON.stringify(e1), 'wrong'), /wrong passphrase or corrupted/);
  const ct = Buffer.from(e1.ciphertext, 'base64'); ct[0] ^= 1;
  await assert.rejects(() => C.syncDecryptEnvelope(JSON.stringify(Object.assign({}, e1, { ciphertext: ct.toString('base64') })), 'correct horse'), /wrong passphrase or corrupted/);
  const tag = Buffer.from(e1.ciphertext, 'base64'); tag[tag.length - 1] ^= 1;
  await assert.rejects(() => C.syncDecryptEnvelope(JSON.stringify(Object.assign({}, e1, { ciphertext: tag.toString('base64') })), 'correct horse'), /wrong passphrase or corrupted/);
  const iv = Buffer.from(e1.iv, 'base64'); iv[0] ^= 1;
  await assert.rejects(() => C.syncDecryptEnvelope(JSON.stringify(Object.assign({}, e1, { iv: iv.toString('base64') })), 'correct horse'), /wrong passphrase or corrupted/);
  await assert.rejects(() => C.syncDecryptEnvelope(JSON.stringify(Object.assign({}, e1, { ciphertext: 'AAAA' })), 'correct horse'), /too short/);
  await assert.rejects(() => C.syncDecryptEnvelope('{not json', 'x'), /not valid JSON/);
  await assert.rejects(() => C.syncDecryptEnvelope(JSON.stringify(e1), ''), /enter the sync passphrase/);
  // Passphrases never appear in the envelope.
  assert.equal(JSON.stringify(e1).includes('correct horse'), false);

  // Resource limits are enforced BEFORE parsing / decoding / PBKDF2.
  const big = 'x'.repeat(C.SYNC_MAX_ENVELOPE_CHARS + 1);
  assert.throws(() => C.syncEnvelopeParse(big), /too large/);
  assert.equal(C.syncIsEncryptedBackup(big), false);
  const t0 = Date.now();
  await assert.rejects(() => C.syncDecryptEnvelope(big, 'p'), /too large/);
  assert.ok(Date.now() - t0 < 500, 'oversized file rejected without key derivation');
  assert.throws(() => C.syncEnvelopeParse(JSON.stringify(Object.assign({}, e1, { iter: C.SYNC_MAX_PBKDF2_ITER + 1 }))), /bad envelope parameters/);
  assert.doesNotThrow(() => C.syncEnvelopeParse(JSON.stringify(Object.assign({}, e1, { iter: C.SYNC_MAX_PBKDF2_ITER }))));
  assert.doesNotThrow(() => C.syncEnvelopeParse(JSON.stringify(e1)), 'existing 600000-iteration backups stay readable');
  assert.throws(() => C.syncEnvelopeParse(JSON.stringify(Object.assign({}, e1, { iter: 10 }))), /bad envelope parameters/);
  // A realistic large backup (3 MB of JSON) is nowhere near the cap.
  const mid = JSON.stringify({ blob: 'a'.repeat(3 * 1024 * 1024) });
  assert.equal(await C.syncDecryptEnvelope(await C.syncEncryptEnvelope(mid, 'pw'), 'pw'), mid);

  // Bounded download reads.
  let textCalled = false;
  await assert.rejects(() => C.syncReadTextLimited({ headers: { get: () => String(C.SYNC_MAX_ENVELOPE_CHARS + 1) }, text: () => { textCalled = true; return Promise.resolve(''); } }), /too large/);
  assert.equal(textCalled, false, 'body not read when Content-Length already exceeds the cap');
  assert.equal(await C.syncReadTextLimited({ headers: { get: () => null }, text: () => Promise.resolve('ok') }), 'ok');
  await assert.rejects(() => C.syncReadTextLimited({ headers: { get: () => null }, text: () => Promise.resolve(big) }), /too large/);
  const cfg = { provider: 'webdav', url: 'https://dav.example.test/remote.php/', username: 'u', password: 'p', filename: 'f.json' };
  fetchImpl = () => Promise.resolve({ ok: true, status: 200, body: {}, headers: { get: () => String(C.SYNC_MAX_ENVELOPE_CHARS + 5) }, text: () => Promise.resolve('x') });
  await assert.rejects(() => C.syncWebdavDownload(cfg), /too large/);
  fetchImpl = () => Promise.resolve({ ok: true, status: 200, body: {}, headers: { get: () => null }, text: () => Promise.resolve('ciphertext') });
  assert.equal(await C.syncWebdavDownload(cfg), 'ciphertext');
  fetchImpl = () => Promise.reject(new TypeError('network down'));
  await assert.rejects(() => C.syncWebdavDownload(cfg), /cannot reach/);

  // OAuth authorization lifetime: fresh ok, stale / missing / future-skewed refused.
  const now = 1000000000000;
  assert.equal(C.syncOAuthExpired(now, now + 5 * 60 * 1000), false);
  assert.equal(C.syncOAuthExpired(now, now + 10 * 60 * 1000), false);
  assert.equal(C.syncOAuthExpired(now, now + 10 * 60 * 1000 + 1), true);
  assert.equal(C.syncOAuthExpired(undefined, now), true);
  assert.equal(C.syncOAuthExpired('x', now), true);
  const a = C.syncRandomBytes(12), b = C.syncRandomBytes(12);
  assert.notDeepEqual(j(Array.from(a)), j(Array.from(b)), 'state bytes come from the CSPRNG');

  // HTTPS enforcement and credential handling.
  const ok = u => assert.doesNotThrow(() => C.syncRequireHttpsUrl(u, 'x'), u);
  const no = (u, re) => assert.throws(() => C.syncRequireHttpsUrl(u, 'x'), re, u);
  ok('https://cloud.example.com/dav'); ok('http://localhost:8080/dav'); ok('http://127.0.0.1/dav'); ok('http://[::1]:3000/');
  no('http://cloud.example.com/dav', /https/); no('http://127.evil.com/', /https/); no('http://localhost.evil.com/', /https/);
  no('https://user:pw@cloud.example.com/', /username or password/); no('http://127.0.0.1@evil.com/', /username or password/);
  no('ftp://x.example.com', /https/); no('not a url', /https/); no('', /https/); no('//cloud.example.com', /https/);
  no('javascript:alert(1)', /https/);

  console.log('sync-hardening: OK');
}
main().catch(e => { console.error(e); process.exit(1); });
