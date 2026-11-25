'use strict';
// Live price sources: CoinGecko, exchange fallbacks (Kraken, Coinbase,
// Binance), stocks (CNBC, Yahoo, tokenized xStocks) and commodities (Gold API,
// Stooq), plus the shared fetch-with-timeout helpers.

// Live metals via gold-api.com (free, no key, CORS-open): XAU/XAG/XPT/XPD
// spot per troy ounce + HG copper, quoted in USD. COPPER is an alias for
// HG. Energy (WTI/BRENT/NG) rides Yahoo front-month futures via
// YAHOO_COMMODITY_MAP below, with Stooq as the last resort.
var GOLD_API_METALS = ['XAU', 'XAG', 'XPT', 'XPD', 'HG'];
function goldApiSymbol(sym) {
  var s = String(sym || '').trim().toUpperCase();
  if (s === 'COPPER') return 'HG';
  if (GOLD_API_METALS.indexOf(s) !== -1) return s;
  return null;
}

// USD spot from gold-api.com. Resolves a positive number or null — never
// throws, never caches (the caller bridges + caches into the display fiat).
function fetchGoldApiUsd(sym, fetchImpl) {
  var s = goldApiSymbol(sym);
  if (!s) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var url = 'https://api.gold-api.com/price/' + encodeURIComponent(s);
  try {
    return fetchWithTimeout(f, url, 7000).then(function (res) {
      if (!res || !res.ok) throw new Error('goldapi-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      var p = data ? Number(data.price) : NaN;
      if (isFinite(p) && p > 0) return p;
      return null;
    }).then(null, function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

// Independent, keyless XAU spot fallback. xaus.com documents an open-CORS
// JSON endpoint and exposes the spot price as spot_usd_oz (also xau.price).
// Only a positive, explicit USD quote is accepted; no synthetic estimate.
function fetchXausSpotUsd(fetchImpl) {
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  return fetchWithTimeout(f, 'https://xaus.com/api/v1/spot', 7000).then(function (res) {
    if (!res || !res.ok) throw new Error('xaus-http-' + (res && res.status));
    return res.json();
  }).then(function (data) {
    var stateData = data && data.data_state;
    var state = stateData && String(stateData.status || '').toLowerCase();
    // XAUS may serve its last observed real quote during an upstream outage.
    // Accept it only when its explicit age is at most five minutes; never
    // turn an unbounded stale snapshot into a live price.
    if (state === 'unavailable') return null;
    if (state === 'stale') {
      var age = Number(stateData.age_seconds);
      if (!isFinite(age) && stateData.as_of) age = (Date.now() - Date.parse(stateData.as_of)) / 1000;
      if (!isFinite(age) || age < 0 || age > 300) return null;
    }
    if (state && state !== 'fresh' && state !== 'stale') return null;
    var p = Number(data && data.spot_usd_oz);
    if (!(isFinite(p) && p > 0)) p = Number(data && data.xau && data.xau.price);
    return (isFinite(p) && p > 0) ? p : null;
  }).then(null, function () { return null; });
}

// Energy futures via Yahoo (same proxy chain as stocks): WTI/Brent/gas
// have no key-free spot API; front-month futures track them closely.
// Units stay native (USD per barrel), converted via ECB like everything else.
var YAHOO_COMMODITY_MAP = {
  WTI: 'CL=F',
  USOIL: 'CL=F',
  OIL: 'CL=F',
  BRENT: 'BZ=F',
  UKOIL: 'BZ=F',
  BRENTOIL: 'BZ=F',
  NG: 'NG=F',
  NATGAS: 'NG=F'
};

// Yahoo daily history for any Yahoo code (stocks, futures): one 12-day
// window ending the day after wantDay; the newest candle at or before
// wantDay wins (walked back = interpolated). Resolves
// {price, interpolated, day} or rejects — the caller picks the fallback.
function fetchYahooHistory(yahooSym, wantDay, cur, fetchImpl) {
  var endSec = Math.floor(Date.UTC(Number(wantDay.slice(0, 4)), Number(wantDay.slice(5, 7)) - 1, Number(wantDay.slice(8, 10))) / 1000) + 86400;
  if (!isFinite(endSec) || endSec <= 0) return Promise.reject(new Error('no-window'));
  var startSec = endSec - 12 * 86400;
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.reject(new Error('no-fetch'));
  return fetchFirstJson(yahooProxyUrls(yahooSym, 'period1=' + startSec + '&period2=' + endSec + '&interval=1d'), f).then(function (data) {
    var r = data && data.chart && data.chart.result && data.chart.result[0];
    if (!r) throw new Error('no-quotes');
    var unitInfo = normalizeQuoteUnit((r.meta && r.meta.currency) || 'USD', 1);
    var nat = unitInfo.currency;
    var candles = parseYahooDaily(data).filter(function (c) { return c.day <= wantDay; });
    if (!candles.length) throw new Error('no-fixing');
    var pick = candles[candles.length - 1];
    var back = (pick.day !== wantDay);
    var closeMain = pick.close / unitInfo.divisor;
    if (nat === cur) return { price: closeMain, interpolated: back, day: pick.day };
    return fetchEcbRate(pick.day, nat, cur).then(function (fx) {
      var v = closeMain * Number(fx.rate);
      if (!isFinite(v) || v <= 0) throw new Error('fx-bridge');
      return { price: v, interpolated: back || !!fx.interpolated, day: pick.day };
    });
  });
}

var PRICE_CACHE_TTL_MS = 60000;
var priceCache = {}; // key "SYM:VS" (uppercased) -> {price, at}

// The price held by a cache entry, or null when the entry is missing or
// holds no usable (finite, positive) price.
function cachedPriceOf(entry) {
  var p = entry ? Number(entry.price) : NaN;
  return isFinite(p) && p > 0 ? p : null;
}

function priceCacheKey(symbol, vs) {
  return String(symbol).toUpperCase() + ':' + String(vs).toUpperCase();
}

function stooqSymbol(sym) {
  var s = String(sym || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,12}$/.test(s)) return null;
  return s.toLowerCase() + '.us';
}

function parseStooqClose(csv) {
  try {
    var lines = String(csv || '').trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    var header = lines[0].split(',');
    var row = lines[1].split(',');
    var ci = header.indexOf('Close');
    if (ci === -1) ci = 6;
    var v = Number(row[ci]);
    if (!isFinite(v) || v <= 0) return null;
    return v;
  } catch (e) { return null; }
}

// Stocks via Yahoo Finance chart API, fetched through the allorigins proxy
// (Yahoo blocks browser CORS directly; the proxy is a dumb pipe for public
// quotes — no user data ever leaves the browser). Stooq's q/l quote
// endpoint currently answers 404, so Yahoo is primary and Stooq is kept as
// the fallback below.
function yahooSymbol(sym) {
  var s = String(sym || '').trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(s)) return null;
  if (/^(XAU|XAG|XPT|XPD)$/.test(s)) return null; // metals belong to gold-api
  return s;
}

// Both CORS proxies for the Yahoo chart URL, in order: allorigins first,
// codetabs second (some networks/adblockers kill one but not the other).
function yahooProxyUrls(sym, query) {
  var base = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(sym) + '?' + query;
  return ['https://api.allorigins.win/raw?url=' + encodeURIComponent(base),
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(base),
    'https://corsproxy.io/?url=' + encodeURIComponent(base)];
}

// Crypto live fallbacks when CoinGecko is rate-limited: Kraken, Coinbase,
// then Binance's public USD/USDT/USDC spot tickers. The caller bridges USD
// prices into the display fiat. Never throw; misses stay unknown.
function fetchKrakenLiveUsd(sym, fetchImpl) {
  var s = String(sym || '').trim().toUpperCase();
  if (KRAKEN_LIVE_SYMBOLS.indexOf(s) === -1) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var url = 'https://api.kraken.com/0/public/Ticker?pair=' + encodeURIComponent(s + 'USD');
  try {
    return fetchWithTimeout(f, url).then(function (res) {
      if (!res || !res.ok) throw new Error('kraken-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      var result = data && data.result;
      if (!result || typeof result !== 'object') return null;
      var keys = Object.keys(result);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === 'last') continue;
        var c = result[keys[i]] && result[keys[i]].c;
        var p = (c && c.length) ? Number(c[0]) : NaN;
        if (isFinite(p) && p > 0) return p;
      }
      return null;
    }).then(null, function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

function fetchKrakenPairUsd(pair, fetchImpl) {
  var market = String(pair || '').trim();
  if (!/^[A-Za-z0-9]{4,24}$/.test(market)) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var url = 'https://api.kraken.com/0/public/Ticker?pair=' + encodeURIComponent(market);
  try {
    return fetchWithTimeout(f, url, 7000).then(function (res) {
      if (!res || !res.ok) throw new Error('kraken-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      if (data && Array.isArray(data.error) && data.error.length) return null;
      var result = data && data.result;
      if (!result || typeof result !== 'object') return null;
      var keys = Object.keys(result);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === 'last') continue;
        var trade = result[keys[i]] && result[keys[i]].c;
        var price = trade && trade.length ? Number(trade[0]) : NaN;
        if (isFinite(price) && price > 0) return price;
      }
      return null;
    }).then(null, function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

function fetchCoinbaseLiveUsd(sym, fetchImpl) {
  var s = String(sym || '').trim().toUpperCase();
  if (COINBASE_LIVE_SYMBOLS.indexOf(s) === -1) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var url = 'https://api.exchange.coinbase.com/products/' + encodeURIComponent(s + '-USD') + '/ticker';
  try {
    return fetchWithTimeout(f, url).then(function (res) {
      if (!res || !res.ok) throw new Error('coinbase-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      var p = data ? Number(data.price) : NaN;
      if (isFinite(p) && p > 0) return p;
      return null;
    }).then(null, function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

// Binance's ticker list is keyed by bare ticker, so a symbol is only trusted
// when its Binance market is the same asset as the CoinGecko id in SYMBOL_MAP.
// Tickers that were renamed, migrated, wrapped or delisted (MATIC, FTM, EOS,
// XMR, MKR, WBTC, WSTETH, DAI, LRC, ...) are left out on purpose: a stale or
// reused pair must read as unknown, never as another asset's price. A symbol
// missing here simply falls through to the manual-override path.
var BINANCE_LIVE_SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT',
  'LTC', 'BCH', 'XLM', 'ATOM', 'UNI', 'TRX', 'NEAR', 'ARB', 'OP', 'USDC',
  'USDT', 'POL', 'APT', 'INJ', 'SUI', 'SEI', 'TIA', 'PEPE', 'SHIB', 'TON',
  'ICP', 'FIL', 'ETC', 'HBAR', 'VET', 'RENDER', 'FET', 'AAVE', 'CRV', 'LDO',
  'SAND', 'MANA', 'AXS', 'CHZ', 'ENJ', 'BAT', 'ZEC', 'DASH', 'XTZ', 'KSM',
  'ALGO', 'THETA', 'GRT', 'QNT', 'EGLD', 'FLOW', 'GALA', 'APE', 'ENS', 'IMX',
  'COMP', 'SNX', 'YFI', 'SUSHI', 'RUNE', 'WIF', 'BONK', 'FLOKI', 'PENDLE',
  'ENA', 'STRK', 'JUP', 'PYTH', 'ONDO', 'TAO', 'W', 'ZK'
];
var binanceLiveTickerPromise = null;
var binanceLiveTickerFetchedAt = 0;
function fetchBinanceLiveUsd(sym, fetchImpl) {
  var s = String(sym || '').trim().toUpperCase();
  if (BINANCE_LIVE_SYMBOLS.indexOf(s) === -1) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var now = Date.now();
  if (!binanceLiveTickerPromise || now - binanceLiveTickerFetchedAt >= 60000) {
    binanceLiveTickerFetchedAt = now;
    var request = fetchWithTimeout(f, 'https://api.binance.com/api/v3/ticker/price').then(function (res) {
      if (!res || !res.ok) throw new Error('binance-http-' + (res && res.status));
      return res.json();
    }).then(function (rows) {
      if (!Array.isArray(rows)) throw new Error('binance-invalid-ticker-response');
      var prices = Object.create(null);
      rows.forEach(function (row) {
        var pair = String(row && row.symbol || '').toUpperCase();
        var price = Number(row && row.price);
        if (!/^[A-Z0-9]+(?:USD|USDT|USDC)$/.test(pair) || !isFinite(price) || price <= 0) return;
        prices[pair] = price;
      });
      return prices;
    });
    var cachedRequest = request.then(function (prices) {
      if (binanceLiveTickerPromise === cachedRequest) binanceLiveTickerFetchedAt = Date.now();
      return prices;
    }, function (error) {
      if (binanceLiveTickerPromise === cachedRequest) {
        binanceLiveTickerPromise = null;
        binanceLiveTickerFetchedAt = 0;
      }
      throw error;
    });
    binanceLiveTickerPromise = cachedRequest;
  }
  return binanceLiveTickerPromise.then(function (prices) {
    var price = Number(prices[s + 'USD']);
    // USDT/USDC quote pairs are treated at USD parity, as in the archive.
    if (!isFinite(price) || price <= 0) price = Number(prices[s + 'USDT']);
    if (s === 'USDT' && (!isFinite(price) || price <= 0)) price = Number(prices.USDTUSDC);
    return isFinite(price) && price > 0 ? price : null;
  }, function () { return null; });
}

function fetchCryptoFallbackUsd(sym, fetchImpl) {
  // Kraken and Coinbase are small per-symbol requests, so they race in
  // parallel (Kraken wins ties). Binance returns its whole public ticker list
  // and is the most region-blocked venue, so it is only asked when neither of
  // the others produced a price.
  return Promise.all([
    fetchKrakenLiveUsd(sym, fetchImpl),
    fetchCoinbaseLiveUsd(sym, fetchImpl)
  ]).then(function (prices) {
    for (var i = 0; i < prices.length; i++) {
      var price = Number(prices[i]);
      if (isFinite(price) && price > 0) return price;
    }
    return fetchBinanceLiveUsd(sym, fetchImpl);
  }).then(function (price) {
    var p = Number(price);
    if (isFinite(p) && p > 0) return p;
    if (stableToUsd(sym)) return 1.0;
    return null;
  });
}

function fetchCryptoFallbackPrice(sym, currency, fetchImpl) {
  var cur = String(currency || 'USD').toUpperCase();
  return fetchCryptoFallbackUsd(sym, fetchImpl).then(function (usd) {
    usd = Number(usd);
    if (!isFinite(usd) || usd <= 0) return null;
    if (cur === 'USD') return usd;
    return fetchSpotFxRate(todayStr(), 'USD', cur).then(function (rate) {
      var converted = usd * Number(rate.rate);
      return isFinite(converted) && converted > 0 ? converted : null;
    }, function () { return null; });
  });
}

// Symbols whose CoinGecko quote has been seen to disagree with the market.
// For these, a live exchange quote (when one answers) replaces the CoinGecko
// quote; CoinGecko is still used when every exchange is unreachable.
var EXCHANGE_PREFERRED_SYMBOLS = ['XMR'];
function prefersExchangePrice(sym) {
  return EXCHANGE_PREFERRED_SYMBOLS.indexOf(String(sym || '').trim().toUpperCase()) !== -1;
}

// First URL that answers ok + parses as JSON; rejects when all fail.
// Each attempt fails fast (12s race) so one hanging proxy cannot stick the
// UI on "loading" for minutes. Never throws synchronously.
function fetchWithTimeout(fetchImpl, url, ms) {
  var timeoutMs = (isFinite(Number(ms)) && Number(ms) > 0) ? Number(ms) : 12000;
  var timer = null;
  var timeoutP = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('proxy-timeout')); }, timeoutMs);
    if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch (e) { /* ignore */ } }
  });
  var attempt;
  try {
    attempt = fetchImpl(url);
  } catch (e) {
    if (timer) { try { clearTimeout(timer); } catch (e2) { /* ignore */ } }
    return Promise.reject(e);
  }
  if (!attempt || typeof attempt.then !== 'function') {
    if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } }
    return Promise.reject(new Error('no-promise'));
  }
  return Promise.race([attempt, timeoutP]).then(function (res) {
    if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } }
    return res;
  }, function (e) {
    if (timer) { try { clearTimeout(timer); } catch (e2) { /* ignore */ } }
    throw e;
  });
}

