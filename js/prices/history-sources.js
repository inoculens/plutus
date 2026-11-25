'use strict';
// Historical price sources per asset kind (CoinGecko, public archive, Kraken,
// Stooq, Coinbase, Yahoo) and fetchHistoricalPrice, which picks among them.

function toCoingeckoDate(dateStr) {
  if (!isValidDateStr(dateStr)) return null;
  var p = String(dateStr).slice(0, 10).split('-');
  return p[2] + '-' + p[1] + '-' + p[0]; // DD-MM-YYYY
}

function toStooqDay(dateStr) {
  if (!isValidDateStr(dateStr)) return null;
  return String(dateStr).slice(0, 10).replace(/-/g, '');
}

// Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume) and return the
// Close for `wantDay` (YYYYMMDD), or null when the market was shut.
function parseStooqDaily(csv, wantDay) {
  try {
    var lines = String(csv || '').trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    for (var i = 1; i < lines.length; i++) {
      var row = lines[i].split(',');
      if (!row.length) continue;
      var day = String(row[0] || '').replace(/-/g, '');
      if (day !== wantDay) continue;
      var v = Number(row[4]);
      if (isFinite(v) && v > 0) return v;
      return null;
    }
    return null;
  } catch (e) { return null; }
}

function fetchHistoricalCryptoPrice(symbol, dateStr, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  var curLow = cur.toLowerCase();
  var id = SYMBOL_MAP[sym];
  if (!id || !isValidDateStr(dateStr)) return Promise.resolve(null);
  var gd = toCoingeckoDate(dateStr);
  var url = 'https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(id) +
    '/history?date=' + encodeURIComponent(gd);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  function krakenFallback() { return fetchKrakenHistory(sym, dateStr, cur); }
  function deepFallback() {
    return krakenFallback().then(function (kp) {
      if (isFinite(kp) && kp > 0) { histDiagClear(sym, dateStr.slice(0, 10), cur); return kp; }
      return fetchStooqCryptoHistory(sym, dateStr, cur).then(function (sp) {
        if (isFinite(sp) && sp > 0) return sp;
        return fetchCoinbaseHistory(sym, dateStr, cur);
      });
    });
  }
  var day10 = dateStr.slice(0, 10);
  function coingeckoAndBeyond() {
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }, function () { throw new Error('price-unreachable'); }).then(function (data) {
    var cp = data && data.market_data && data.market_data.current_price;
    var p = cp ? Number(cp[curLow]) : NaN;
    if (isFinite(p) && p > 0) { histDiagClear(sym, day10, cur); return p; }
    // Bridge unsupported vs via the USD pivot + HISTORICAL ECB USD->main.
    if (curLow !== 'usd') {
      var pu = cp ? Number(cp.usd) : NaN;
      if (isFinite(pu) && pu > 0) {
        return fetchEcbRate(dateStr.slice(0, 10), 'USD', cur).then(function (r) {
          var v = pu * Number(r.rate);
          if (isFinite(v) && v > 0) { histDiagClear(sym, day10, cur); return v; }
          return null;
        }, function () { return null; });
      }
    }
    return null;
  }).then(function (p) {
    if (isFinite(p) && p > 0) return p;
    return deepFallback();
  }, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('price-http-') === 0) histDiagNote(sym, day10, cur, 'CoinGecko HTTP ' + msg.slice(11));
    else histDiagNote(sym, day10, cur, 'CoinGecko unreachable');
    return deepFallback();
  });
  }
  // Most reliable source first: Coinbase public candles (no key, generous
  // limits, deep history, CORS-open). The rest of the chain follows on a miss.
  // Second: the public Plutus daily archive (98 assets, USD daily closes
  // built by the market-history workflow). It covers assets the majors-only
  // sources above do not, and goes further back than CoinGecko's free window.
  return fetchCoinbaseHistory(sym, dateStr, cur).then(function (cb) {
    if (isFinite(cb) && cb > 0) return cb;
    return fetchArchiveHistory(sym, dateStr, cur).then(function (ap) {
      if (isFinite(ap) && ap > 0) return ap;
      return coingeckoAndBeyond();
    });
  });
}

