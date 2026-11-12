#!/usr/bin/env node
'use strict';
// User-configured sync hosts must be https. Only exact loopback hosts may use
// http, and a URL must not smuggle a different host behind a loopback-looking
// prefix or a "user@" part. Loads app.js in a stubbed vm context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

const accepted = [
  'https://example.com/dav', 'https://cloud.example.com:8443/remote.php/dav/files/me/',
  'HTTPS://Example.com/dav', 'http://localhost:8080/dav', 'http://127.0.0.1/dav',
  'http://127.1.2.3:9000/dav', 'http://[::1]/dav', 'https://127.0.0.1/dav'
];
const rejected = [
  'http://example.com/dav', 'http://127.evil.com/dav', 'http://127.0.0.1.evil.com/dav',
  'http://127.0.0.1@evil.com/dav', 'http://localhost@evil.com/dav', 'http://0.0.0.0/dav',
  'http://127.0.0.256/dav', 'https://user:secret@example.com/dav', 'ftp://example.com/dav',
  'example.com/dav', ''
];
for (const u of accepted) assert.doesNotThrow(() => C.syncRequireHttpsUrl(u, 'WebDAV'), 'should accept ' + u);
for (const u of rejected) assert.throws(() => C.syncRequireHttpsUrl(u, 'WebDAV'), /sync failed/, 'should reject ' + JSON.stringify(u));
assert.equal(C.syncRequireHttpsUrl('https://example.com/dav', 'WebDAV'), 'https://example.com/dav', 'the URL is returned unchanged');
console.log('sync-https-guard: ok');
