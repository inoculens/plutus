#!/usr/bin/env node
'use strict';
// "Clear all data" must remove every browser-side store the app owns (sync
// sign-ins, OAuth tokens, caches, net-worth history, receipts and attachments),
// not just the main state. Loads app.js in a stubbed vm context.
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

// --- wipe
for (const k of C.WIPE_LOCAL_KEYS) store.set(k, 'x');
store.set('inoculens.consent.v1', 'accepted');
store.set('inoculens.v2', 'main-state');
const required = ['inoculens.sync.v1', 'inoculens.oauth.v1', 'inoculens.price-data-sync.v1', 'plutus.networth-history.v1'];
for (const k of required) assert.ok(C.WIPE_LOCAL_KEYS.includes(k), 'wipe list must include ' + k);
assert.ok(!C.WIPE_LOCAL_KEYS.includes('inoculens.consent.v1'), 'consent choice is kept');
assert.ok(!C.WIPE_LOCAL_KEYS.includes('inoculens.v2'), 'main state is handled by saveStateGuarded');
(async () => {
  await C.wipeAllBrowserData();
  for (const k of C.WIPE_LOCAL_KEYS) assert.equal(store.has(k), false, 'removed ' + k);
  assert.equal(store.get('inoculens.consent.v1'), 'accepted');
  assert.deepEqual(deleted.sort(), ['inoculens.plutus.attachments', 'plutus.networth-history']);
  console.log('wipe-all-data: ok');
})().catch(e => { console.error(e); process.exit(1); });