// One UTC day's close from the public Plutus archive (the same file the net
// worth history reads, fetched once per session). Exact day only: a missing
// day is null — never interpolated or guessed. Non-USD fiats bridge through
// the historical ECB USD rate, like the other crypto sources.
function fetchArchiveHistory(sym, dateStr, vs) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(vs || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  if (!s || !c || !isValidDateStr(day) || isFutureDateStr(day)) return Promise.resolve(null);
  var dayStart = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  if (!isFinite(dayStart)) return Promise.resolve(null);
  var wantDay = Math.floor(dayStart / 86400000);
  return fetchPlutusDailyCryptoSeries(s, dayStart, dayStart).then(function (series) {
    var pts = (series && Array.isArray(series.points)) ? series.points : [];
    var usd = NaN;
    for (var i = 0; i < pts.length; i++) {
      if (Math.floor(Number(pts[i].at) / 86400000) === wantDay) { usd = Number(pts[i].price); break; }
    }
    if (!(isFinite(usd) && usd > 0)) {
      histDiagNote(s, day, c, 'Plutus archive: no price for date');
      return null;
    }
    if (c === 'USD') { histDiagClear(s, day, c); return usd; }
    return fetchEcbRate(day, 'USD', c).then(function (r) {
      var v = usd * Number(r.rate);
      if (isFinite(v) && v > 0) { histDiagClear(s, day, c); return v; }
      return null;
    }, function () { return null; });
  }).then(null, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('has no daily history') !== -1) histDiagNote(s, day, c, 'Plutus archive: asset or date not covered');
    else histDiagNote(s, day, c, 'Plutus archive unreachable');
    return null;
  });
}

// Third source for crypto history when the first two fail or omit the fiat:
// Kraken public OHLC, daily close (no key, CORS-enabled). Majors only;
// USD/EUR direct, other fiats via the USD pivot + historical ECB.
var KRAKEN_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH'];
var KRAKEN_LIVE_SYMBOLS = KRAKEN_SYMBOLS.concat(['XMR', 'AAVE', 'USDC', 'USDT']);
function fetchKrakenHistory(sym, dateStr, vs) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(vs || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  if (KRAKEN_SYMBOLS.indexOf(s) === -1 || !isValidDateStr(day) || isFutureDateStr(day)) {
    if (KRAKEN_SYMBOLS.indexOf(s) === -1) histDiagNote(s, day, c, 'Kraken: asset not covered');
    return Promise.resolve(null);
  }
  var fiat = (c === 'EUR') ? 'EUR' : 'USD';
  var start = Math.floor(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 1000);
  if (!isFinite(start) || start <= 0) return Promise.resolve(null);
  var url = 'https://api.kraken.com/0/public/OHLC?pair=' + encodeURIComponent(s + fiat) +
    '&interval=1440&since=' + Math.max(0, start - 172800);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('kraken-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var err = data && data.error;
    if (err && err.length) throw new Error('kraken-' + err.join(','));
    var result = data && data.result;
    var candles = null;
    if (result && typeof result === 'object') {
      var keys = Object.keys(result);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === 'last') continue;
        if (Array.isArray(result[keys[i]])) { candles = result[keys[i]]; break; }
      }
    }
    if (!candles) return null;
    for (var k = 0; k < candles.length; k++) {
      var cd = candles[k];
      if (!cd || !isFinite(Number(cd[0])) || !isFinite(Number(cd[4]))) continue;
      var tt = Number(cd[0]);
      if (tt >= start && tt < start + 86400 && Number(cd[4]) > 0) {
        var close = Number(cd[4]);
        if (fiat === c) { histDiagClear(s, day, c); return close; }
        return fetchEcbRate(day, 'USD', c).then(function (r) {
          var v = close * Number(r.rate);
          if (isFinite(v) && v > 0) { histDiagClear(s, day, c); return v; }
          return null;
        }, function () { return null; });
      }
    }
    histDiagNote(s, day, c, 'Kraken: no candle for date');
    return null;
  }).then(null, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('kraken-http-') === 0) histDiagNote(s, day, c, 'Kraken HTTP ' + msg.slice(12));
    else histDiagNote(s, day, c, 'Kraken unreachable');
    return null;
  });
}

