#!/usr/bin/env node
'use strict';

// SPENT AMOUNT values a crypto-quantity expense at its tx-date fiat rate, so
// that expense needs the same reference quote (history prefetch) as
// buy/sell/transfer. Before the fix, ensureHistoricalExec skipped expenses and
// the pills counted them as 0 unless a buy/sell on the same day cached the rate.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const store = new Map();
const noop = () => {};
const el = () => new Proxy(function () {}, {
  get: (target, key) => key === 'style' ? {} : key === 'classList'
    ? { add: noop, remove: noop, toggle: noop, contains: () => false }
    : key === 'querySelectorAll' ? () => [] : key === 'querySelector' ? () => null : noop,
  set: () => true,
  apply: () => el()
});
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  },
  document: {
    getElementById: () => null, addEventListener: noop, querySelector: () => null,
    querySelectorAll: () => [], createElement: () => el(), body: el(), documentElement: el(), readyState: 'loading'
  },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: value => value, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C;
C.self = C;
C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

async function run() {
  // Classification: only an expense that loses a positive quantity qualifies.
  assert.equal(C.isCryptoQtyExpense({ type: 'expense', qty: 0.5 }), true);
  assert.equal(C.isCryptoQtyExpense({ type: 'expense', qty: '0.5' }), true);
  assert.equal(C.isCryptoQtyExpense({ type: 'expense', total: 25, currency: 'EUR' }), false);
  assert.equal(C.isCryptoQtyExpense({ type: 'expense', qty: '' }), false);
  assert.equal(C.isCryptoQtyExpense({ type: 'expense', qty: 0 }), false);
  assert.equal(C.isCryptoQtyExpense({ type: 'buy', qty: 1 }), false);

  // The history prefetch must now request a rate for a crypto expense.
  const requested = [];
  C.fetchHistoricalPrice = (sym, day, main) => {
    requested.push([sym, day, main]);
    return Promise.resolve({ price: 50 });
  };
  const expense = { id: 'e1', type: 'expense', symbol: 'BTC', qty: 0.5, date: '2024-01-02', accountId: 'a1' };
  const changed = await C.ensureHistoricalExec([expense], 'EUR', {});
  assert.equal(requested.length, 1, 'expense should trigger a historical rate fetch');
  assert.deepEqual(requested[0], ['BTC', '2024-01-02', 'EUR']);
  assert.equal(changed, true);

  // Once cached, the expense resolves to a fiat rate, so SPENT can value it.
  const rate = C.resolveExecPrice(expense, 'EUR', undefined);
  assert.ok(rate && rate.price === 50, 'expense resolves a cached rate');
  assert.equal(0.5 * rate.price, 25);

  // Cash-only expenses stay out of the rate prefetch.
  requested.length = 0;
  await C.ensureHistoricalExec([{ id: 'e2', type: 'expense', symbol: 'EUR', total: 25, currency: 'EUR', date: '2024-01-03', accountId: 'a2' }], 'EUR', {});
  assert.equal(requested.length, 0);

  console.log('expense spent-rate checks passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
