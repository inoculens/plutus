'use strict';
// One-time repair for quotes baked in the wrong fiat: an earlier build
// stamped the live global override raw under the display main when freezing.
// A non-manual frozen quote that exactly equals a current global override is
// such a stamped copy (a genuine market quote never equals a hand-entered
// number to the cent) — dropping it lets the row fall back to the override
// itself (still shown while set) or a genuine history refetch. Manual quotes
// are the user's own words and are never touched. Pure: mutates the passed
// array, returns true when anything was dropped. Never throws.
function dropBakedExecLocks(trades, overrides) {
  var changed = false;
  try {
    var ov = (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) ? overrides : {};
    (trades || []).forEach(function (t) {
      if (!t || typeof t !== 'object' || (t.type !== 'buy' && t.type !== 'sell')) return;
      var fr = null;
      try { fr = frozenExecOf(t); } catch (e) { fr = null; }
      if (!fr || String(fr.source).toLowerCase() === 'manual') return;
      var hit = findOverrideRaw(ov, t.symbol, PRICE_KIND_BY_ACCOUNT[t.accountId]);
      if (!hit) return;
      var raw = hit.raw;
      var op = (typeof raw === 'number') ? raw
        : ((raw && typeof raw === 'object' && !Array.isArray(raw)) ? Number(raw.price) : NaN);
      if (isFinite(op) && op > 0 && op === fr.price) {
        try { delete t.execLock; } catch (e) { t.execLock = undefined; }
        changed = true;
      }
    });
  } catch (e) { /* repair never breaks the run */ }
  return changed;
}

