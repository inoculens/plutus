#!/usr/bin/env node
'use strict';
// When a historical FX rate cannot be fetched, the affected figures fall back
// to entry-time values and the user is told once per session ("FX rates
// unavailable"). A cleanup once removed the helper the warning read the
// failures through; the call threw inside a try and the warning silently
// never showed. All figures are invented. Loads the app in a stubbed vm context.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const src = require('./app-source').appSource();
const noop = () => {};

const store = new Map();
const C = {
  console, setTimeout: (f) => { f(); return 0; }, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('offline')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app-scripts.js' });

const banners = [];
C.showBanner = (msg, kind, details) => banners.push({ msg, kind, details });
C.renderAccounts = noop; C.renderHeroAlloc = noop; C.syncTopbar = noop; C.route = noop; C.syncInfoDots = noop;

const state = {
  settings: { mainCurrency: 'EUR', costMethod: 'fifo' },
  accounts: [{ id: 'cash-usd', name: 'Dollars', ticker: 'USD', kind: 'cash' }],
  trades: [{ id: 'i1', type: 'income', accountId: 'cash-usd', symbol: 'USD', qty: 100, total: 100, currency: 'USD', date: '2025-03-04' }],
  priceOverrides: {}
};

(async () => {
  assert.equal(typeof C.fxFailedPairs, 'function', 'the warning can read the failed pairs');
  C.refreshDisplayRates(state);
  for (let i = 0; i < 50 && !banners.length; i++) await new Promise(r => setImmediate(r));
  assert.equal(banners.length, 1, 'one FX warning after a failed fill');
  assert.equal(banners[0].kind, 'error');
  assert.equal(banners[0].details.title, 'FX rates unavailable');
  assert.ok(banners[0].details.lines.some(l => l.indexOf('USD → EUR · 2025-03-04') !== -1), 'names the failed pair: ' + banners[0].details.lines);
  const failed = C.fxFailedPairs();
  assert.ok(failed.length >= 1, 'the failed pair is recorded');
  failed.push('x');
  assert.equal(C.fxFailedPairs().length, failed.length - 1, 'callers get a copy');

  // Once per session: a second failing fill stays quiet.
  C.refreshDisplayRates(state);
  for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));
  assert.equal(banners.length, 1, 'warned once per session');
  console.log('fx failure warning checks passed');
})().catch(e => { console.error(e); process.exit(1); });
