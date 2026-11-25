'use strict';
// Display conversion: fills the historical FX pairs the current paint needs and
// converts records to the main currency at their locked (trade-date) rate.

// Distinct (date, currency) pairs across trades that still need a rate
// into `main`. Same-currency needs nothing (rate 1, no network). One fiat
// per trade: only the trade currency (plus frozen exec / tagged override
// fiats, which ride the same pair when they match) ever needs converting.
// Optional kinds ({accountId: kind}) additionally prefetches today's rate
// for open cash income — holdings float, so the current fixing is needed
// alongside the frozen trade-date locks.
function displayPairs(trades, main, kinds) {
  var m = String(main || '').toUpperCase();
  var seen = {};
  var out = [];
  function need(date, from) {
    var f = String(from || '').toUpperCase();
    if (!f || !date || f === m) return;
    var k = date + '|' + f;
    if (seen[k] || getCachedRate(date, f, m)) return;
    seen[k] = true;
    out.push({ date: date, from: f });
  }
  function needToday(fiat) {
    var f = String(fiat || '').toUpperCase();
    if (!f || f === m) return;
    var dk = '';
    try { dk = todayStr(); } catch (e) { return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return;
    var k = dk + '|' + f;
    if (seen[k] || getCachedRate(dk, f, m)) return;
    seen[k] = true;
    out.push({ date: dk, from: f });
  }
  function needLock(lock, date) {
    if (!lock || typeof lock.pair !== 'string') return;
    var pair = /^([A-Z]{2,10})\/[A-Z]{2,10}$/i.exec(lock.pair.trim());
    if (pair) need(date, pair[1]);
  }
  (trades || []).forEach(function (t) {
    if (!t) return;
    var c = (typeof t.currency === 'string') ? t.currency.toUpperCase() : '';
    var d = (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) ? t.date.slice(0, 10) : '';
    if (!d) return;
    if (c) need(d, c);
    needLock(t.fromFxLock, d);
    needLock(t.toFxLock, d);
    if (!c) return;
    if (kinds && t.type === 'income' && c !== m) {
      var kd = '';
      try { kd = kinds[t.accountId] || ''; } catch (e) { kd = ''; }
      if (isCashKind(kd)) needToday(c);
    }
    // Frozen exec quote in another fiat needs its own historical rate to
    // render in the current main (deduped by `seen` when it matches a leg).
    // Same for a fiat-tagged manual override (Exec falls back to it).
    if (t.type === 'buy' || t.type === 'sell') {
      var fr = null;
      try { fr = frozenExecOf(t); } catch (e) { fr = null; }
      if (fr && fr.vs && fr.vs !== m) need(d, fr.vs);
      var oe = null;
      try { oe = priceOverrideEntry(t.symbol, PRICE_KIND_BY_ACCOUNT[t.accountId]); } catch (e) { oe = null; }
      if (oe && oe.vs && oe.vs !== m) need(d, oe.vs);
    }
  });
  return out;
}

// Fill the cache for every pair the current paint needs. Never rejects:
// a failed pair keeps its stored fxLock (degraded display, corrected later).
// Failures are recorded (fxFailedList) so the render can say so honestly
// instead of printing fallback figures as if they were fresh.
var fxFailedList = [];
var fxWarnedSession = false;

// Snapshot of the pairs that failed since the last refreshDisplayRates().
function fxFailedPairs() {
  return fxFailedList.slice();
}

// Background fills run on every paint. They share one request per pair while
// it is in flight, and a pair that failed is retried only after a cooldown
// (30 s, doubling per failure, at most 10 min) instead of on the next paint:
// offline or with the rate service down, a large ledger would otherwise
// re-request every missing pair on every repaint. Saving a record calls
// fetchEcbRate directly and always tries the network.
var FX_FILL_RETRY_MS = 30000;
var FX_FILL_RETRY_MAX_MS = 10 * 60000;
var fxFillInflight = {}; // "date|FROM|TO" -> pending promise
var fxFillFailures = {}; // "date|FROM|TO" -> {fails, until}

function fxFillRate(date, from, to) {
  var key = date + '|' + from + '|' + to;
  if (fxFillInflight[key]) return fxFillInflight[key];
  var failed = fxFillFailures[key];
  if (failed && Date.now() < failed.until) return Promise.reject(new Error('fx-unavailable'));
  var pending = fetchEcbRate(date, from, to).then(function (rate) {
    delete fxFillInflight[key];
    delete fxFillFailures[key];
    return rate;
  }, function (err) {
    delete fxFillInflight[key];
    var fails = (failed ? failed.fails : 0) + 1;
    fxFillFailures[key] = { fails: fails, until: Date.now() + Math.min(FX_FILL_RETRY_MAX_MS, FX_FILL_RETRY_MS * Math.pow(2, fails - 1)) };
    throw err;
  });
  fxFillInflight[key] = pending;
  return pending;
}

function fxFillReset() {
  fxFillInflight = {};
  fxFillFailures = {};
}

// Back online: retry on the next paint instead of waiting out the cooldowns
// built up while the device was offline.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', function () { fxFillFailures = {}; });
}