function fetchFirstJson(urls, fetchImpl, timeoutMs) {
  function next(i) {
    if (i >= urls.length) return Promise.reject(new Error('no-source'));
    return fetchWithTimeout(fetchImpl, urls[i], timeoutMs).then(function (res) {
      if (!res || !res.ok) throw new Error('proxy-http-' + (res && res.status));
      return res.json();
    }).then(null, function () { return next(i + 1); });
  }
  return next(0);
}

// Quote currencies that providers report in a minor unit (1/100 of the main
// unit): London pence ("GBp" / "GBX"), Johannesburg cents ("ZAc" / "ZAC") and
// Israeli agorot ("ILA"). The lookup is case-sensitive on purpose: "GBp" is
// pence while "GBP" is pounds, so upper-casing first would silently turn
// pence into pounds (a 100x overstated price). Returns the price in the main
// unit, the upper-case ISO currency and the divisor that was applied, so
// callers with a series of prices can apply the same divisor to every point.
var MINOR_UNIT_QUOTES = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ZAC: 'ZAR', ILA: 'ILS' };
function normalizeQuoteUnit(rawCurrency, price) {
  var raw = String(rawCurrency == null ? '' : rawCurrency).trim();
  if (Object.prototype.hasOwnProperty.call(MINOR_UNIT_QUOTES, raw)) {
    return { price: Number(price) / 100, currency: MINOR_UNIT_QUOTES[raw], divisor: 100 };
  }
  return { price: Number(price), currency: (raw || 'USD').toUpperCase(), divisor: 1 };
}

