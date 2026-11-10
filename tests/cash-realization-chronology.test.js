#!/usr/bin/env node
'use strict';
// Cash FIFO realization must follow the timeline: an expense can only consume
// income that already exists on or before its date, never income dated later.
// A cash income's display value is consumed*spendRate + remainder*todayRate,
// so a wrongly matched expense shows up as its spend rate leaking into a later
// income. All figures are invented. Loads app.js in a stubbed vm context.
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

const fx = rate => ({ pair: 'USD/EUR', rate, source: 'test', interpolated: false });
let n = 0;
const tx = (type, date, qty, rate, extra) => Object.assign({
  id: 't' + (++n), type, symbol: 'USD', qty, total: qty * rate, currency: 'EUR', date, accountId: 'cash1', fxLock: fx(rate)
}, extra || {});
const run = trades => C.buildCashRealization(trades, 'EUR', id => id === 'cash1');
const val = (m, t) => Number(m.get(t).toFixed(6));

// Expense BEFORE any income: the later income must not be consumed.
{
  const e = tx('expense', '2025-01-10', 100, 2);
  const i = tx('income', '2025-02-10', 100, 1);
  const m = run([e, i]);
  assert.equal(val(m, i), 100, 'income keeps its own rate; the January expense cannot spend it');
  assert.equal(run([i, e]).get(i), m.get(i), 'input order does not matter');
}

// Income BEFORE expense: normal FIFO attribution.
{
  const i = tx('income', '2025-01-01', 100, 1);
  const e = tx('expense', '2025-01-10', 40, 3);
  const m = run([i, e]);
  assert.equal(val(m, i), 40 * 3 + 60 * 1);
}

// Oldest available lot is consumed first.
{
  const i1 = tx('income', '2025-01-01', 50, 1);
  const i2 = tx('income', '2025-01-05', 50, 1);
  const e = tx('expense', '2025-01-10', 60, 4);
  const m = run([i2, e, i1]);
  assert.equal(val(m, i1), 50 * 4, 'oldest lot fully consumed');
  assert.equal(val(m, i2), 10 * 4 + 40 * 1, 'next lot partly consumed');
}

// One income, several expenses.
{
  const i = tx('income', '2025-01-01', 100, 1);
  const e1 = tx('expense', '2025-01-02', 30, 2);
  const e2 = tx('expense', '2025-01-03', 30, 3);
  const m = run([i, e1, e2]);
  assert.equal(val(m, i), 30 * 2 + 30 * 3 + 40 * 1);
}

// Expense larger than income received so far: only the earlier part is
// attributed; a later income stays untouched.
{
  const i1 = tx('income', '2025-01-01', 50, 1);
  const e = tx('expense', '2025-01-10', 80, 5);
  const i2 = tx('income', '2025-02-01', 100, 1);
  const m = run([i1, e, i2]);
  assert.equal(val(m, i1), 50 * 5);
  assert.equal(val(m, i2), 100 * 1, 'uncovered 30 never consumes the February income');
}

// Same date: income books before expense, whatever the store order.
{
  const e = tx('expense', '2025-03-01', 20, 2);
  const i = tx('income', '2025-03-01', 20, 1);
  assert.equal(val(run([e, i]), i), 20 * 2);
  assert.equal(val(run([i, e]), i), 20 * 2);
}

// Different accounts / fiats never mix.
{
  const e = tx('expense', '2025-01-10', 10, 2);
  const iOther = tx('income', '2025-01-01', 10, 1, { accountId: 'cash2' });
  const m = C.buildCashRealization([e, iOther], 'EUR', () => true);
  assert.equal(val(m, iOther), 10, 'other account income is not consumed');
}

console.log('cash realization chronology checks passed');
