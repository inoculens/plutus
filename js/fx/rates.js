'use strict';
// ECB exchange rates.
// ECB historical FX via the Frankfurter proxy (https://api.frankfurter.dev).
// NOTE: the legacy api.frankfurter.app host 301-redirects cross-origin and
// browsers refuse the fetch, so always use the canonical host below.
// fetchEcbRate(date, from, to) locks the rate at trade date with forward-fill:
// a weekend/holiday gap walks back up to FX_MAX_LOOKBACK_DAYS and returns
// interpolated:true with source:'ECB-'+actualFixingDate. Stablecoins
// (USDC/USDT/DAI) are treated as 1:1 USD, then converted via ECB USD->main.
// Each HTTP attempt is retried once on network failure; if the rate still
// cannot be locked, fetchEcbRate throws Error('fx-unavailable') so the UI
// can ask for a manual rate.

var FX_STABLES = ['USDC', 'USDT', 'DAI'];
var FX_MAX_LOOKBACK_DAYS = 5;
// Frankfurter v2's provider-specific endpoint preserves the ECB fixing source.
var FX_BASE_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rate';

function stableToUsd(ccy) {
  if (typeof ccy !== 'string') return false;
  return FX_STABLES.indexOf(ccy.toUpperCase()) !== -1;
}

function fxShiftDate(dateStr, deltaDays) {
  if (!isValidDateStr(dateStr)) return null;
  var parts = String(dateStr).slice(0, 10).split('-');
  var t = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (!isFinite(t)) return null;
  t += deltaDays * 86400000;
  var d = new Date(t);
  var m = d.getUTCMonth() + 1;
  var day = d.getUTCDate();
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// Pure forward-fill helper: newest fixing at or before `date` within the
// lookback window, or null when no fixing is available (caller throws
// Error('fx-unavailable') in that case).
function pickRate(ratesByDate, date) {
  for (var back = 0; back <= FX_MAX_LOOKBACK_DAYS; back++) {
    var d = fxShiftDate(date, -back);
    if (ratesByDate && Object.prototype.hasOwnProperty.call(ratesByDate, d)) {
      var rate = Number(ratesByDate[d]);
      if (isFinite(rate) && rate > 0) { // a zero or negative fixing is garbage, never a rate
        return { rate: rate, interpolated: back > 0, date: d, source: 'ECB-' + d };
      }
    }
  }
  return null;
}

function fxFetchOnce(url, fetchImpl) {
  var f = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!f) return Promise.reject(new Error('fx-unavailable'));
  var timeoutMs = 10000;
  var timer = null;
  var raced = false;
  function cleanup() { if (timer) { try { clearTimeout(timer); } catch (e) { /* ignore */ } timer = null; } }
  var attempt;
  try {
    attempt = f(url);
  } catch (e) {
    return Promise.reject(new Error('fx-unavailable'));
  }
  if (!attempt || typeof attempt.then !== 'function') return Promise.reject(new Error('fx-unavailable'));
  var timeoutP = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      if (!raced) { raced = true; reject(new Error('fx-unavailable')); }
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch (e) { /* ignore */ } }
  });
  return Promise.race([attempt, timeoutP]).then(function (res) {
    if (raced) throw new Error('fx-unavailable');
    raced = true;
    cleanup();
    if (!res || !res.ok) {
      var err = new Error('fx-http-' + (res && res.status));
      err.fxStatus = res && res.status;
      throw err;
    }
    return res.json();
  }, function (e) {
    cleanup();
    if (e && (e.message === 'fx-unavailable' || e.fxStatus)) throw e;
    var err2 = new Error('fx-unavailable');
    throw err2;
  });
}

function fxFetchWithRetry(url, fetchImpl) {
  return fxFetchOnce(url, fetchImpl).catch(function (e) {
    if (e && e.fxStatus === 404) throw e; // missing fixing: no point retrying the same date
    return fxFetchOnce(url, fetchImpl); // retry once; a second failure propagates to the caller
  });
}

