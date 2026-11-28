#!/usr/bin/env node
'use strict';
// Chart valuation used to copy an earlier day's fiat rate and store it as the
// day's own rate, so one old fixing spread forward day after day, into the
// device's rate cache and, through Price Data, into the shared chart series.
// Points then jumped between that copied rate and the real ones (a ±14%
// saw-tooth for USD -> EUR). Only real ECB fixings may be stored now, copied
// rates are dropped on load, and the retired shared series is ignored.
// Loads the app in a stubbed vm context; all figures are invented.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const src = require('./app-source').appSource();
const noop = () => {};

const storage = new Map();
let online = true;
let fetches = [];
const fixings = { '2026-11-24': 0.861, '2026-11-25': 0.866, '2026-11-27': 0.871 };
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: k => { storage.delete(k); }
  },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' },
  addEventListener: noop,
  fetch: (url) => {
    fetches.push(url);
    if (!online) return Promise.reject(new TypeError('offline'));
    const date = /date=([\d-]+)/.exec(url)[1];
    let d = date;
    while (!fixings[d]) d = C.fxShiftDate(d, -1);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ base: 'USD', quote: 'EUR', rate: fixings[d], date: d }) });
  },
  matchMedia: () => ({ matches: false, addEventListener: noop }), requestAnimationFrame: noop, Event: function () {},
  crypto: { getRandomValues: a => a, subtle: {} }, history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app-scripts.js' });
const run = code => vm.runInContext(code, C);

(async () => {
  // Which cached sources are real fixings for their date.
  const trusted = C.fxCacheSourceTrusted;
  assert.equal(trusted('2026-11-27', 'ECB-2026-11-27'), true, 'same-day fixing');
  assert.equal(trusted('2026-11-28', 'ECB-2026-11-27'), true, 'Saturday uses Friday');
  assert.equal(trusted('2026-11-30', 'ECB-2026-11-27'), true, 'a holiday Monday uses Friday');
  assert.equal(trusted('2026-04-06', 'ECB-2026-04-02'), true, 'Easter Monday uses Thursday');
  assert.equal(trusted('2026-11-27', 'ECB-2022-09-26'), false, 'a fixing years old is a copy');
  assert.equal(trusted('2026-11-27', 'ECB-2026-11-20'), false, 'a week-old fixing on a weekday is a copy');
  assert.equal(trusted('2026-11-26', 'ECB-2026-11-27'), false, 'a later fixing is never a rate for an earlier day');
  assert.equal(trusted('2026-11-27', 'Price Data'), false, 'rates copied from the shared chart series are dropped');
  assert.equal(trusted('2026-11-27', 'manual'), true, 'unlabelled sources are kept');

  // Loading the cache drops copied rates and writes the clean cache back.
  storage.set('inoculens.fxcache.v1', JSON.stringify({
    '2026-11-24|USD|EUR': { rate: 0.861, source: 'ECB-2026-11-24' },
    '2026-11-25|USD|EUR': { rate: 0.98058, source: 'Price Data' },
    '2026-11-26|USD|EUR': { rate: 0.98058, source: 'ECB-2022-09-26' },
    '2026-11-28|USD|EUR': { rate: 0.871, source: 'ECB-2026-11-27' }
  }));
  const cache = C.loadFxCache(true);
  assert.deepEqual(Object.keys(cache).sort(), ['2026-11-24|USD|EUR', '2026-11-28|USD|EUR'], 'copied rates are dropped');
  assert.deepEqual(Object.keys(JSON.parse(storage.get('inoculens.fxcache.v1'))).sort(), ['2026-11-24|USD|EUR', '2026-11-28|USD|EUR'],
    'the cleaned cache is saved');

  // A day without a stored fixing is fetched, never copied from the day before.
  run('netWorthHistoryFetchBudget = { signature: "t", remaining: 100 };');
  fetches = [];
  const fetched = await C.fetchNetWorthHistoryRate('2026-11-25', 'USD', 'EUR');
  assert.equal(fetched.rate, 0.866, 'the real fixing of the day');
  assert.equal(fetches.length, 1, 'fetched from the ECB source');
  assert.equal(C.getCachedRate('2026-11-25', 'USD', 'EUR').rate, 0.866, 'the real fixing is cached');

  // Offline: an earlier real fixing stands in for this valuation only.
  online = false;
  const borrowed = await C.fetchNetWorthHistoryRate('2026-11-26', 'USD', 'EUR');
  assert.equal(borrowed.rate, 0.866, 'the nearest earlier fixing stands in');
  assert.equal(borrowed.interpolated, true);
  assert.equal(C.getCachedRate('2026-11-26', 'USD', 'EUR'), null, 'a borrowed rate is never stored as the day\'s rate');
  assert.equal(run('netWorthHistorySharedRate("2026-11-26", "USD", "EUR")'), null, 'nor shared through Price Data');
  online = true;
  const later = await C.fetchNetWorthHistoryRate('2026-11-26', 'USD', 'EUR');
  assert.equal(later.rate, 0.866, 'back online, the day is fetched (Thursday 26 had no fixing in this fixture)');
  assert.equal(later.source, 'ECB-2026-11-25');

  // Real fixings are shared under the new series; the retired one is dropped
  // from the Price Data file.
  assert.equal(run('netWorthHistorySharedRate("2026-11-25", "USD", "EUR")').rate, 0.866);
  const series = C.priceDataNormalizeSeries({
    'FX-USD-EUR|commodity|EUR|0|4102444800': { at: 1, series: { currency: 'EUR', kind: 'commodity', points: [{ at: 1, price: 0.98058 }] } },
    'FXECB-USD-EUR|commodity|EUR|0|4102444800': { at: 1, series: { currency: 'EUR', kind: 'commodity', points: [{ at: 1, price: 0.866 }] } }
  }, true);
  assert.deepEqual(Object.keys(series), ['FXECB-USD-EUR|commodity|EUR|0|4102444800'], 'the retired FX- series is dropped');

  console.log('fx copied-rate checks passed');
})().catch(e => { console.error(e); process.exit(1); });
