#!/usr/bin/env node
'use strict';
// Display FX fills run on every repaint. A pair already being fetched is
// shared, and a pair that just failed is not re-requested until its cooldown
// ends (30 s, doubling per failure), so an offline device with a large ledger
// does not re-request every missing pair on every paint. Saving a record
// (fetchEcbRate) always tries the network. Loads the app in a stubbed vm
// context; all figures are invented.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const src = require('./app-source').appSource();
const noop = () => {};

let nowMs = Date.parse('2025-06-01T12:00:00Z');
class ClockDate extends Date { static now() { return nowMs; } }
let calls = 0;
let online = false;
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date: ClockDate,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: (url) => {
    calls++;
    if (!online) return Promise.reject(new TypeError('offline'));
    const date = /date=([\d-]+)/.exec(url)[1];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: 'USD', quote: 'EUR', rate: 0.9, date }) });
  },
  matchMedia: () => ({ matches: false, addEventListener: noop }), requestAnimationFrame: noop, Event: function () {},
  crypto: { getRandomValues: a => a, subtle: {} }, history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app-scripts.js' });

const trades = [{ id: 'i1', type: 'income', accountId: 'c', symbol: 'USD', qty: 10, total: 10, currency: 'USD', date: '2025-03-04' }];
const kinds = { c: 'cash' };

(async () => {
  // A cash income needs two pairs: its trade date and today (open cash
  // income floats at the latest fixing).
  assert.equal(C.displayPairs(trades, 'EUR', kinds).length, 2);
  // Concurrent fills share one request per pair (fetchEcbRate retries a
  // network failure once: 2 calls per pair, 4 in all, not 8).
  const [a, b] = await Promise.all([C.ensureDisplayRates(trades, 'EUR', kinds), C.ensureDisplayRates(trades, 'EUR', kinds)]);
  assert.equal(a, false); assert.equal(b, false);
  assert.equal(calls, 4, 'one shared request per pair for two concurrent fills');

  // Repaints during the cooldown do not touch the network.
  calls = 0;
  for (let i = 0; i < 5; i++) assert.equal(await C.ensureDisplayRates(trades, 'EUR', kinds), false);
  assert.equal(calls, 0, 'no request while the pair cools down');
  assert.ok(C.fxFailedPairs().length >= 1, 'the failure is still reported');

  // Saving a record always tries.
  await C.fetchEcbRate('2025-03-04', 'USD', 'EUR').catch(noop);
  assert.ok(calls > 0, 'fetchEcbRate is not throttled');

  // After the cooldown the fill retries, and a success fills the cache.
  nowMs += 30001;
  online = true;
  calls = 0;
  assert.equal(await C.ensureDisplayRates(trades, 'EUR', kinds), true, 'retried after the cooldown');
  assert.equal(calls, 2, 'one request per pair');
  assert.equal(C.getCachedRate('2025-03-04', 'USD', 'EUR').rate, 0.9);
  calls = 0;
  assert.equal(await C.ensureDisplayRates(trades, 'EUR', kinds), false, 'cached: nothing left to fill');
  assert.equal(calls, 0);

  // Backoff doubles; clearFxCache resets it.
  C.clearFxCache();
  online = false;
  await C.ensureDisplayRates(trades, 'EUR', kinds);
  await C.ensureDisplayRates(trades, 'EUR', kinds).catch(noop);
  nowMs += 30001;
  calls = 0;
  await C.ensureDisplayRates(trades, 'EUR', kinds); // 2nd failure -> 60 s cooldown
  nowMs += 30001;
  calls = 0;
  await C.ensureDisplayRates(trades, 'EUR', kinds);
  assert.equal(calls, 0, 'second cooldown is longer (60 s)');
  C.clearFxCache();
  await C.ensureDisplayRates(trades, 'EUR', kinds);
  assert.ok(calls > 0, 'clearFxCache resets the cooldown');
  console.log('fx fill cooldown checks passed');
})().catch(e => { console.error(e); process.exit(1); });