// An expense that loses a quantity of an asset (not a cash-only expense).
// Its fiat worth at the tx date feeds the SPENT AMOUNT pills, so it needs the
// same reference quote (frozen at save + history prefetch) as buy/sell/transfer.
function isCryptoQtyExpense(t) {
  if (!t || t.type !== 'expense') return false;
  if (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') return false;
  var q = Number(t.qty);
  return isFinite(q) && q > 0;
}

// Fiat worth, in the main fiat, of an expense paid in the account asset at
// the quote of the spend date (frozen at save, else the history cache). It is
// derived, never typed: the user enters only what left the account, so a
// website's own fx rate can never book a different amount. Null when the
// record is not a crypto-quantity expense or no rate in the main fiat is known.
function expenseFiatValueMain(t, main, kind) {
  if (!isCryptoQtyExpense(t)) return null;
  var m = String(main || '').toUpperCase();
  var ex = null;
  try { ex = resolveExecPrice(t, main, kind); } catch (e) { ex = null; }
  if (!ex || !m || String(ex.ccy || '').toUpperCase() !== m) return null;
  var v = Number(t.qty) * Number(ex.price);
  return (isFinite(v) && v > 0) ? v : null;
}

// Fiat cost of one expense for the SPENT AMOUNT pills. A crypto-quantity
// expense counts once, at its spend-date value: a stored fiat total (legacy
// records) already describes the same money, so adding both double-counted.
// Without a known rate it falls back to the stored total (never 0 from a guess).
function expenseSpentMain(t, main, kind) {
  var eq = expenseFiatValueMain(t, main, kind);
  if (eq !== null) return eq;
  var n = normalizeTrade(t);
  return (isFinite(n.netMain) && n.netMain > 0) ? n.netMain : 0;
}

// Frozen reference quote stamped on the trade at save time:
// {price, vs, source}. Extra trade key, ignored by validation/ledger/export
// shape checks (isValidImportTrade only asserts known fields).
function frozenExecOf(t) {
  if (!t || typeof t !== 'object') return null;
  var e = t.execLock;
  if (!e || typeof e !== 'object') return null;
  var p = Number(e.price);
  var vs = (typeof e.vs === 'string') ? e.vs.trim().toUpperCase() : '';
  if (!isFinite(p) || p <= 0 || !/^[A-Z]{2,10}$/.test(vs)) return null;
  return { price: p, vs: vs, source: String(e.source || '') };
}

// Fetch-once patch for trades saved without a frozen quote (history fetch
// failed at save, or a pre-freeze legacy trade being edited). Never blocks
// saving and never throws: on failure the legacy async display path keeps
// serving the row (override → frozen → hist cache → network → "—").
// A fiat-tagged manual override freezes verbatim (no fetch, no conversion).
function freezeExecLock(tradeId, symbol, date, mainU, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var day = (typeof date === 'string') ? date.slice(0, 10) : '';
  var m = String(mainU || '').trim().toUpperCase();
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  if (!tradeId || !sym || !isValidDateStr(day)) return;
  if (kd === 'custom' || kd === 'cash') return;
  if (kd === 'commodity') { if (!hasCommoditySource(sym)) return; }
  else if (kd !== 'stock' && !SYMBOL_MAP[sym]) return;
  function patch(price, vs, source) {
    if (!(isFinite(Number(price)) && Number(price) > 0)) return;
    if (!/^[A-Z]{2,10}$/.test(String(vs || ''))) return;
    var st = null;
    try { st = loadState(); } catch (e) { return; }
    var found = false;
    (st.trades || []).forEach(function (t) {
      if (t && t.id === tradeId && !frozenExecOf(t)) {
        t.execLock = { price: Number(price), vs: String(vs).toUpperCase(), source: String(source || '') };
        found = true;
      }
    });
    if (!found) return;
    try { saveStateGuarded(st); } catch (e) { return; }
    try { render(); } catch (e) { /* paint stays, next render picks it up */ }
  }
  // A live global override already serves this trade's Exec row: never stamp
  // a live price as a historical quote.
  try { if (priceOverrideEntry(sym, kd) !== null) return; } catch (e) { /* fall through */ }
  var kk = histKindFor(kd);
  var ckey = sym + '|' + day + '|' + m + '|' + kk;
  // Already known (e.g. the first paint filled it while saving): freeze with
  // zero network.
  var hit = null;
  try { hit = getHistCached(sym, day, m, kk); } catch (e) { hit = null; }
  if (hit) {
    patch(hit.price, m, hit.source || 'history');
    return;
  }
  // Another fetch for this exact quote is already running (e.g. the repaint
  // triggered by this very save): share it instead of doubling the burst.
  if (histInflight[ckey]) return;
  histInflight[ckey] = true;
  fetchHistoricalPrice(sym, day, m, kd).then(function (r) {
    delete histInflight[ckey];
    var price = (r && typeof r === 'object') ? r.price : r;
    // Write through to the history cache too, so the legacy display path and
    // later fiat switches reuse this quote without refetching.
    if (isFinite(Number(price)) && Number(price) > 0) {
      try {
        setHistCached(sym, day, m, kk, Number(price),
          (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history',
          (r && typeof r === 'object') ? !!r.interpolated : false);
        saveHistCache();
      } catch (e) { /* memory cache still works */ }
    }
    patch(price, m, (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history');
  }, function () { delete histInflight[ckey]; /* legacy async display path covers the row */ });
}

// Sync read for paint: override, else cache, else null (async fill follows).
function getHistoricalExec(symbol, dateStr, vs, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!sym || !isValidDateStr(day)) return null;
  var ov = null;
  try { ov = priceOverrideFor(sym, kind); } catch (e) { ov = null; }
  if (ov !== null) return { price: ov, source: 'manual', interpolated: false };
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  var hit = getHistCached(sym, day, cur, histKindFor(kd));
  if (hit) return hit;
  return null;
}

// Fill the cache for every (symbol, date) the current paint needs. Never
// rejects: unknown tickers resolve to null and keep the "—" placeholder.
function ensureHistoricalExec(trades, main, kinds) {
  var m = String(main || priceDefaultVs()).toUpperCase();
  function kindFor(sym) {
    if (!kinds) return undefined;
    if (typeof kinds === 'function') { try { return kinds(sym); } catch (e) { return undefined; } }
    if (typeof kinds === 'object') {
      if (Object.prototype.hasOwnProperty.call(kinds, sym)) return kinds[sym];
      var up = String(sym).toUpperCase();
      var ks = Object.keys(kinds);
      for (var i = 0; i < ks.length; i++) if (String(ks[i]).toUpperCase() === up) return kinds[ks[i]];
    }
    return undefined;
  }
  var seen = {};
  var jobs = [];
  var idsByKey = {}; // quote key -> trade ids waiting on it (for failure tooltips)
  (trades || []).forEach(function (t) {
    if (!t || (t.type !== 'buy' && t.type !== 'sell' && t.type !== 'transfer' && !isCryptoQtyExpense(t))) return;
    var sym = String((t && t.symbol) || '').toUpperCase();
    var day = (t && typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) ? t.date.slice(0, 10) : '';
    if (!sym || !isValidDateStr(day) || isFutureDateStr(day)) return;
    var kd = (typeof kindFor(sym) === 'string') ? kindFor(sym).trim().toLowerCase() : '';
    if (kd === 'custom' || kd === 'cash') return;
    if (kd === 'commodity') { if (!hasCommoditySource(sym)) return; }
    else if (kd !== 'stock' && !SYMBOL_MAP[sym]) return;
    var kk = histKindFor(kd);
    var key = sym + '|' + day + '|' + m + '|' + kk;
    if (t.id) { (idsByKey[key] = idsByKey[key] || []).push(t.id); }
    if (seen[key]) return;
    seen[key] = true;
    try { if (priceOverrideFor(sym, kd) !== null) return; } catch (e) { /* fall through */ }
    if (frozenExecOf(t)) return; // frozen quote on the trade: no network needed
    if (getHistCached(sym, day, m, kk)) return;
    if (histBlocked(key)) return; // failed recently: retry after cooldown, not every render
    if (histInflight[key]) return; // already fetching (e.g. save just froze it)
    histInflight[key] = true;
    jobs.push(fetchHistoricalPrice(sym, day, m, kd).then(function (r) {
      delete histInflight[key];
      var price = (r && typeof r === 'object') ? r.price : r;
      var interp = (r && typeof r === 'object') ? !!r.interpolated : false;
      var src = (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history';
      if (isFinite(Number(price)) && Number(price) > 0) {
        setHistCached(sym, day, m, kk, Number(price), src, interp);
        return true;
      }
      histNoteFail(key);
      (idsByKey[key] || []).forEach(function (id) { try { feeFailMsg(id, key); } catch (e) { /* ignore */ } });
      return false;
    }, function () { delete histInflight[key]; histNoteFail(key); (idsByKey[key] || []).forEach(function (id) { try { feeFailMsg(id, key); } catch (e) { /* ignore */ } }); return false; }));
  });
  if (!jobs.length) return Promise.resolve(false);
  return Promise.all(jobs).then(function (flags) {
    var changed = false;
    flags.forEach(function (f) { if (f) changed = true; });
    if (changed) { try { saveHistCache(); } catch (e) { /* ignore */ } }
    return changed;
  });
}
