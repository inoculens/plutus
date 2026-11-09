#!/usr/bin/env node
'use strict';

// The per-record execution price must use the public Plutus daily archive for
// assets the majors-only sources (Coinbase/Kraken) do not cover, instead of
// depending on CoinGecko's short free history window. Exact day only.

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

const DAY = 86400000;
const close = iso => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY) * DAY + DAY - 1;
const archive = {
  schema: 1, currency: 'USD',
  assets: { XMR: { points: [
    [close('2021-06-01'), 150, 2, ['kraken', 'kucoin']],
    [close('2021-06-03'), 160, 2, ['kraken', 'kucoin']]
  ] } }
};

async function run() {
  const urls = [];
  C.fetch = url => {
    urls.push(String(url));
    if (String(url).includes('raw.githubusercontent.com')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(archive) });
    }
    return Promise.reject(new Error('offline'));
  };

  // Covered day, USD: served from the archive, CoinGecko never asked.
  assert.equal(await C.fetchHistoricalCryptoPrice('XMR', '2021-06-01', 'USD'), 150);
  assert.ok(!urls.some(u => u.includes('coingecko')), 'archive hit must not call CoinGecko');

  // Non-USD fiat bridges through the historical ECB USD rate.
  C.fetchEcbRate = () => Promise.resolve({ rate: 0.8 });
  assert.equal(await C.fetchHistoricalCryptoPrice('XMR', '2021-06-03', 'EUR'), 160 * 0.8);

  // A day missing from the archive is null (never interpolated).
  assert.equal(await C.fetchArchiveHistory('XMR', '2021-06-02', 'USD'), null);
  assert.equal(await C.fetchHistoricalCryptoPrice('XMR', '2021-06-02', 'USD'), null);

  // An asset the archive does not hold is null.
  assert.equal(await C.fetchArchiveHistory('NOPE', '2021-06-01', 'USD'), null);

  console.log('archive exec fallback checks passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
