#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};

function createApp(fetchImpl) {
  const store = new Map();
  const el = () => new Proxy(function () {}, {
    get: (target, key) => key === 'style' ? {} : key === 'classList'
      ? { add: noop, remove: noop, toggle: noop, contains: () => false }
      : key === 'querySelectorAll' ? () => [] : key === 'querySelector' ? () => null : noop,
    set: () => true,
    apply: () => el()
  });
  const context = {
    console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    document: {
      getElementById: () => null, addEventListener: noop, querySelector: () => null,
      querySelectorAll: () => [], createElement: () => el(), body: el(),
      documentElement: el(), readyState: 'loading'
    },
    navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' },
    addEventListener: noop, fetch: fetchImpl,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    requestAnimationFrame: noop, Event: function () {},
    crypto: { getRandomValues: value => value, subtle: {} },
    history: { pushState: noop, replaceState: noop },
    performance: { now: () => 0 }
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(src, context, { filename: 'app.js' });
  return context;
}

async function main() {
  let binanceRequests = 0;
  const blockedCoinGecko = createApp(url => {
    if (url.includes('api.coingecko.com')) return Promise.resolve({ ok: false, status: 429 });
    if (url.includes('api.kraken.com') || url.includes('api.exchange.coinbase.com')) {
      return Promise.resolve({ ok: false, status: 451 });
    }
    if (url === 'https://api.binance.com/api/v3/ticker/price') {
      binanceRequests++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { symbol: 'ADAUSDT', price: '0.5' },
          { symbol: 'BNBUSD', price: '610' },
          { symbol: 'BNBUSDT', price: '609' }
        ])
      });
    }
    throw new Error('Unexpected request: ' + url);
  });
  const concurrentPrices = await Promise.all([
    blockedCoinGecko.refreshAllPrices(['ADA'], 'USD', { ADA: 'crypto' }),
    blockedCoinGecko.refreshAllPrices(['BNB'], 'USD', { BNB: 'crypto' })
  ]);
  assert.equal(concurrentPrices[0].ADA, 0.5);
  assert.equal(concurrentPrices[1].BNB, 610);
  assert.equal(binanceRequests, 1, 'concurrent fallbacks share one ticker-list request');
  assert.equal(await blockedCoinGecko.fetchLivePrice('ADA', 'USD', 'crypto'), 0.5);

  const emptyCoinGecko = createApp(url => {
    if (url.includes('api.coingecko.com')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ bitcoin: {} }) });
    }
    if (url.includes('api.kraken.com') || url.includes('api.exchange.coinbase.com')) {
      return Promise.resolve({ ok: false, status: 451 });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([
        { symbol: 'BTCUSD', price: '65000' },
        { symbol: 'BTCUSDT', price: '64900' }
      ])
    });
  });
  const emptyBatchPrice = await emptyCoinGecko.refreshAllPrices(['BTC'], 'USD', { BTC: 'crypto' });
  assert.equal(emptyBatchPrice.BTC, 65000,
    'a successful but empty CoinGecko batch still tries live exchange prices');

  const missingPair = createApp(url => {
    if (url.includes('api.coingecko.com')) return Promise.resolve({ ok: false, status: 429 });
    if (url.includes('api.binance.com')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    return Promise.resolve({ ok: false, status: 451 });
  });
  const missingPrice = await missingPair.refreshAllPrices(['KAS'], 'USD', { KAS: 'crypto' });
  assert.equal(missingPrice.KAS, null, 'missing exchange quotes stay unknown rather than becoming zero');

  console.log('live price fallback checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
