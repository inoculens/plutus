#!/usr/bin/env node
'use strict';
// The net worth chart needs a fiat rate for every day it values. Fetching
// them one request per day, one after another, kept a multi-year chart on
// "Calculating values" for minutes. They are now fetched ahead of valuation
// in 90-day range requests, stored, and shared through the Price Data file,
// so a second load, or another synced device, downloads nothing. Loads the
// app in a stubbed vm context; all figures are invented.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const src = require('./app-source').appSource();
const noop = () => {};

function fixing(day) { return 0.85 + (Date.parse(day + 'T00:00:00Z') % 7) / 1000; }
function weekday(day) { const w = new Date(day + 'T00:00:00Z').getUTCDay(); return w !== 0 && w !== 6; }

function device() {
  const storage = new Map();
  const log = { range: 0, day: 0, rangeDown: false };
  const C = {
    console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); }, removeItem: k => { storage.delete(k); } },
    document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
    navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
    fetch: (url) => {
      const ok = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      let m = /\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\?base=USD&symbols=EUR$/.exec(url);
      if (m) {
        log.range++;
        if (log.rangeDown) return Promise.resolve({ ok: false, status: 503 });
        const rates = {};
        for (let d = m[1]; d <= m[2]; d = C.fxShiftDate(d, 1)) if (weekday(d)) rates[d] = { EUR: fixing(d) };
        return ok({ amount: 1, base: 'USD', start_date: m[1], end_date: m[2], rates });
      }
      m = /\/v2\/providers\/ecb\/rate\/usd\/eur\?date=(\d{4}-\d{2}-\d{2})$/.exec(url);
      if (m) {
        log.day++;
        let d = m[1];
        while (!weekday(d)) d = C.fxShiftDate(d, -1);
        return ok({ base: 'USD', quote: 'EUR', rate: fixing(d), date: d });
      }
      return Promise.reject(new TypeError('unexpected ' + url));
    },
    matchMedia: () => ({ matches: false, addEventListener: noop }), requestAnimationFrame: noop, Event: function () {},
    crypto: { getRandomValues: a => a, subtle: {} }, history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
  };
  C.window = C; C.self = C; C.globalThis = C;
  vm.createContext(C);
  vm.runInContext(src, C, { filename: 'app-scripts.js' });
  return { C, log, run: code => vm.runInContext(code, C) };
}

const days = [];
for (let d = '2025-06-01'; d <= '2026-11-27'; d = d.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, mo, da) => new Date(Date.UTC(+y, +mo - 1, +da + 1)).toISOString().slice(0, 10))) days.push(d);

(async () => {
  // First load on a device with nothing stored: range requests only.
  const a = device();
  await a.C.netWorthHistoryPrefetchRates(['USD'], 'EUR', days);
  assert.ok(a.log.range > 0 && a.log.range <= Math.ceil(days.length / 90) + 1,
    days.length + ' days in ' + a.log.range + ' range requests');
  assert.equal(a.log.day, 0, 'no per-day requests when the range answers');
  days.forEach(day => {
    const r = a.C.getCachedRate(day, 'USD', 'EUR');
    assert.ok(r, 'a rate for ' + day);
    let f = day; while (!weekday(f)) f = a.C.fxShiftDate(f, -1);
    assert.equal(r.rate, fixing(f), day + ' carries the fixing of ' + f);
    assert.equal(r.source, 'ECB-' + f);
    assert.ok(a.C.fxCacheSourceTrusted(day, r.source), 'stored rates survive the copied-rate cleanup');
  });

  // Second load on the same device: everything is held, nothing is fetched.
  a.log.range = 0;
  await a.C.netWorthHistoryPrefetchRates(['USD'], 'EUR', days);
  await a.C.fetchNetWorthHistoryRate('2026-03-04', 'USD', 'EUR');
  assert.equal(a.log.range + a.log.day, 0, 'a later load downloads no rates');

  // Another synced device receives the Price Data file: its shared rate
  // series holds every day, so it downloads nothing either.
  const payload = a.C.priceDataNormalizeSeries(a.run('netWorthHistorySeriesCache'), true);
  const fxKey = Object.keys(payload).find(k => /^FXECB-USD-EUR\|/.test(k));
  assert.ok(fxKey, 'the rates are in the series written to the Price Data file');
  const b = device();
  b.run('netWorthHistorySeriesCache[' + JSON.stringify(fxKey) + '] = ' +
    JSON.stringify({ at: payload[fxKey].at, series: payload[fxKey].series, shared: true }) + ';');
  await b.C.netWorthHistoryPrefetchRates(['USD'], 'EUR', days);
  assert.equal(b.log.range + b.log.day, 0, 'a synced device reads the shared rates instead of downloading');
  assert.equal(b.run('netWorthHistorySharedRate("2026-03-07", "USD", "EUR")').rate, fixing('2026-03-06'));

  // If the range source is down, days are fetched one by one, six at a time.
  const c = device();
  c.log.rangeDown = true;
  c.run('netWorthHistoryFetchBudget = { signature: "t", remaining: 1000 };');
  const recent = days.slice(-20);
  await c.C.netWorthHistoryPrefetchRates(['USD'], 'EUR', recent);
  assert.equal(c.log.day, recent.length, 'each missing day fetched once');
  recent.forEach(day => assert.ok(c.C.getCachedRate(day, 'USD', 'EUR'), 'fallback stores ' + day));

  console.log('fx range prefetch checks passed');
})().catch(e => { console.error(e); process.exit(1); });