function ensureDebtDisplayRates(accounts, main) {
  var day = todayStr();
  var seen = {};
  var jobs = [];
  (accounts || []).forEach(function (account) {
    if (!account) return;
    accountDebtPositions(account).forEach(function (position) {
      var snapshot = latestDebtBalanceSnapshot(position, Date.now());
      var amount = snapshot ? Number(snapshot.amount) : 0;
      var kind = String(position.assetKind || account.kind || 'crypto').trim().toLowerCase();
      if (!isCashKind(kind) || !(amount > 0)) return;
      var from = String(position.assetTicker || account.ticker || '').trim().toUpperCase();
      var to = String(main || '').trim().toUpperCase();
      if (!from || !to || from === to) return;
      var key = day + '|' + from + '|' + to;
      if (seen[key] || getCachedRate(day, from, to)) return;
      seen[key] = true;
      jobs.push(fxFillRate(day, from, to).then(function (rate) {
        if (!rate || !isFinite(Number(rate.rate)) || Number(rate.rate) <= 0) return false;
        cacheRate(day, from, to, Number(rate.rate), rate.source || 'ECB');
        return true;
      }, function () { return false; }));
    });
  });
  if (!jobs.length) return Promise.resolve(false);
  return Promise.all(jobs).then(function (flags) {
    var changed = flags.some(Boolean);
    if (changed) saveFxCache();
    return changed;
  });
}


function ensureDisplayRates(trades, main, kinds) {
  var m = String(main || '').toUpperCase();
  var pairs = displayPairs(trades, m, kinds);
  if (!pairs.length) return Promise.resolve(false);
  return Promise.all(pairs.map(function (p) {
    return fxFillRate(p.date, p.from, m).then(function (r) {
      cacheRate(p.date, p.from, m, r.rate, r.source);
      return true;
    }, function () {
      try {
        var dup = fxFailedList.some(function (x) { return x && x.date === p.date && x.from === p.from && x.to === m; });
        if (!dup) fxFailedList.push({ date: p.date, from: p.from, to: m });
      } catch (e) { /* ignore */ }
      return false;
    });
  })).then(function (flags) {
    var changed = false;
    flags.forEach(function (f) { if (f) changed = true; });
    if (changed) saveFxCache();
    return changed;
  });
}

// One calm banner for unrefreshable conversions (session-once): lists the
// pairs so a confident-looking fallback is never mistaken for fresh math.
function fxFailedMessage(pairs) {
  var lines = (pairs || []).slice(0, 4).map(function (p) {
    return p.from + ' → ' + p.to + ' · ' + p.date;
  });
  if ((pairs || []).length > 4) lines.push('…');
  return {
    msg: 'Some conversions couldn\'t refresh — affected figures show entry-time values.',
    title: 'FX rates unavailable',
    lines: lines
  };
}

// Copy of a trade with fxLock rewritten into `main` at the historical rate.
// Native total/currency/fee untouched (fixed in stone); the fee always rides
// the trade lock (one fiat per trade). Falls back to the stored lock when no
// rate is cached yet (first paint before fetch lands, or offline) — see
// module comment.
function convertTrade(t, main) {
  var m = String(main || '').toUpperCase();
  if (!t || typeof t !== 'object') return t;
  var c = (typeof t.currency === 'string') ? t.currency.toUpperCase() : '';
  var d = (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) ? t.date.slice(0, 10) : '';
  if (!c || !d) return t;
  var out = null;
  function clone() {
    if (out) return out;
    out = {};
    for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) out[k] = t[k]; }
    return out;
  }
  function lockFor(from) {
    var f = String(from || '').toUpperCase();
    if (!f) return null;
    if (f === m) return { pair: f + '/' + m, rate: 1, source: '1:1', interpolated: false };
    var hit = getCachedRate(d, f, m);
    if (!hit) return null;
    var fixDay = (/^ECB-(\d{4}-\d{2}-\d{2})$/.exec(hit.source) || [])[1] || d;
    return { pair: f + '/' + m, rate: hit.rate, source: 'ECB-' + fixDay, interpolated: fixDay !== d };
  }
  function convertLegLock(lock) {
    if (!lock || typeof lock.pair !== 'string') return lock;
    var pair = /^([A-Z]{2,10})\/([A-Z]{2,10})$/i.exec(lock.pair.trim());
    if (!pair) return lock;
    var from = pair[1].toUpperCase();
    var oldTo = pair[2].toUpperCase();
    var direct = lockFor(from);
    if (direct) return direct;
    if (oldTo === m) return lock;
    var bridge = lockFor(oldTo);
    var rate = Number(lock.rate);
    if (!bridge || !isFinite(rate) || rate <= 0) return lock;
    return {
      pair: from + '/' + m,
      rate: rate * bridge.rate,
      source: bridge.source,
      interpolated: !!(lock.interpolated || bridge.interpolated)
    };
  }
  // Total leg.
  if (c === m) {
    clone().fxLock = { pair: c + '/' + m, rate: 1, source: '1:1', interpolated: false };
  } else {
    var tl = lockFor(c);
    if (tl) clone().fxLock = tl;
    // No cached rate yet: keep the stored lock (corrected on re-render).
  }
  if (t.fromFxLock || t.toFxLock) {
    var convertedFromLock = convertLegLock(t.fromFxLock);
    var convertedToLock = convertLegLock(t.toFxLock);
    if (convertedFromLock !== t.fromFxLock || convertedToLock !== t.toFxLock) {
      clone();
      if (convertedFromLock) out.fromFxLock = convertedFromLock;
      if (convertedToLock) out.toFxLock = convertedToLock;
    }
  }
  // One fiat per trade: a stale separate fee lock would convert the fee at
  // the wrong rate, so it is always dropped from display copies.
  if (t.feeFxLock !== undefined) {
    clone();
    try { delete out.feeFxLock; } catch (e) { out.feeFxLock = undefined; }
  }
  return out || t;
}

function convertTrades(trades, main) {
  return (trades || []).map(function (t) { return convertTrade(t, main); });
}