function fetchEcbRate(date, from, to) {
  if (!isValidDateStr(date)) return Promise.reject(new Error('fx-unavailable'));
  if (isFutureDateStr(date)) return Promise.reject(new Error('fx-unavailable'));
  var f = (typeof from === 'string') ? from.trim().toUpperCase() : from;
  var t = (typeof to === 'string') ? to.trim().toUpperCase() : to;
  if (!/^[A-Z]{2,10}$/.test(f || '') || !/^[A-Z]{2,10}$/.test(t || '')) {
    return Promise.reject(new Error('fx-unavailable'));
  }
  var effFrom = stableToUsd(f) ? 'USD' : f; // USDC->USD 1.0, then ECB USD->main
  var effTo = stableToUsd(t) ? 'USD' : t;
  if (effFrom === effTo) {
    return Promise.resolve({ rate: 1, interpolated: false, source: '1:1' });
  }
  // Hermetic async: capture window.fetch once per operation so concurrent
  // Keep each operation's fetch implementation stable across retries.
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  function attempt(d, back) {
    if (!d || !isValidDateStr(d)) return Promise.reject(new Error('fx-unavailable'));
    var url = FX_BASE_URL + '/' + encodeURIComponent(effFrom.toLowerCase()) +
      '/' + encodeURIComponent(effTo.toLowerCase()) + '?date=' + encodeURIComponent(d);
    function walkBack() {
      if (back >= FX_MAX_LOOKBACK_DAYS) throw new Error('fx-unavailable');
      var prev = fxShiftDate(d, -1);
      if (!prev) throw new Error('fx-unavailable');
      return attempt(prev, back + 1);
    }
    return fxFetchWithRetry(url, capturedFetch).then(
      function (data) {
        var rate = data && Number(data.rate);
        var responseBase = data && String(data.base || '').toUpperCase();
        var responseQuote = data && String(data.quote || '').toUpperCase();
        if ((responseBase && responseBase !== effFrom) || (responseQuote && responseQuote !== effTo)) return walkBack();
        if (isFinite(rate) && rate > 0) {
          // Frankfurter answers with the latest available fixing, which may
          // predate the requested date: pin provenance to its actual date.
          // Guard lookahead: never accept a fixing after the requested date.
          var dd = (data && typeof data.date === 'string' && isValidDateStr(data.date)) ? data.date.slice(0, 10) : d;
          if (dd > d) return walkBack();
          return { rate: rate, interpolated: back > 0 || dd !== d, source: 'ECB-' + dd };
        }
        return walkBack(); // 200 but no fixing for this date: previous close
      },
      function (e) {
        if (e && e.fxStatus === 404) return walkBack(); // ECB holiday/weekend gap
        throw new Error('fx-unavailable'); // network failure after retry
      }
    );
  }
  return attempt(date.slice(0, 10), 0);
}

// Current live-price conversions must not depend on the historical ECB archive.
// Try independent public FX services on separate domains; historical accounting
// continues to use fetchEcbRate() and its date-pinned ECB fixings.
function fetchSpotFxRate(date, from, to, fetchImpl) {
  var f = String(from || '').trim().toUpperCase();
  var t = String(to || '').trim().toUpperCase();
  if (!/^[A-Z]{2,10}$/.test(f) || !/^[A-Z]{2,10}$/.test(t)) {
    return Promise.reject(new Error('fx-unavailable'));
  }
  var effFrom = stableToUsd(f) ? 'USD' : f;
  var effTo = stableToUsd(t) ? 'USD' : t;
  if (effFrom === effTo) return Promise.resolve({ rate: 1, source: '1:1' });
  var fetcher = fetchImpl || ((typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null);
  if (!fetcher) return Promise.reject(new Error('fx-unavailable'));
  var day = isValidDateStr(date) && !isFutureDateStr(date) ? date.slice(0, 10) : todayStr();
  var fromLow = effFrom.toLowerCase();
  var toLow = effTo.toLowerCase();
  var sources = [
    {
      url: 'https://api.frankfurter.dev/v2/providers/ecb/rate/' + encodeURIComponent(fromLow) +
        '/' + encodeURIComponent(toLow) + '?date=' + encodeURIComponent(day),
      parse: function (data) {
        var base = String(data && data.base || '').toUpperCase();
        var quote = String(data && data.quote || '').toUpperCase();
        if ((base && base !== effFrom) || (quote && quote !== effTo)) return NaN;
        return Number(data && data.rate);
      },
      name: 'ECB'
    },
    {
      url: 'https://open.er-api.com/v6/latest/' + encodeURIComponent(effFrom),
      parse: function (data) {
        if (data && data.result && data.result !== 'success') return NaN;
        var base = String(data && data.base_code || '').toUpperCase();
        if (base && base !== effFrom) return NaN;
        return Number(data && data.rates && data.rates[effTo]);
      },
      name: 'ExchangeRate-API'
    },
    {
      url: 'https://latest.currency-api.pages.dev/v1/currencies/' + encodeURIComponent(fromLow) + '.json',
      parse: function (data) {
        var rates = data && data[fromLow];
        return Number(rates && rates[toLow]);
      },
      name: 'Currency-API'
    }
  ];
  function attempt(index) {
    if (index >= sources.length) return Promise.reject(new Error('fx-unavailable'));
    var source = sources[index];
    return fetchWithTimeout(fetcher, source.url, 5000).then(function (res) {
      if (!res || !res.ok) throw new Error('fx-http');
      return res.json();
    }).then(function (data) {
      var rate = source.parse(data);
      if (isFinite(rate) && rate > 0) return { rate: rate, source: source.name };
      return null;
    }, function () {
      return null;
    }).then(function (result) {
      return result || attempt(index + 1);
    });
  }
  return attempt(0);
}

// --- Display conversion (main-currency switching) ---
// Trades are stored native (total + currency never change). The fxLock is
// the entry-time record. For DISPLAY, every trade is converted into the
// CURRENT main currency at its HISTORICAL ECB rate (trade date), via a
// persisted cache (ECB history never changes, so entries stay valid
// forever). Live prices (current valuation) always come from refreshPrices
// in the current main. P&L = live value − historical cost, as specified.
// Fallback: if a pair is missing (offline, pre-ECB dates), the trade keeps
// its stored fxLock so the page still paints; numbers then match the old
// main and get corrected on the next online render.

var FXCACHE_KEY = 'inoculens.fxcache.v1';
var FXCACHE_MAX = 1000;
var fxCacheStore = null; // key "date|FROM|TO" -> {rate, source}; lazy-loaded

function fxCacheKey(date, from, to) {
  return String(date) + '|' + String(from).toUpperCase() + '|' + String(to).toUpperCase();
}

function loadFxCache(reload) {
  if (fxCacheStore !== null && !reload) return fxCacheStore;
  fxCacheStore = {};
  try {
    var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(FXCACHE_KEY) : null;
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') fxCacheStore = parsed;
    }
  } catch (e) { fxCacheStore = {}; }
  return fxCacheStore;
}

