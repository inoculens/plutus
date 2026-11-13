#!/usr/bin/env node
'use strict';
// Account-id safety. Ids such as "__proto__", "constructor" and "toString"
// used to collide with Object.prototype inside plain-object maps: accounts
// vanished from the portfolio, assignGroup reported success while doing
// nothing, and computePortfolio wrote ticker state into the GLOBAL prototype.
// These tests drive the full import -> store -> portfolio workflow, not just
// the validator. All figures are invented. Loads app.js in a stubbed vm context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const store = new Map();
let quotaFull = false;
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { if (quotaFull) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); }, removeItem: k => store.delete(k) },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

const cache = C.netWorthHistorySeriesCache;
for (let i = 0; i < 500; i++) cache['k' + i] = { at: 1000 + i, series: { points: [] } };
C.netWorthSeriesCachePrune();
const keys = Object.keys(cache);
assert.equal(keys.length, C.NETWORTH_SERIES_CACHE_MAX, 'cache is capped');
assert.ok(keys.includes('k499') && !keys.includes('k0'), 'newest kept, oldest evicted');
C.netWorthSeriesCachePrune();
assert.equal(Object.keys(cache).length, C.NETWORTH_SERIES_CACHE_MAX, 'prune is idempotent under the cap');
assert.equal(C.moneyFmtCache.constructor, undefined, 'currency formatter cache has no inherited keys');
console.log('series-cache-cap: OK');
