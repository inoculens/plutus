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
    console, setTimeout, clearTimeout, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
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
    if (url.includes('api.frankfurter.dev/v2/providers/ecb/rate/usd/eur?date=')) {
      const requestedDate = decodeURIComponent(url.split('date=')[1].split('&')[0]);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ date: requestedDate, base: 'USD', quote: 'EUR', rate: 0.9 })
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

  assert.equal(mismatchedXmr.prefersExchangePrice('xmr'), true);
  assert.equal(mismatchedXmr.prefersExchangePrice('BTC'), false,
    'only listed symbols let an exchange quote replace CoinGecko');
  mismatchedXmr.EXCHANGE_PREFERRED_SYMBOLS.forEach(symbol => assert(mismatchedXmr.SYMBOL_MAP[symbol],
    symbol + ' must have a verified SYMBOL_MAP entry'));

  const fxContract = createApp(url => {
    assert.match(url, /^https:\/\/api\.frankfurter\.dev\/v2\/providers\/ecb\/rate\/usd\/eur\?date=\d{4}-\d{2}-\d{2}$/,
      'fiat conversion uses the documented Frankfurter v2 ECB rate route');
    const requestedDate = decodeURIComponent(url.split('date=')[1].split('&')[0]);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ date: requestedDate, base: 'USD', quote: 'EUR', rate: 0.9 })
    });
  });
  const fxRate = await fxContract.fetchEcbRate(fxContract.todayStr(), 'USD', 'EUR');
  assert.equal(fxRate.rate, 0.9, 'Frankfurter v2 rate objects are parsed correctly');

  const vpnResilientCrypto = createApp(url => {
    if (url.includes('api.coingecko.com')) return Promise.resolve({ ok: false, status: 429 });
    if (url.includes('api.kraken.com') || url.includes('api.exchange.coinbase.com')) {
      return Promise.resolve({ ok: false, status: 451 });
    }
    if (url === 'https://api.binance.com/api/v3/ticker/price') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ symbol: 'BTCUSD', price: '65000' }])
      });
    }
    if (url.includes('api.frankfurter.dev')) return Promise.resolve({ ok: false, status: 451 });
    if (url === 'https://open.er-api.com/v6/latest/USD') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ result: 'success', base_code: 'USD', rates: { EUR: 0.9 } })
      });
    }
    throw new Error('Unexpected request: ' + url);
  });
  const vpnResilientBatch = await vpnResilientCrypto.refreshAllPrices(
    ['BTC'], 'EUR', { BTC: 'crypto' }
  );
  assert.equal(vpnResilientBatch.BTC, 58500,
    'crypto portfolio prices survive CoinGecko, Kraken, Coinbase and Frankfurter being blocked');
  assert.equal(await vpnResilientCrypto.fetchSpotFxRate(
    vpnResilientCrypto.todayStr(), 'USD', 'EUR'
  ).then(rate => rate.source), 'ExchangeRate-API',
  'the live FX bridge identifies the independent provider that answered');

  const currencyApiFallback = createApp(url => {
    if (url.includes('api.frankfurter.dev') || url.includes('open.er-api.com')) {
      return Promise.resolve({ ok: false, status: 451 });
    }
    if (url === 'https://latest.currency-api.pages.dev/v1/currencies/usd.json') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ usd: { eur: 0.91 } })
      });
    }
    throw new Error('Unexpected request: ' + url);
  });
  const finalFxFallback = await currencyApiFallback.fetchSpotFxRate(
    currencyApiFallback.todayStr(), 'USD', 'EUR'
  );
  assert.equal(finalFxFallback.rate, 0.91,
    'the third independent FX provider is tried when the first two are blocked');
  assert.equal(finalFxFallback.source, 'Currency-API');

  const euroGoldAndStock = createApp(url => {
    if (url.includes('xaus.com/api/v1/spot')) return Promise.resolve({ ok: true, json: () => Promise.resolve({
      spot_usd_oz: 4012.5, data_state: { status: 'fresh', age_seconds: 12 }
    }) });
    if (url.includes('api.backed.fi/api/v2/public/assets/SPCXx/price-data')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: '146.25', currency: 'USD' }) });
    }
    if (url.includes('api.frankfurter.dev/v2/providers/ecb/rate/usd/eur?date=')) {
      const requestedDate = decodeURIComponent(url.split('date=')[1].split('&')[0]);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ date: requestedDate, base: 'USD', quote: 'EUR', rate: 0.9 })
      });
    }
    throw new Error('Unexpected request: ' + url);
  });
  const euroSpotPrices = await euroGoldAndStock.refreshAllPrices(
    ['XAU', 'SPCX'], 'EUR', { XAU: 'commodity', SPCX: 'stock' }
  );
  assert.equal(euroSpotPrices.XAU, 3611.25,
    'XAU USD spot converts into the default EUR display currency');
  assert.equal(euroSpotPrices.SPCX, 131.625,
    'SPCX USD xStock quote converts into the default EUR display currency');

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

  let lazyBinanceRequests = 0;
  const krakenAnswers = createApp(url => {
    if (url.includes('api.coingecko.com')) return Promise.resolve({ ok: false, status: 429 });
    if (url.includes('api.kraken.com')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ result: { XXBTZUSD: { c: ['65100'] } } }) });
    }
    if (url.includes('api.exchange.coinbase.com')) return Promise.resolve({ ok: false, status: 451 });
    if (url.includes('api.binance.com')) lazyBinanceRequests++;
    return Promise.resolve({ ok: false, status: 451 });
  });
  assert.equal((await krakenAnswers.refreshAllPrices(['BTC'], 'USD', { BTC: 'crypto' })).BTC, 65100);
  assert.equal(lazyBinanceRequests, 0, 'Binance is not contacted when Kraken already answered');

  let reusedTickerRequests = 0;
  const reusedTicker = createApp(url => {
    if (url.includes('api.coingecko.com')) return Promise.resolve({ ok: false, status: 429 });
    if (url.includes('api.binance.com')) {
      reusedTickerRequests++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{ symbol: 'MATICUSDT', price: '0.4' }]) });
    }
    return Promise.resolve({ ok: false, status: 451 });
  });
  assert.equal(reusedTicker.BINANCE_LIVE_SYMBOLS.includes('MATIC'), false);
  assert.equal((await reusedTicker.refreshAllPrices(['MATIC'], 'USD', { MATIC: 'crypto' })).MATIC, null,
    'a renamed or migrated ticker is never priced from a same-named Binance pair');
  assert.equal(reusedTickerRequests, 0, 'non-whitelisted tickers do not cost a Binance request');
  const mappedTickers = Object.keys(reusedTicker.SYMBOL_MAP);
  reusedTicker.BINANCE_LIVE_SYMBOLS.forEach(symbol => assert(mappedTickers.includes(symbol),
    symbol + ' must have a verified SYMBOL_MAP entry before it can use a live exchange fallback'));

  // Independent stock and gold pricing: Backed reference -> Kraken xStocks,
  // and Kraken's gold-backed spot markets, with no Yahoo/CNBC proxy required.
  const xausFresh = createApp(url => {
    if (url.includes('xaus.com/api/v1/spot')) return Promise.resolve({ ok: true, json: () => Promise.resolve({
      spot_usd_oz: 4012.5, data_state: { status: 'fresh', age_seconds: 12 }
    }) });
    throw new Error('Unexpected request: ' + url);
  });
  assert.equal(await xausFresh.fetchLivePrice('XAU', 'USD', 'commodity'), 4012.5,
    'XAU prefers the documented XAUS spot feed');

  const xausRecentStale = createApp(url => {
    if (url.includes('xaus.com/api/v1/spot')) return Promise.resolve({ ok: true, json: () => Promise.resolve({
      spot_usd_oz: 4011.25, data_state: { status: 'stale', age_seconds: 120 }
    }) });
    throw new Error('Unexpected request: ' + url);
  });
  assert.equal(await xausRecentStale.fetchLivePrice('XAU', 'USD', 'commodity'), 4011.25,
    'recent explicitly-aged XAUS stale quotes remain usable');

  const xausOldStale = createApp(url => {
    if (url.includes('xaus.com/api/v1/spot')) return Promise.resolve({ ok: true, json: () => Promise.resolve({
      spot_usd_oz: 4011.25, data_state: { status: 'stale', age_seconds: 900 }
    }) });
    if (url.includes('api.kraken.com') || url.includes('api.gold-api.com') ||
        url.includes('api.allorigins.win') || url.includes('api.codetabs.com') || url.includes('corsproxy.io')) {
      return Promise.resolve({ ok: false, status: 451 });
    }
    throw new Error('Unexpected request: ' + url);
  });
  assert.equal(await xausOldStale.fetchLivePrice('XAU', 'USD', 'commodity'), null,
    'old XAUS stale snapshots are never represented as live prices');

  const backedStock = createApp(url => {
    if (url.includes('api.backed.fi/api/v2/public/assets/SPCXx/price-data')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: '146.25', currency: 'USD' }) });
    }
    throw new Error('Unexpected request: ' + url);
  });
  const backedStockBatch = await backedStock.refreshAllPrices(['SPCX'], 'USD', { SPCX: 'stock' });
  assert.equal(backedStockBatch.SPCX, 146.25, 'SPCX batch pricing uses the independent Backed xStocks quote');
  const backedStockSingle = createApp(url => {
    if (url.includes('api.backed.fi/api/v2/public/assets/SPCXx/price-data')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: '146.25', currency: 'USD' }) });
    }
    throw new Error('Unexpected request: ' + url);
  });
  assert.equal(await backedStockSingle.fetchLivePrice('SPCX', 'USD', 'stock'), 146.25,
    'SPCX single-symbol pricing uses the same independent source');

  const krakenStock = createApp(url => {
    if (url.includes('api.backed.fi/')) return Promise.resolve({ ok: false, status: 503 });
    if (url.includes('api.kraken.com/0/public/Ticker?pair=SPCXxUSD')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ error: [], result: { SPCXxUSD: { c: ['145.75'] } } }) });
    }
    throw new Error('Unexpected request: ' + url);
  });
  const krakenStockBatch = await krakenStock.refreshAllPrices(['SPCX'], 'USD', { SPCX: 'stock' });
  assert.equal(krakenStockBatch.SPCX, 145.75, 'SPCX falls back to the direct Kraken xStocks ticker');

  const silverOnly = createApp(url => {
    if (url.includes('api.gold-api.com/price/XAG')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: 51.25 }) });
    }
    throw new Error('Unexpected request: ' + url);
  });
  const silverBatch = await silverOnly.refreshAllPrices(['XAG'], 'USD', { XAG: 'commodity' });
  assert.equal(silverBatch.XAG, 51.25, 'silver continues to use its own spot quote, never PAXG/XAUT');

  const krakenGold = createApp(url => {
    if (url.includes('pair=PAXGUSD')) return Promise.resolve({ ok: false, status: 451 });
    if (url.includes('pair=XAUTUSD')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ error: [], result: { XAUTUSD: { c: ['4021.75'] } } }) });
    }
    throw new Error('Unexpected request: ' + url);
  });
  const goldBatch = await krakenGold.refreshAllPrices(['XAU'], 'USD', { XAU: 'commodity' });
  assert.equal(goldBatch.XAU, 4021.75, 'XAU uses XAUT/USD when PAXG/USD is unavailable');

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

  // Valuation yields to the browser after a time slice, not after every point.
  let yields = 0;
  const realSetTimeout = setTimeout;
  historyApp.setTimeout = function (callback, delay) { yields++; return realSetTimeout(callback, delay); };
  let progressCalls = 0;
  const longHistory = await historyApp.buildNetWorthHistory({
    accounts: [],
    trades: [],
    settings: { mainCurrency: 'USD', costMethod: 'average' }
  }, 'USD', {
    period: '1Y',
    start: historyEnd - 365 * 86400000,
    end: historyEnd
  }, function (progress) { if (progress.phase === 'valuation') progressCalls++; }, null);
  assert(longHistory.points.length >= 365, 'a one-year chart has a point per day');
  for (let i = 1; i < longHistory.points.length; i++) {
    assert(longHistory.points[i].at > longHistory.points[i - 1].at, 'points stay in time order');
  }
  assert(yields < longHistory.points.length / 4,
    'valuation yields per time slice, not per point (' + yields + ' yields for ' + longHistory.points.length + ' points)');
  assert(progressCalls >= 1 && progressCalls < longHistory.points.length / 4,
    'progress is reported per slice and at completion (' + progressCalls + ' calls)');
  historyApp.setTimeout = realSetTimeout;

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

  completed = true;
  console.log('live price fallback checks passed');
  // The app schedules long-lived timers on load; end explicitly once done.
  process.exit(0);
}

// A promise that never settles lets Node exit with code 0 mid-test. Fail
// loudly instead of reporting a false pass.
let completed = false;
process.on('exit', code => {
  if (!completed && code === 0) {
    console.error('live price fallback test exited before completing');
    process.exitCode = 1;
  }
});

main().catch(error => {
  console.error(error);
  process.exit(1);
});
