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

const APP_ID = vm.runInContext('APP_ID', C);
const STORE_VERSION = vm.runInContext('STORE_VERSION', C);
const acc = (id, ticker) => ({ id, name: 'Acct ' + ticker, ticker, kind: 'crypto', createdAt: '2026-01-01T00:00:00.000Z' });
const buy = (id, accountId, symbol, qty, price) => ({ id, type: 'buy', accountId, symbol, qty, total: qty * price, date: '2026-01-02', currency: 'EUR' });
const good = () => ({ settings: { mainCurrency: 'EUR', costMethod: 'fifo', assetLedgers: true, dateFormat: 'YYYY-MM-DD' },
  accounts: [acc('btc-1', 'BTC'), acc('eth-1', 'ETH')], trades: [buy('t1', 'btc-1', 'BTC', 1, 100), buy('t2', 'eth-1', 'ETH', 2, 50)], priceOverrides: {} });

// A complete state exports and imports back losslessly.
const full = C.exportStateStrict(good());
const back = JSON.parse(full);
assert.equal(back.accounts.length, 2); assert.equal(back.trades.length, 2);
assert.doesNotThrow(() => C.parseImportedState(full));
assert.doesNotThrow(() => C.exportStateStrict({ accounts: [], trades: [], settings: good().settings, priceOverrides: {} }), 'empty state exports');

// Anything that would be silently dropped makes the strict export refuse.
const withBadAccount = good(); withBadAccount.accounts.push({ id: '__proto__', name: 'x', ticker: 'BTC', kind: 'crypto' });
const withBadTrade = good(); withBadTrade.trades.push({ id: 'bad', type: 'buy', accountId: 'btc-1', symbol: 'BTC', qty: -5, total: 'abc', date: 'nope' });
const withGhostTrade = good(); withGhostTrade.trades.push(buy('t3', 'ghost', 'BTC', 1, 1));
const withBadOverrides = good(); withBadOverrides.priceOverrides = { BTC: 'not-a-price' };
[['invalid account', withBadAccount, 1], ['invalid trade', withBadTrade, 1], ['trade on missing account', withGhostTrade, 1], ['invalid price overrides', withBadOverrides, 1]].forEach(([label, st, n]) => {
  assert.throws(() => C.exportStateStrict(st), /export failed: \d+ stored records? (is|are) invalid/, label);
  // The tolerant export still works for internal hashing and drops them.
  const tolerant = JSON.parse(C.exportState(st));
  assert.ok(tolerant.accounts.length === 2 && tolerant.trades.length <= 2, label + ' tolerant export is trimmed');
});
assert.match(String(((() => { try { C.exportStateStrict(withBadAccount); } catch (e) { return e.message; } })())), /1 stored record is invalid/);

// Storage quota error: existing data survives and the failure is reported.
C.importState(full);
const stored = store.get('inoculens.v2');
assert.ok(stored && stored.length > 10);
quotaFull = true;
const next = good(); next.trades.push(buy('t9', 'btc-1', 'BTC', 9, 9));
assert.throws(() => C.saveState(next), /storage-unavailable/);
quotaFull = false;
assert.equal(store.get('inoculens.v2'), stored, 'quota failure left the stored state byte-identical');
console.log('export-integrity: OK');