// Deep-history fallback for dates the other sources can't reach (CoinGecko
// free stops at 365 days, Kraken daily keeps ~720 candles): Stooq daily
// close, BTC/ETH only, always via USD + historical ECB. Same host and
// parser the stock path already uses.
var STOOQ_CRYPTO = { BTC: 'btcusd', ETH: 'ethusd' };
function fetchStooqCryptoHistory(sym, dateStr, vs) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(vs || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  var sq = STOOQ_CRYPTO[s];
  if (!sq || !isValidDateStr(day) || isFutureDateStr(day)) {
    if (!sq) histDiagNote(s, day, c, 'Stooq: asset not covered');
    return Promise.resolve(null);
  }
  var compact = toStooqDay(day);
  var url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sq) +
    '&d1=' + encodeURIComponent(compact) + '&d2=' + encodeURIComponent(compact) + '&i=d';
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('stooq-http-' + res.status);
    return res.text();
  }).then(function (csv) {
    var usd = parseStooqDaily(csv, compact);
    if (!isFinite(usd) || usd <= 0) { histDiagNote(s, day, c, 'Stooq: no quote for date'); return null; }
    if (c === 'USD') { histDiagClear(s, day, c); return usd; }
    return fetchEcbRate(day, 'USD', c).then(function (r) {
      var v = usd * Number(r.rate);
      if (isFinite(v) && v > 0) { histDiagClear(s, day, c); return v; }
      return null;
    }, function () { return null; });
  }).then(null, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('stooq-http-') === 0) histDiagNote(s, day, c, 'Stooq HTTP ' + msg.slice(11));
    else histDiagNote(s, day, c, 'Stooq unreachable');
    return null;
  });
}

// Coinbase Exchange public candles, daily granularity (no key, CORS-enabled).
// Primary history source (tried first): majors with USD/EUR/GBP books;
// other fiats via USD + historical ECB. Majors with USD/EUR/GBP
// books; other fiats via USD + historical ECB.
var COINBASE_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH'];
var COINBASE_LIVE_SYMBOLS = COINBASE_SYMBOLS.concat(['AAVE']);
function fetchCoinbaseHistory(sym, dateStr, vs) {
  var s = String(sym || '').trim().toUpperCase();
  var c = String(vs || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  if (COINBASE_SYMBOLS.indexOf(s) === -1 || !isValidDateStr(day) || isFutureDateStr(day)) {
    if (COINBASE_SYMBOLS.indexOf(s) === -1) histDiagNote(s, day, c, 'Coinbase: asset not covered');
    return Promise.resolve(null);
  }
  var fiat = (c === 'EUR' || c === 'GBP') ? c : 'USD';
  var start = Math.floor(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 1000);
  if (!isFinite(start) || start <= 0) return Promise.resolve(null);
  var url = 'https://api.exchange.coinbase.com/products/' + encodeURIComponent(s + '-' + fiat) +
    '/candles?start=' + encodeURIComponent(day + 'T00:00:00Z') +
    '&end=' + encodeURIComponent(day + 'T23:59:59Z') + '&granularity=86400';
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('coinbase-http-' + res.status);
    return res.json();
  }).then(function (data) {
    // Candle: [time, low, high, open, close, volume].
    var candles = Array.isArray(data) ? data : null;
    if (!candles) return null;
    for (var k = 0; k < candles.length; k++) {
      var cd = candles[k];
      if (!cd || !isFinite(Number(cd[0])) || !isFinite(Number(cd[4]))) continue;
      var tt = Number(cd[0]);
      if (tt >= start && tt < start + 86400 && Number(cd[4]) > 0) {
        var close = Number(cd[4]);
        if (fiat === c) { histDiagClear(s, day, c); return close; }
        return fetchEcbRate(day, 'USD', c).then(function (r) {
          var v = close * Number(r.rate);
          if (isFinite(v) && v > 0) { histDiagClear(s, day, c); return v; }
          return null;
        }, function () { return null; });
      }
    }
    histDiagNote(s, day, c, 'Coinbase: no candle for date');
    return null;
  }).then(null, function (e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf('coinbase-http-') === 0) histDiagNote(s, day, c, 'Coinbase HTTP ' + msg.slice(14));
    else histDiagNote(s, day, c, 'Coinbase unreachable');
    return null;
  });
}

function fetchHistoricalStockPrice(symbol, dateStr, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!isValidDateStr(dateStr)) return Promise.resolve(null);
  var wantDay = dateStr.slice(0, 10);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  function stooqFallback() { return fetchHistoricalStockStooq(sym, wantDay, cur); }
  var yq = yahooSymbol(sym);
  if (!yq) return stooqFallback();
  return fetchYahooHistory(yq, wantDay, cur, capturedFetch).then(function (r) { return r; }, function () { return stooqFallback(); });
}

// Legacy Stooq daily closes with up to 5-day walk-back (kept as the stock
// history fallback; Stooq daily currently sits behind a bot challenge that
// programmatic fetches may not pass).
function fetchHistoricalStockStooq(sym, wantDay, cur) {
  var sq = stooqSymbol(sym);
  if (!sq || !isValidDateStr(wantDay)) return Promise.resolve(null);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  return fetchStooqDailyClose(sq, wantDay, cur, capturedFetch);
}

