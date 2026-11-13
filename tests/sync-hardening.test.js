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
  Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, atob, btoa, ReadableStream,
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

  // ---- Bounded, streamed download reads (every provider goes through one reader).
  const enc = new TextEncoder();
  const setCap = n => vm.runInContext('SYNC_MAX_ENVELOPE_CHARS = ' + n, C);
  const REAL_CAP = C.SYNC_MAX_ENVELOPE_CHARS;
  // A stream the test can observe: how many chunks were pulled, whether it was cancelled/locked.
  const mkStream = (chunks, o) => {
    o = o || {};
    const st = { pulled: 0, cancelled: false, getReaderCalled: false };
    let i = 0;
    const rs = new ReadableStream({
      pull(ctl) {
        if (o.errorAt !== undefined && i === o.errorAt) { ctl.error(new Error('socket reset')); return; }
        if (i >= chunks.length) { ctl.close(); return; }
        st.pulled++; ctl.enqueue(chunks[i++]);
      },
      cancel() { st.cancelled = true; }
    });
    const origGet = rs.getReader.bind(rs);
    rs.getReader = () => { st.getReaderCalled = true; return origGet(); };
    st.stream = rs;
    st.res = (cl) => ({ ok: true, status: 200, headers: { get: n => (/content-length/i.test(n) && cl !== undefined) ? String(cl) : null }, body: rs });
    return st;
  };
  const bytes = n => new Uint8Array(n).fill(97);
  const reader = (res) => C.syncReadTextLimited(res);

  setCap(1000);
  // Oversized body, NO Content-Length: rejected while streaming, stream cancelled, lock released, rest never pulled.
  let st = mkStream(Array.from({ length: 50 }, () => bytes(100)));
  await assert.rejects(() => reader(st.res()), /too large/);
  assert.equal(st.cancelled, true, 'stream cancelled on overflow');
  assert.ok(st.pulled <= 11, 'stopped reading right after the limit (pulled ' + st.pulled + ' of 50)');
  assert.equal(st.stream.locked, false, 'reader lock released');
  // Understated Content-Length: the real byte count decides.
  st = mkStream(Array.from({ length: 50 }, () => bytes(100)));
  await assert.rejects(() => reader(st.res(10)), /too large/);
  assert.equal(st.cancelled, true);
  // Overstated Content-Length: rejected before the body is touched.
  st = mkStream([bytes(5)]);
  await assert.rejects(() => reader(st.res(1001)), /too large/);
  assert.equal(st.getReaderCalled, false, 'body never opened');
  // Exactly at the limit is accepted; one byte over is rejected (single and multi chunk).
  assert.equal((await reader(mkStream([bytes(1000)]).res())).length, 1000);
  assert.equal((await reader(mkStream(Array.from({ length: 10 }, () => bytes(100))).res(1000))).length, 1000);
  await assert.rejects(() => reader(mkStream([bytes(1001)]).res()), /too large/);
  await assert.rejects(() => reader(mkStream([bytes(1000), bytes(1)]).res()), /too large/);
  // Multibyte UTF-8 split across chunk boundaries decodes correctly (euro sign = E2 82 AC).
  const euro = enc.encode('a\u20ac\u20acb');
  assert.equal(await reader(mkStream([euro.slice(0, 2), euro.slice(2, 4), euro.slice(4)]).res()), 'a\u20ac\u20acb');
  assert.equal(await reader(mkStream([]).res()), '', 'empty body');
  assert.equal(await C.syncReadMetaJson(mkStream([enc.encode('{"a":1}')]).res()).then(v => v.a), 1);
  // Invalid UTF-8 and truncated sequences are rejected, not replaced with U+FFFD.
  await assert.rejects(() => reader(mkStream([new Uint8Array([0x61, 0xff, 0x62])]).res()), /not valid UTF-8/);
  await assert.rejects(() => reader(mkStream([new Uint8Array([0xe2, 0x82])]).res()), /not valid UTF-8/);
  // Stream read error: safe failure, nothing leaked, reader released.
  st = mkStream([bytes(10), bytes(10), bytes(10)], { errorAt: 1 });
  await assert.rejects(() => reader(st.res()), e => /connection dropped/.test(e.message) && !/socket reset/.test(e.message));
  assert.equal(st.stream.locked, false);
  // No response stream available: refuse rather than fall back to an unbounded read.
  let unboundedCalled = false;
  const unbounded = { text: () => { unboundedCalled = true; return Promise.resolve('x'); }, arrayBuffer: () => { unboundedCalled = true; return Promise.resolve(new ArrayBuffer(1)); } };
  await assert.rejects(() => reader(Object.assign({ ok: true, headers: { get: () => null }, body: {} }, unbounded)), /cannot read the server response safely/);
  await assert.rejects(() => reader(Object.assign({ ok: true, headers: { get: () => null } }, unbounded)), /cannot read the server response safely/);
  assert.equal(unboundedCalled, false, 'text()/arrayBuffer() are never used as a fallback');
  assert.equal(await reader({ ok: true, status: 204, headers: { get: () => null }, body: null }), '', 'null body = no content');

  // Every provider's download path is bounded: oversized streams are rejected and cancelled through each.
  const cfg = { provider: 'webdav', url: 'https://dav.example.test/remote.php/', username: 'u', password: 'p', filename: 'f.json' };
  const oversized = () => mkStream(Array.from({ length: 30 }, () => bytes(100)));
  let s1 = oversized(); fetchImpl = () => Promise.resolve(s1.res());
  await assert.rejects(() => C.syncWebdavDownload(cfg), /too large/); assert.equal(s1.cancelled, true, 'webdav');
  s1 = oversized(); fetchImpl = () => Promise.resolve(s1.res());
  await assert.rejects(() => C.syncDropboxDownload('tok', { filename: 'f.json', folder: '' }), /too large/); assert.equal(s1.cancelled, true, 'dropbox');
  s1 = oversized();
  fetchImpl = (u) => /alt=media/.test(u) ? Promise.resolve(s1.res()) : Promise.resolve(mkStream([enc.encode('{"files":[{"id":"f1","name":"f.json"}]}')]).res());
  await assert.rejects(() => C.syncDriveDownload('tok', { filename: 'f.json', folder: '' }), /too large/); assert.equal(s1.cancelled, true, 'drive');
  s1 = oversized(); fetchImpl = () => Promise.resolve(s1.res());
  await assert.rejects(() => C.syncS3Get({ provider: 's3', endpoint: 'https://s3.example.test', bucket: 'b', accessKey: 'AK', secretKey: 'SK', secret: 'SK', region: 'us-east-1', filename: 'f.json' }), /too large/); assert.equal(s1.cancelled, true, 's3');
  // Small metadata replies (listings, token replies, error bodies) have their own, smaller cap.
  const metaCap = C.SYNC_MAX_META_BYTES;
  await assert.rejects(() => C.syncReadMetaText(mkStream([bytes(metaCap + 1)]).res()), /unexpectedly large/);
  await assert.rejects(() => C.syncReadMetaJson(mkStream([enc.encode('<html>nope')]).res()), /unreadable response/);
  // Source audit: after the shared reader, no sync code reads a response body unbounded.
  const syncPart = src.slice(src.indexOf('function syncFetch('));
  assert.equal(/\.(text|json|arrayBuffer|blob|formData)\(\)/.test(syncPart.replace(/\/\/.*$/gm, '')), false, 'no unbounded body read remains in the sync providers');
  assert.ok((src.match(/syncReadTextLimited\(res\)/g) || []).length >= 4, 'webdav, drive, dropbox and s3 downloads use the bounded reader');

  // Timeout/abort while streaming: terminates promptly with the timeout message.
  vm.runInContext('SYNC_TIMEOUT_MS = 60', C);
  fetchImpl = (u, o) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body: new ReadableStream({
    start(ctl) { o.signal.addEventListener('abort', () => ctl.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }
  }) });
  const tStart = Date.now();
  await assert.rejects(() => C.syncWebdavDownload(cfg), /timed out/);
  assert.ok(Date.now() - tStart < 1500, 'a stalled download is cut off by the timeout');
  vm.runInContext('SYNC_TIMEOUT_MS = 30000', C);

  // The real cap still admits legitimate backups: a body of exactly the real limit is accepted.
  setCap(REAL_CAP);
  const realChunks = Array.from({ length: 64 }, () => bytes(1024 * 1024));
  assert.equal((await reader(mkStream(realChunks).res())).length, REAL_CAP, 'a body of exactly the real limit is accepted');
  const overReal = mkStream(Array.from({ length: 65 }, () => bytes(1024 * 1024)));
  await assert.rejects(() => reader(overReal.res()), /too large/);
  assert.ok(overReal.pulled <= 65 && overReal.cancelled, 'real-size oversize cancelled mid-stream');
  fetchImpl = () => Promise.resolve(mkStream([enc.encode('ciphertext')]).res());
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