function saveFxCache() {
  try {
    if (typeof localStorage === 'undefined') return;
    var keys = Object.keys(fxCacheStore || {});
    var store = fxCacheStore;
    if (keys.length > FXCACHE_MAX) {
      // Plain objects keep insertion order for string keys: keep newest.
      store = {};
      keys.slice(keys.length - 800).forEach(function (k) { store[k] = fxCacheStore[k]; });
      fxCacheStore = store;
    }
    localStorage.setItem(FXCACHE_KEY, JSON.stringify(store));
  } catch (e) { /* private mode / quota: memory cache still works */ }
}

function clearFxCache() {
  fxCacheStore = {};
  try { fxFillReset(); } catch (e) { /* display fills not loaded */ }
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(FXCACHE_KEY);
  } catch (e) { /* ignore */ }
}

function getCachedRate(date, from, to) {
  var f = String(from || '').toUpperCase();
  var t = String(to || '').toUpperCase();
  if (!f || !t) return null;
  if (f === t || (stableToUsd(f) && stableToUsd(t))) return { rate: 1, source: '1:1' };
  // Stablecoins are modelled 1:1 USD (see fetchEcbRate), so USD <-> USDC/USDT/
  // DAI is an exact identity, not a cached ECB fixing. It must short-circuit
  // here: the exactly-1 self-heal below would otherwise discard it, leaving the
  // pair "missing" forever — the trade kept its old-main lock in a USD view
  // (nominal numbers never converted) and the pair was refetched every paint.
  if ((f === 'USD' && stableToUsd(t)) || (stableToUsd(f) && t === 'USD')) return { rate: 1, source: '1:1' };
  var effF = stableToUsd(f) ? 'USD' : f;
  var effT = stableToUsd(t) ? 'USD' : t;
  var cache = loadFxCache();
  var hit = cache[fxCacheKey(date, f, t)] || ((effF !== f || effT !== t) ? cache[fxCacheKey(date, effF, effT)] : null);
  if (hit && isFinite(Number(hit.rate)) && Number(hit.rate) > 0 && typeof hit.source === 'string') {
    // Self-heal: a cached exactly-1 for two distinct, non-stable fiats is a
    // stale artifact, never a real ECB fixing — a 1:1 would pose as a rate
    // forever (fills skip cached pairs). Treat as missing so it refetches.
    if (Number(hit.rate) === 1 && !stableToUsd(f) && !stableToUsd(t)) return null;
    return { rate: Number(hit.rate), source: hit.source };
  }
  return null;
}

function cacheRate(date, from, to, rate, source) {
  var f = String(from || '').toUpperCase();
  var t = String(to || '').toUpperCase();
  if (!f || !t || f === t || !isFinite(Number(rate)) || Number(rate) <= 0) return;
  loadFxCache()[fxCacheKey(date, f, t)] = { rate: Number(rate), source: String(source || '') };
}