// One Stooq daily close for `sq` on `wantDay`, in `cur` (USD bridged at the
// ECB fixing of the close's day). Walks back up to 5 days for weekends and
// holidays (same window as FX). Resolves {price, interpolated, day} or null.
function fetchStooqDailyClose(sq, wantDay, cur, fetchFn) {
  function attempt(day, back) {
    var compact = toStooqDay(day);
    var url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sq) +
      '&d1=' + encodeURIComponent(compact) + '&d2=' + encodeURIComponent(compact) + '&i=d';
    return fetchFn(url).then(function (res) {
      if (!res.ok) throw new Error('price-http-' + res.status);
      return res.text();
    }).then(function (csv) {
      var usd = parseStooqDaily(csv, compact);
      if (isFinite(usd) && usd > 0) {
        if (cur === 'USD') return { price: usd, interpolated: back > 0, day: day };
        return fetchEcbRate(day, 'USD', cur).then(function (r) {
          var v = usd * Number(r.rate);
          if (!isFinite(v) || v <= 0) throw new Error('fx-bridge');
          return { price: v, interpolated: back > 0 || !!r.interpolated, day: day };
        });
      }
      if (back >= 5) throw new Error('no-fixing');
      var prev = fxShiftDate(day, -1);
      if (!prev) throw new Error('no-fixing');
      return attempt(prev, back + 1);
    });
  }
  return attempt(wantDay, 0).then(function (r) { return r; }, function () { return null; });
}

function fetchHistoricalCommodityPrice(symbol, dateStr, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!isValidDateStr(dateStr)) return Promise.resolve(null);
  var wantDay = dateStr.slice(0, 10);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  var sq = stooqCommoditySymbol(sym);
  function stooqFallback() {
    if (!sq) return Promise.resolve(null);
    return fetchStooqDailyClose(sq, wantDay, cur, capturedFetch);
  }
  // Energy futures share the Yahoo history window with stocks.
  if (Object.prototype.hasOwnProperty.call(YAHOO_COMMODITY_MAP, sym)) {
    return fetchYahooHistory(YAHOO_COMMODITY_MAP[sym], wantDay, cur, capturedFetch).then(function (r) { return r; }, function () { return stooqFallback(); });
  }
  return stooqFallback();
}

function fetchHistoricalPrice(symbol, dateStr, vs, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!sym || !isValidDateStr(day) || isFutureDateStr(day)) return Promise.resolve(null);
  // (1) Manual override wins — no market network. Legacy bare numbers are
  // denominated in the requested fiat; fiat-tagged overrides convert at the
  // HISTORICAL rate of the trade date (null when unconvertible — never a
  // nominal value in the wrong fiat).
  var ovE = null;
  try { ovE = priceOverrideEntry(sym, kind); } catch (e) { ovE = null; }
  if (ovE !== null) {
    if (!ovE.vs || ovE.vs === cur) return Promise.resolve(ovE.price);
    return fetchEcbRate(day, ovE.vs, cur).then(function (r) {
      var v = ovE.price * Number(r.rate);
      return (isFinite(v) && v > 0) ? v : null;
    }, function () { return null; });
  }
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  if (kd === 'custom' || kd === 'cash') return Promise.resolve(null);
  if (kd === 'stock') return fetchHistoricalStockPrice(sym, day, cur);
  if (kd === 'commodity') return fetchHistoricalCommodityPrice(sym, day, cur);
  if (!SYMBOL_MAP[sym]) {
    if (stableToUsd(sym)) {
      if (cur === 'USD') return Promise.resolve(1.0);
      return fetchEcbRate(day, 'USD', cur).then(function (r) {
        var v = Number(r && r.rate);
        return (isFinite(v) && v > 0) ? v : 1.0;
      }, function () { return 1.0; });
    }
    return Promise.resolve(null);
  }
  return fetchHistoricalCryptoPrice(sym, day, cur).then(function (p) {
    if (isFinite(Number(p)) && Number(p) > 0) return Number(p);
    if (stableToUsd(sym)) {
      if (cur === 'USD') return 1.0;
      return fetchEcbRate(day, 'USD', cur).then(function (r) {
        var v = Number(r && r.rate);
        return (isFinite(v) && v > 0) ? v : 1.0;
      }, function () { return 1.0; });
    }
    return null;
  });
}
