#!/usr/bin/env node
'use strict';
// The parsed-state cache must be invisible: loadState() always reflects the
// stored text exactly, hands out a private copy that callers may mutate, and
// re-validates when either the stored text or the latest calendar date that
// exists anywhere changes (future-dated records become valid at that
// instant). All figures are invented. Loads the app in a stubbed vm context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = require('./app-source').appSource();
const noop = () => {};

let nowMs = Date.parse('2025-06-01T12:00:00Z');
class ClockDate extends Date { static now() { return nowMs; } }
const store = new Map();
let reads = 0;
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date: ClockDate,
  localStorage: {
    getItem: k => { reads++; return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app-scripts.js' });

const KEY = 'inoculens.v2';
const accounts = [{ id: 'a1', name: 'Wallet', ticker: 'BTC', kind: 'crypto' }];
const buy = (id, date) => ({ id, type: 'buy', accountId: 'a1', symbol: 'BTC', qty: 1, total: 100, currency: 'EUR', date });
const put = trades => store.set(KEY, JSON.stringify({ settings: { mainCurrency: 'EUR', costMethod: 'fifo' }, accounts, trades, priceOverrides: {} }));

// 1. A copy per call: mutating one result never leaks into the next read.
put([buy('t1', '2025-01-01')]);
const a = C.loadState();
a.trades.push(buy('t2', '2025-01-02'));
a.accounts[0].name = 'Changed';
a.settings.mainCurrency = 'USD';
const b = C.loadState();
assert.equal(b.trades.length, 1, 'mutating a loaded state does not change the next load');
assert.equal(b.accounts[0].name, 'Wallet');
assert.equal(b.settings.mainCurrency, 'EUR');
assert.notEqual(a, b);
assert.equal(C.peekState(), C.peekState(), 'peekState shares one validated copy');

// 2. Any change to the stored text is seen at once (other tab, sync, import).
put([buy('t1', '2025-01-01'), buy('t3', '2025-01-03')]);
assert.deepEqual(C.loadState().trades.map(t => t.id).join(',').split(','), ['t1', 't3']);
C.saveState(Object.assign(C.loadState(), { trades: [buy('t4', '2025-01-04')] }));
assert.deepEqual(C.loadState().trades.map(t => t.id).join(',').split(','), ['t4'], 'a save is read back');

// 3. Date-dependent validation re-runs when the latest date anywhere moves.
// Now is 2025-06-01 12:00Z, so the latest date anywhere is 2025-06-02.
put([buy('t1', '2025-01-01'), buy('late', '2025-06-03')]);
assert.deepEqual(C.loadState().trades.map(t => t.id).join(',').split(','), ['t1'], 'a record dated past every timezone is rejected');
nowMs = Date.parse('2025-06-02T09:59:59Z');
assert.equal(C.maxCalendarDateAnywhere(), '2025-06-02');
assert.equal(C.loadState().trades.length, 1);
nowMs = Date.parse('2025-06-02T10:00:00Z'); // midnight in UTC+14
assert.equal(C.maxCalendarDateAnywhere(), '2025-06-03');
assert.deepEqual(C.loadState().trades.map(t => t.id).join(',').split(','), ['t1', 'late'], 'the record becomes valid at the exact instant');
nowMs = Date.parse('2025-06-01T00:00:00Z'); // clock moved backwards
assert.equal(C.maxCalendarDateAnywhere(), '2025-06-01');

// 4. Reads stay cheap: one storage read per call, no re-validation.
nowMs = Date.parse('2025-06-02T12:00:00Z');
const many = [];
for (let i = 0; i < 2000; i++) many.push(buy('m' + i, '2024-01-01'));
put(many);
C.loadState();
const t0 = process.hrtime.bigint();
for (let i = 0; i < 200; i++) C.peekState();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert.ok(ms < 200, '200 cached reads of 2000 records took ' + ms.toFixed(1) + 'ms');

// 5. Copies are exact for any JSON: a "__proto__" key is data (JSON.parse
// keeps it as an ordinary own key). It must never become a prototype, in the
// cached copy or in the normalized record, so nothing is inherited from it.
store.set(KEY, '{"settings":{"mainCurrency":"EUR","costMethod":"fifo"},"accounts":[{"id":"a1","name":"Wallet","ticker":"BTC","kind":"crypto"}],' +
  '"trades":[{"id":"p1","type":"buy","accountId":"a1","symbol":"BTC","qty":1,"total":100,"currency":"EUR","date":"2025-01-01",' +
  '"fxLock":{"__proto__":{"rate":5},"pair":"EUR/EUR","rate":1,"source":"1:1","interpolated":false},"__proto__":{"swapId":"evil","qty":7}}],"priceOverrides":{}}');
for (const read of [() => C.loadState(), () => C.loadState(), () => C.peekState()]) {
  const t = read().trades[0];
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(t)), null, 'record keeps the plain object prototype');
  assert.equal(t.swapId, undefined, 'nothing is inherited from a "__proto__" key');
  assert.ok(Object.prototype.hasOwnProperty.call(t, '__proto__'), 'the key itself is kept as data');
  assert.ok(Object.prototype.hasOwnProperty.call(t.fxLock, '__proto__'), 'nested "__proto__" key kept as data');
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(t.fxLock)), null);
}
assert.equal(C.cloneJson(Object.assign(Object.create(null), { a: 1 })).toString, undefined, 'null-prototype objects stay null-prototype');

