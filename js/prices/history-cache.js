'use strict';
// Historical price cache (localStorage, bounded) with failure cooldowns and
// per-quote diagnostics.

// --- Historical execution prices (per-trade market reference) ---
// Exec. price resolution order per trade: (1) manual override from
// loadState().priceOverrides (wins, no network), (2) the trade's frozen
// execLock (stamped once at save time, converted to the display main at the
// historical ECB rate — never refetched), (3) cached historical price for
// (symbol, trade date, main), (4) network history — CoinGecko /history
// (DD-MM-YYYY) for mapped crypto, Stooq daily closes for stock and
// commodity accounts with
// up to 5-day walk-back for weekends/holidays — converted into the display
// main at the HISTORICAL ECB rate of the fixing date (never today's rate),
// (5) null when unknown (row shows "—", never 0). Never throws to the UI.
// Real price stays purely calculated (all-in converted total / qty); Exec is
// the reference-only market quote it is compared against.

var HISTCACHE_KEY = 'inoculens.histcache.v1';
var HISTCACHE_MAX = 1000;
var histPriceCache = null; // key "SYM|DATE|VS|kind" -> {price, source, interpolated, at}; lazy-loaded
var priceDataCacheRevision = 0;

function histCacheKey(symbol, date, vs, kind) {
  return String(symbol).toUpperCase() + '|' + String(date).slice(0, 10) + '|' +
    String(vs).toUpperCase() + '|' + String(kind || '').toLowerCase();
}

function loadHistCache(reload) {
  if (histPriceCache !== null && !reload) return histPriceCache;
  histPriceCache = {};
  try {
    var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(HISTCACHE_KEY) : null;
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') histPriceCache = parsed;
    }
  } catch (e) { histPriceCache = {}; }
  return histPriceCache;
}

function saveHistCache() {
  priceDataCacheRevision++;
  try {
    if (typeof localStorage !== 'undefined') {
      var keys = Object.keys(histPriceCache || {});
      var store = histPriceCache;
      if (keys.length > HISTCACHE_MAX) {
        store = {};
        keys.slice(keys.length - 800).forEach(function (k) { store[k] = histPriceCache[k]; });
        histPriceCache = store;
      }
      localStorage.setItem(HISTCACHE_KEY, JSON.stringify(store));
    }
  } catch (e) { /* private mode / quota: memory cache still works */ }
  try { priceDataScheduleUpload(); } catch (e2) { /* cache persistence must not break quote lookup */ }
}

// Keys that failed recently (network/429/dead source): later passes skip
// them until a short cooldown lapses, so one outage doesn't hammer the price
// APIs on every render (which also starves the live-price quota) — but unlike
// a session pin, a later render or a timed retry still heals the row.
var histFailKeys = {}; // key -> {fails, at}
var HIST_FAIL_MAX = 5;
function histCooldownMs(fails) {
  return Math.min(60000 * Math.pow(2, Math.max(0, (fails || 1) - 1)), 300000);
}
function histBlocked(key) {
  var f = histFailKeys[key];
  if (!f) return false;
  if ((f.fails || 0) >= HIST_FAIL_MAX) return true;
  return (Date.now() - (f.at || 0)) < histCooldownMs(f.fails);
}
function histNoteFail(key) {
  var f = histFailKeys[key] || { fails: 0, at: 0 };
  f.fails = (f.fails || 0) + 1;
  f.at = Date.now();
  histFailKeys[key] = f;
  histRetryLater(key);
}
// Timed retry so an open page heals without waiting for the next render.
// Bounded by HIST_FAIL_MAX; each attempt re-caches and repaints on success.
function histRetryLater(key) {
  var f = histFailKeys[key];
  if (!f || (f.fails || 0) >= HIST_FAIL_MAX) return;
  var delay = histCooldownMs(f.fails);
  setTimeout(function () {
    try {
      var parts = String(key).split('|');
      if (parts.length !== 4) return;
      if (histInflight[key] || histBlocked(key)) return;
      var hit = null;
      try { hit = getHistCached(parts[0], parts[1], parts[2], parts[3]); } catch (e) { hit = null; }
      if (hit) { try { delete histFailKeys[key]; } catch (e) { /* ignore */ } return; }
      histInflight[key] = true;
      fetchHistoricalPrice(parts[0], parts[1], parts[2], (parts[3] === 'stock' || parts[3] === 'commodity') ? parts[3] : undefined).then(function (r) {
        delete histInflight[key];
        var price = (r && typeof r === 'object') ? r.price : r;
        if (isFinite(Number(price)) && Number(price) > 0) {
          try {
            setHistCached(parts[0], parts[1], parts[2], parts[3], Number(price),
              (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history',
              (r && typeof r === 'object') ? !!r.interpolated : false);
            saveHistCache();
          } catch (e) { /* ignore */ }
          try { delete histFailKeys[key]; } catch (e) { /* ignore */ }
          try { render(); } catch (e) { /* ignore */ }
        } else { histNoteFail(key); }
      }, function () { delete histInflight[key]; histNoteFail(key); });
    } catch (e) { /* ignore */ }
  }, delay);
}

// History fetches currently in flight, by the same key: shared by
// freezeExecLock + ensureHistoricalExec so a save and its first repaint never
// fire duplicate CoinGecko calls for the same quote (duplicate bursts are
// what trip the free-tier rate limit, leaving both with nothing and the row
// on "—"). Entries are removed on settle; also reset with the cache.
var histInflight = {};

// Last per-quote history failure, in plain words (session-only): attached
// to the fee-rate tooltip so a failed lookup names its cause.
var histDiag = {}; // key(sym|day|vs|crypto) -> text
function histDiagNote(sym, day, vs, text) {
  try {
    var k = String(sym || '').toUpperCase() + '|' + String(day || '').slice(0, 10) + '|' + String(vs || '').toUpperCase() + '|crypto';
    var prev = histDiag[k];
    histDiag[k] = prev ? (prev + '; ' + text) : String(text);
  } catch (e) { /* ignore */ }
}
function histDiagClear(sym, day, vs) {
  try { delete histDiag[String(sym || '').toUpperCase() + '|' + String(day || '').slice(0, 10) + '|' + String(vs || '').toUpperCase() + '|crypto']; } catch (e) { /* ignore */ }
}
function getHistCached(symbol, date, vs, kind) {
  var c = loadHistCache()[histCacheKey(symbol, date, vs, kind)];
  if (c && isFinite(Number(c.price)) && Number(c.price) > 0) {
    return { price: Number(c.price), source: String(c.source || ''), interpolated: !!c.interpolated };
  }
  return null;
}

function setHistCached(symbol, date, vs, kind, price, source, interpolated) {
  if (!isFinite(Number(price)) || Number(price) <= 0) return;
  loadHistCache()[histCacheKey(symbol, date, vs, kind)] = {
    price: Number(price), source: String(source || ''), interpolated: !!interpolated, at: Date.now()
  };
}