// Latest quote from a Yahoo chart payload: regularMarketPrice first, else
// the newest non-null daily close. Returns {price, currency} or null.
function parseYahooQuote(data) {
  try {
    var r = data && data.chart && data.chart.result && data.chart.result[0];
    if (!r) return null;
    var rawCur = (r.meta && r.meta.currency) || 'USD';
    var px = r.meta ? Number(r.meta.regularMarketPrice) : NaN;
    var u;
    if (isFinite(px) && px > 0) {
      u = normalizeQuoteUnit(rawCur, px);
      return { price: u.price, currency: u.currency };
    }
    var q = r.indicators && r.indicators.quote && r.indicators.quote[0];
    var cl = (q && q.close) || [];
    for (var i = cl.length - 1; i >= 0; i--) {
      var c = Number(cl[i]);
      if (isFinite(c) && c > 0) {
        u = normalizeQuoteUnit(rawCur, c);
        return { price: u.price, currency: u.currency };
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Daily closes from a Yahoo chart payload: [{day:'YYYY-MM-DD', close}]
// in UTC date (US session hours never cross UTC midnight, so the trading
// date and UTC date coincide for .us listings).
function parseYahooDaily(data) {
  var out = [];
  try {
    var r = data && data.chart && data.chart.result && data.chart.result[0];
    if (!r) return out;
    var ts = r.timestamp || [];
    var q = r.indicators && r.indicators.quote && r.indicators.quote[0];
    var cl = (q && q.close) || [];
    for (var i = 0; i < ts.length; i++) {
      var c = Number(cl[i]);
      if (!isFinite(c) || c <= 0) continue;
      var d = new Date(Number(ts[i]) * 1000);
      if (!isFinite(d.getTime())) continue;
      out.push({ day: d.toISOString().slice(0, 10), close: c });
    }
  } catch (e) { /* fall through */ }
  return out;
}

// Stocks via CNBC (direct, CORS `*`, no proxy): one batched quote call for
// any number of tickers. Each code-0 quote yields {price, currency} keyed
// by uppercased symbol. Never rejects: misses are simply absent.
var CNBC_QUOTE_URL = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
function parseCnbcQuotes(data) {
  var map = {};
  try {
    var list = data && data.FormattedQuoteResult && data.FormattedQuoteResult.FormattedQuote;
    if (!Array.isArray(list)) return map;
    list.forEach(function (q) {
      if (!q || Number(q.code) !== 0) return;
      var s = String(q.symbol || '').toUpperCase();
      var p = Number(q.last);
      if (!s || !isFinite(p) || p <= 0) return;
      var unit = normalizeQuoteUnit(q.currencyCode || 'USD', p);
      map[s] = { price: unit.price, currency: unit.currency };
    });
  } catch (e) { /* fall through */ }
  return map;
}

function fetchBatchCnbc(syms, fetchImpl) {
  var list = [];
  (syms || []).forEach(function (s) {
    var t = String(s || '').trim().toUpperCase();
    if (t && /^[A-Z0-9.-]{1,12}$/.test(t) && list.indexOf(t) === -1) list.push(t);
  });
  if (!list.length) return Promise.resolve({});
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve({});
  var url = CNBC_QUOTE_URL + '?symbols=' +
    list.map(function (t) { return encodeURIComponent(t); }).join('|') +
    '&requestMethod=quick&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
  try {
    return fetchWithTimeout(f, url).then(function (res) {
      if (!res || !res.ok) throw new Error('cnbc-http-' + (res && res.status));
      return res.json();
    }).then(function (data) {
      return parseCnbcQuotes(data);
    }).then(null, function () { return {}; });
  } catch (e) { return Promise.resolve({}); }
}

// Native-currency stock quote into the display fiat (1:1 when equal),
// cached under STOCK:sym:cur. Stale cache wins over null on any failure.
function convertStockQuote(sym, price, native, cur) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(cur || 'EUR').toUpperCase();
  var key = priceCacheKey('STOCK:' + s, c);
  var cached = null;
  try { cached = priceCache[key] || null; } catch (e) { cached = null; }
  function cachedOrNull() {
    return cachedPriceOf(cached);
  }
  var p = Number(price);
  var nat = String(native || 'USD').toUpperCase();
  if (!isFinite(p) || p <= 0) return Promise.resolve(cachedOrNull());
  if (nat === c) {
    priceCache[key] = { price: p, at: Date.now() };
    return Promise.resolve(p);
  }
  return fetchSpotFxRate(todayStr(), nat, c).then(function (r) {
    var v = p * Number(r.rate);
    if (!isFinite(v) || v <= 0) return cachedOrNull();
    priceCache[key] = { price: v, at: Date.now() };
    return v;
  }, function () { return cachedOrNull(); });
}

function fetchStockCnbc(sym, cur, fetchImpl) {
  return fetchBatchCnbc([sym], fetchImpl).then(function (map) {
    var q = map && map[String(sym || '').toUpperCase()];
    if (!q) return null;
    return convertStockQuote(sym, q.price, q.currency, cur);
  });
}

function fetchStockYahoo(sym, cur, fetchImpl) {
  // Yahoo chart via proxies, Stooq below. Resolves cached-or-null (never
  // rejects) when every source misses.
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  function stooq() {
    var sq = stooqSymbol(sym);
    if (!sq || !f) return Promise.resolve(null);
    var url = 'https://stooq.com/q/l/?s=' + encodeURIComponent(sq) + '&f=sd2t2ohlcv&h&e=csv';
    return fetchWithTimeout(f, url, 7000).then(function (res) {
      if (!res || !res.ok) throw new Error('price-http-' + (res && res.status));
      return res.text();
    }).then(function (csv) {
      return convertStockQuote(sym, parseStooqClose(csv), 'USD', cur);
    }).then(null, function () { return null; });
  }
  if (!f) return Promise.resolve(null);
  var yq = yahooSymbol(sym);
  if (!yq) return stooq();
  return fetchFirstJson(yahooProxyUrls(yq, 'interval=1d&range=5d'), f, 7000).then(function (data) {
    var q = parseYahooQuote(data);
    if (!q) throw new Error('no-quote');
    return convertStockQuote(sym, q.price, q.currency, cur);
  }).then(null, function () { return stooq(); });
}

var KRAKEN_XSTOCK_PAIRS = {
  SPCX: 'SPCXxUSD',
  AAPL: 'AAPLxUSD',
  CRCL: 'CRCLxUSD',
  GLD: 'GLDxUSD',
  GOOGL: 'GOOGLxUSD',
  HOOD: 'HOODxUSD',
  MSTR: 'MSTRxUSD',
  NVDA: 'NVDAxUSD',
  QQQ: 'QQQxUSD',
  SPY: 'SPYxUSD',
  TSLA: 'TSLAxUSD'
};

// Backed's asset identifier is the full token symbol, including its trailing
// x. Kraken's market pair adds the USD quote after that identifier.
var BACKED_XSTOCK_SYMBOLS = {
  SPCX: 'SPCXx', AAPL: 'AAPLx', CRCL: 'CRCLx', GLD: 'GLDx',
  GOOGL: 'GOOGLx', HOOD: 'HOODx', MSTR: 'MSTRx', NVDA: 'NVDAx',
  QQQ: 'QQQx', SPY: 'SPYx', TSLA: 'TSLAx'
};

function fetchBackedXstockUsd(sym, fetchImpl) {
  var s = String(sym || '').trim().toUpperCase();
  var xstock = BACKED_XSTOCK_SYMBOLS[s];
  if (!xstock) return Promise.resolve(null);
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.resolve(null);
  var url = 'https://api.backed.fi/api/v2/public/assets/' + encodeURIComponent(xstock) + '/price-data';
  return fetchWithTimeout(f, url, 7000).then(function (res) {
    if (!res || !res.ok) throw new Error('backed-http-' + (res && res.status));
    return res.json();
  }).then(function (data) {
    var candidates = [
      data && data.price,
      data && data.priceUsd,
      data && data.price_usd,
      data && data.data && data.data.price,
      data && data.data && data.data.priceUsd,
      data && data.priceData && data.priceData.price,
      data && data.result && data.result.price
    ];
    var currency = String((data && (data.currency || data.quoteCurrency || data.quote_currency)) ||
      (data && data.data && (data.data.currency || data.data.quoteCurrency)) || 'USD').toUpperCase();
    if (currency !== 'USD') return null;
    for (var i = 0; i < candidates.length; i++) {
      var raw = candidates[i];
      if (raw && typeof raw === 'object') raw = raw.value || raw.amount;
      var price = Number(raw);
      if (isFinite(price) && price > 0) return price;
    }
    return null;
  }).then(null, function () { return null; });
}

function fetchStockExchangeUsd(sym, fetchImpl) {
  var s = String(sym || '').trim().toUpperCase();
  var pair = KRAKEN_XSTOCK_PAIRS[s];
  if (!pair) return Promise.resolve(null);
  // Backed publishes the official xStocks reference price. Kraken's public
  // ticker is the independent exchange-market fallback when that feed misses.
  return fetchBackedXstockUsd(s, fetchImpl).then(function (price) {
    if (isFinite(Number(price)) && Number(price) > 0) return Number(price);
    return fetchKrakenPairUsd(pair, fetchImpl);
  });
}

function fetchStockPrice(symbol, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = priceDefaultVs(vs);
  cur = String(cur).trim().toUpperCase();
  if (MAIN_CURRENCIES.indexOf(cur) === -1) cur = 'EUR';
  var key = priceCacheKey('STOCK:' + sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  function cachedOrNull() {
    return cachedPriceOf(cached);
  }
  if (cached && (now - cached.at) < PRICE_CACHE_TTL_MS && isFinite(Number(cached.price)) && Number(cached.price) > 0) {
    return Promise.resolve(Number(cached.price));
  }
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(cachedOrNull());
  // Independent xStocks market data first; legacy direct/proxied sources are
  // retained only as fallbacks for equities not covered by the xStocks list.
  return fetchStockExchangeUsd(sym, capturedFetch).then(function (usd) {
    if (isFinite(Number(usd)) && Number(usd) > 0) return convertStockQuote(sym, usd, 'USD', cur);
    return fetchStockCnbc(sym, cur, capturedFetch);
  }).then(function (price) {
    if (isFinite(Number(price)) && Number(price) > 0) return Number(price);
    return fetchStockYahoo(sym, cur, capturedFetch);
  }).then(function (price) {
    if (isFinite(Number(price)) && Number(price) > 0) return Number(price);
    return cachedOrNull();
  }, function () { return cachedOrNull(); });
}

function fetchCommodityPrice(symbol, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = priceDefaultVs(vs);
  cur = String(cur).trim().toUpperCase();
  if (MAIN_CURRENCIES.indexOf(cur) === -1) cur = 'EUR';
  var key = priceCacheKey('COMMODITY:' + sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  if (cached && (now - cached.at) < PRICE_CACHE_TTL_MS && isFinite(Number(cached.price)) && Number(cached.price) > 0) {
    return Promise.resolve(Number(cached.price));
  }
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) {
    if (cachedPriceOf(cached) !== null) return Promise.resolve(Number(cached.price));
    return Promise.resolve(null);
  }
  function cachedOrNull() {
    return cachedPriceOf(cached);
  }
  // Shared native->display-fiat bridge (same ECB source the stock path uses).
  function bridged(amount, native) {
    var p = Number(amount);
    var nat = String(native || 'USD').toUpperCase();
    if (!isFinite(p) || p <= 0) return Promise.resolve(cachedOrNull());
    if (nat === cur) {
      priceCache[key] = { price: p, at: Date.now() };
      return Promise.resolve(p);
    }
    return fetchSpotFxRate(todayStr(), nat, cur).then(function (r) {
      var v = p * Number(r.rate);
      if (!isFinite(v) || v <= 0) return cachedOrNull();
      priceCache[key] = { price: v, at: Date.now() };
      return v;
    }, function () { return cachedOrNull(); });
  }
  // Legacy Stooq quote (kept as the last resort — the q/l endpoint
  // currently answers 404, so a miss here resolves null and the row keeps
  // its honest "feed unreachable" error + override fallback).
  function viaStooq() {
    var sq = stooqCommoditySymbol(sym);
    if (!sq) return Promise.resolve(cachedOrNull());
    var url = 'https://stooq.com/q/l/?s=' + encodeURIComponent(sq) + '&f=sd2t2ohlcv&h&e=csv';
    return fetchWithTimeout(capturedFetch, url, 7000).then(function (res) {
      if (!res.ok) throw new Error('price-http-' + res.status);
      return res.text();
    }).then(function (csv) {
      return bridged(parseStooqClose(csv), 'USD');
    }).then(null, function () { return cachedOrNull(); });
  }
  // Energy futures via Yahoo (same proxy chain as stocks).
  function viaEnergy(ySym) {
    return fetchFirstJson(yahooProxyUrls(ySym, 'interval=1d&range=5d'), capturedFetch, 7000).then(function (data) {
      var q = parseYahooQuote(data);
      if (!q) throw new Error('no-quote');
      return bridged(q.price, q.currency);
    }).then(null, function () { return viaStooq(); });
  }
  // Metals: try two independent keyless spot providers, then Yahoo's
  // XAUUSD chart endpoint. Stooq's legacy quote endpoint is known to return
  // 404, so it is deliberately not treated as a meaningful metals fallback.
  function viaYahooMetal() {
    return fetchFirstJson(yahooProxyUrls('XAUUSD=X', 'interval=1d&range=5d'), capturedFetch, 7000).then(function (data) {
      var q = parseYahooQuote(data);
      if (!q) throw new Error('no-metal-quote');
      return bridged(q.price, q.currency || 'USD');
    }).then(null, function () { return cachedOrNull(); });
  }
  if (sym === 'XAU') {
    // XAUS is a documented, open-CORS spot feed with an explicit freshness
    // contract. Prefer actual spot over token-market proxies; only fall back
    // to PAXG/XAUT exchange prices and Gold-API when the spot feed misses.
    return fetchXausSpotUsd(capturedFetch).then(function (spotUsd) {
      if (isFinite(Number(spotUsd)) && Number(spotUsd) > 0) return bridged(spotUsd, 'USD');
      return Promise.all([
        fetchKrakenPairUsd('PAXGUSD', capturedFetch),
        fetchKrakenPairUsd('XAUTUSD', capturedFetch),
        fetchGoldApiUsd('XAU', capturedFetch)
      ]).then(function (prices) {
        for (var i = 0; i < prices.length; i++) {
          var usd = Number(prices[i]);
          if (isFinite(usd) && usd > 0) return bridged(usd, 'USD');
        }
        return viaYahooMetal();
      });
    }).then(null, function () {
      return Promise.all([
        fetchKrakenPairUsd('PAXGUSD', capturedFetch),
        fetchKrakenPairUsd('XAUTUSD', capturedFetch),
        fetchGoldApiUsd('XAU', capturedFetch)
      ]).then(function (prices) {
        for (var i = 0; i < prices.length; i++) {
          var usd = Number(prices[i]);
          if (isFinite(usd) && usd > 0) return bridged(usd, 'USD');
        }
        return viaYahooMetal();
      });
    });
  }
  // Other precious metals and copper must never use a gold-backed token quote.
  if (goldApiSymbol(sym)) {
    return fetchGoldApiUsd(sym, capturedFetch).then(function (usd) {
      if (isFinite(Number(usd)) && Number(usd) > 0) return bridged(usd, 'USD');
      return viaStooq();
    });
  }
  if (Object.prototype.hasOwnProperty.call(YAHOO_COMMODITY_MAP, sym)) return viaEnergy(YAHOO_COMMODITY_MAP[sym]);
  return viaStooq();
}
