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

  function mismatchedXmrFeed(url) {
    if (url.includes('api.coingecko.com')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ monero: { eur: 100 }, bitcoin: { eur: 60000 } })
      });
    }
    if (url.includes('api.kraken.com')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: { XXMRZUSD: { c: ['600'] } } })
      });
    }
    if (url.includes('api.frankfurter.dev')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ date: new Date().toISOString().slice(0, 10), rates: { EUR: 0.9 } })
      });
    }
    if (url.includes('api.exchange.coinbase.com')) return Promise.resolve({ ok: false, status: 404 });
    if (url.includes('api.binance.com')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    throw new Error('Unexpected request: ' + url);
  }
  const mismatchedXmr = createApp(mismatchedXmrFeed);
  const correctedBatch = await mismatchedXmr.refreshAllPrices(
    ['XMR', 'BTC'], 'EUR', { XMR: 'crypto', BTC: 'crypto' }
  );
  assert.equal(correctedBatch.XMR, 540, 'the independent Kraken quote replaces a bad XMR batch quote');
  assert.equal(correctedBatch.BTC, 60000, 'other CoinGecko prices are unchanged by the XMR check');

  const mismatchedSingleXmr = createApp(mismatchedXmrFeed);
  assert.equal(await mismatchedSingleXmr.fetchLivePrice('XMR', 'EUR', 'crypto'), 540,
    'the independent Kraken quote replaces a bad single-symbol XMR quote');

  function aaveFallbackFeed(krakenAvailable, coinbaseAvailable) {
    return url => {
      if (url.includes('api.coingecko.com')) return Promise.resolve({ ok: false, status: 429 });
      if (url.includes('api.kraken.com')) {
        return Promise.resolve(krakenAvailable
          ? { ok: true, json: () => Promise.resolve({ result: { AAVEUSD: { c: ['127.45'] } } }) }
          : { ok: false, status: 451 });
      }
      if (url.includes('api.exchange.coinbase.com')) {
        return Promise.resolve(coinbaseAvailable
          ? { ok: true, json: () => Promise.resolve({ price: '127.44' }) }
          : { ok: false, status: 451 });
      }
      if (url.includes('api.binance.com')) return Promise.resolve({ ok: false, status: 451 });
      throw new Error('Unexpected request: ' + url);
    };
  }
  const krakenAave = createApp(aaveFallbackFeed(true, false));
  assert.equal(krakenAave.SYMBOL_MAP.AAVE, 'aave', 'AAVE keeps its correct CoinGecko ID');
  assert.equal(krakenAave.KRAKEN_SYMBOLS.includes('AAVE'), false,
    'live Kraken coverage does not change historical-source coverage');
  assert.equal(await krakenAave.fetchLivePrice('AAVE', 'USD', 'crypto'), 127.45,
    'single-symbol AAVE pricing falls back to Kraken when CoinGecko is unavailable');

  const coinbaseAave = createApp(aaveFallbackFeed(false, true));
  assert.equal(coinbaseAave.COINBASE_SYMBOLS.includes('AAVE'), false,
    'live Coinbase coverage does not change historical-source coverage');
  const aaveBatch = await coinbaseAave.refreshAllPrices(['AAVE'], 'USD', { AAVE: 'crypto' });
  assert.equal(aaveBatch.AAVE, 127.44,
    'batched AAVE pricing falls back to Coinbase when CoinGecko and Kraken are unavailable');

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

  const historyApp = createApp(() => Promise.reject(new Error('unexpected network request')));
  const historyEnd = Date.now();
  const currentHistory = await historyApp.buildNetWorthHistory({
    accounts: [],
    trades: [],
    settings: { mainCurrency: 'USD', costMethod: 'average' }
  }, 'USD', {
    period: '1Y',
    start: historyEnd - 2 * 86400000,
    end: historyEnd
  }, null, {
    value: 9876.54,
    prices: { BTC: 65000 }
  });
  assert.equal(currentHistory.points[currentHistory.points.length - 1].value, 9876.54,
    'the current chart endpoint uses the same live valuation snapshot as the balance');
  assert.equal(currentHistory.points[currentHistory.points.length - 1].prices.BTC, 65000);

  const unknownHistory = await historyApp.buildNetWorthHistory({
    accounts: [],
    trades: [],
    settings: { mainCurrency: 'USD', costMethod: 'average' }
  }, 'USD', {
    period: '1Y',
    start: historyEnd - 2 * 86400000,
    end: historyEnd
  }, null, {
    value: null,
    prices: {}
  });
  assert.equal(unknownHistory.points[unknownHistory.points.length - 1].value, null,
    'unknown current valuations remain a gap instead of becoming zero');

  const pastEnd = historyEnd - 86400000;
  const pastHistory = await historyApp.buildNetWorthHistory({
    accounts: [],
    trades: [],
    settings: { mainCurrency: 'USD', costMethod: 'average' }
  }, 'USD', {
    period: 'CUSTOM',
    start: pastEnd - 86400000,
    end: pastEnd
  }, null, {
    value: 9876.54,
    prices: { BTC: 65000 }
  });
  assert.notEqual(pastHistory.points[pastHistory.points.length - 1].value, 9876.54,
    'past chart endpoints remain based on historical market data');

  console.log('live price fallback checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
