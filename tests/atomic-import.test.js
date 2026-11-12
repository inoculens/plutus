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
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
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
const env = (accounts, trades) => JSON.stringify({ app: APP_ID, version: STORE_VERSION, exportedAt: '2026-01-10T00:00:00.000Z',
  settings: { mainCurrency: 'EUR', costMethod: 'fifo' }, accounts, trades, priceOverrides: {} });
const persisted = () => JSON.stringify(Array.from(store.entries()).sort());

const local = env([acc('local-1', 'BTC')], [buy('t1', 'local-1', 'BTC', 1, 100)]);
const remote = env([acc('remote-1', 'ETH'), acc('remote-2', 'SOL')], [buy('r1', 'remote-1', 'ETH', 2, 50)]);
C.importState(local);
const before = persisted();

// A confirm-gated restore validates first and writes nothing.
const parsed = C.parseImportedState(remote);
assert.equal(parsed.accounts.length, 2, 'dry run returns the normalized remote state');
assert.equal(persisted(), before, 'dry run left every stored byte unchanged');
assert.deepEqual(Array.from(C.loadState().accounts.map(a => a.id)), ['local-1'], 'local data still in place');

// Invalid backups fail in dry-run too, still without touching storage.
['{bad', JSON.stringify({ app: 'other' }), env([acc('__proto__', 'X')], []), env([acc('a', 'X'), acc('a', 'Y')], []),
  env([acc('a', 'X')], [buy('t', 'ghost', 'X', 1, 1)])].forEach(bad => {
  assert.throws(() => C.parseImportedState(bad), /import failed/);
  assert.equal(persisted(), before, 'failed dry run left state unchanged');
});

// Legacy v1 files obey the same rule.
const v1 = JSON.stringify({ app: APP_ID, version: 1, exportedAt: '2026-01-10T00:00:00.000Z', settings: { mainCurrency: 'EUR', costMethod: 'fifo' },
  trades: [{ id: 'v1t', type: 'buy', symbol: 'BTC', qty: 1, total: 100, date: '2026-01-02', currency: 'EUR' }], priceOverrides: {} });
assert.equal(C.parseImportedState(v1).accounts.length, 1);
assert.equal(persisted(), before, 'v1 dry run left state unchanged');

// The real import still persists exactly what the dry run returned.
const real = C.importState(remote);
assert.deepEqual(Array.from(real.accounts.map(a => a.id)), Array.from(parsed.accounts.map(a => a.id)));
assert.notEqual(persisted(), before);
assert.deepEqual(Array.from(C.loadState().accounts.map(a => a.id)).sort(), ['remote-1', 'remote-2']);
console.log('atomic-import: OK');