// 6. Validation uses the price kinds of the state being read, already on the
// first read after start-up. A stock ticker keeps 8 decimals even when it is
// also a crypto symbol (SOL has 9), and a multi-source transfer must add up
// exactly at that precision: 0.100000005 + 0.200000005 = 0.30000001 holds at
// 9 decimals but not at 8, so the record is rejected (and the original kept
// as a recovery copy) on every read, not only from the second read on.
const solAcc = id => ({ id, name: 'Shares ' + id, ticker: 'SOL', kind: 'stock' });
const solState = JSON.stringify({ settings: { mainCurrency: 'EUR', costMethod: 'fifo' }, accounts: [solAcc('s1'), solAcc('s2'), solAcc('s3')],
  trades: [buy('k1', '2025-01-01'), Object.assign(buy('k2', '2025-01-01'), { accountId: 's2', symbol: 'SOL' }),
    { id: 'ms', type: 'transfer', accountId: 's1', symbol: 'SOL', qty: '0.30000001', currency: 'EUR', total: 0, date: '2025-01-02', networkFee: 0,
      sources: [{ accountId: 's1', qty: '0.100000005' }, { accountId: 's2', qty: '0.200000005' }], outputs: [{ toAccountId: 's3', qty: '0.30000001' }] }].map(t => Object.assign(t, t.id === 'k1' ? { accountId: 's1', symbol: 'SOL' } : {})),
  priceOverrides: {} });
{
  const fresh = new Map([[KEY, solState]]);
  const D = Object.assign({}, C, { localStorage: { getItem: k => (fresh.has(k) ? fresh.get(k) : null), setItem: (k, v) => fresh.set(k, String(v)), removeItem: k => fresh.delete(k) } });
  D.window = D; D.self = D; D.globalThis = D;
  vm.createContext(D);
  vm.runInContext(src, D, { filename: 'app.js' });
  const first = D.loadState().trades.map(t => t.id).join(',');
  const later = D.loadState().trades.map(t => t.id).join(',');
  assert.equal(first, 'k1,k2', 'first read already uses stock precision');
  assert.equal(later, first, 'same answer on every read');
  assert.ok(D.storageRecovery && D.storageRecovery.trades === 1, 'the rejected record is reported');
}

// 7. Empty storage still yields a fresh default state each time.
store.delete(KEY);
const e1 = C.loadState(); e1.trades.push(1);
assert.equal(C.loadState().trades.length, 0);

console.log('state cache checks passed');
