#!/usr/bin/env node
'use strict';
// A malformed percent-escape in the URL (for example /#/account/%) must never
// throw out of the router: route() runs during boot, so a throw would leave
// the app blank. Loads app.js in a stubbed vm context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const store = new Map();
const deleted = [];
let reloaded = 0;
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); }
  },
  indexedDB: { deleteDatabase: name => { const r = {}; deleted.push(name); setImmediate(() => r.onsuccess && r.onsuccess()); return r; } },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/', protocol: 'https:', reload: () => { reloaded++; } }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

// --- router
for (const bad of ['%', '%E0%A4%A', '%zz']) {
  C.location.pathname = '/account/' + bad; C.location.hash = '';
  assert.doesNotThrow(() => C.currentRouteId(), 'path ' + bad);
  assert.equal(C.currentRouteId(), null, 'malformed path id means no route: ' + bad);
  C.location.pathname = '/'; C.location.hash = '#/account/' + bad;
  assert.doesNotThrow(() => C.currentRouteId(), 'hash ' + bad);
  assert.equal(C.currentRouteId(), null, 'malformed hash id means no route: ' + bad);
}
C.location.pathname = '/account/acc%20one'; C.location.hash = '';
assert.equal(C.currentRouteId(), 'acc one', 'valid escapes still decode');
C.location.pathname = '/'; C.location.hash = '#/account/abc';
assert.equal(C.currentRouteId(), 'abc', 'valid hash id still works');
console.log('route-malformed-escape: ok');
