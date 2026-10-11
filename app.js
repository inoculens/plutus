'use strict';
/* INOCULENS PLUTUS — app.js
 * Vanilla JS, no framework, no build step. Organized in sections:
 * Store, Prices, Fx, Ledger, Ui. Tasks 3-6 append their sections below.
 */

// === Store ===
// Local-first persistence: localStorage + versioned export/import.
// Key: exactly 'inoculens.v2' (v1 is never read at runtime; v1 files import
// via the grouping branch in importState). Export envelope: exactly
// {app:"inoculens-plutus", version:2, exportedAt, settings, accounts, trades, priceOverrides}.
// Failed imports throw Error(reason) and leave stored data untouched.

var STORAGE_KEY = 'inoculens.v2';
var APP_ID = 'inoculens-plutus';
var STORE_VERSION = 2;

function defaultState() {
  return {
    settings: { mainCurrency: 'EUR', costMethod: 'average' },
    accounts: [],
    trades: [],
    priceOverrides: {}
  };
}

var MAIN_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'RON'];

function isValidDateStr(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  var p = d.slice(0, 10).split('-');
  var y = Number(p[0]);
  var m = Number(p[1]);
  var day = Number(p[2]);
  if (!isFinite(y) || !isFinite(m) || !isFinite(day)) return false;
  if (m < 1 || m > 12 || day < 1 || day > 31) return false;
  var t = Date.UTC(y, m - 1, day);
  if (!isFinite(t)) return false;
  var chk = new Date(t);
  return chk.getUTCFullYear() === y && (chk.getUTCMonth() + 1) === m && chk.getUTCDate() === day;
}

function isFutureDateStr(d) {
  if (!isValidDateStr(d)) return false;
  var n = new Date();
  var mm = n.getMonth() + 1;
  var dd = n.getDate();
  var today = n.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
  return d.slice(0, 10) > today;
}

function isValidSettings(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.mainCurrency === 'string' && MAIN_CURRENCIES.indexOf(v.mainCurrency.toUpperCase()) !== -1 &&
    (v.costMethod === 'average' || v.costMethod === 'fifo');
}

function isValidAccount(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (typeof a.id !== 'string' || a.id.length === 0) return false;
  if (typeof a.name !== 'string' || a.name.trim().length === 0) return false;
  if (typeof a.ticker !== 'string') return false;
  var tk = a.ticker.trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,12}$/.test(tk)) return false;
  if (a.kind !== undefined && a.kind !== null && String(a.kind).trim() !== '') {
    var kd = String(a.kind).trim().toLowerCase();
    if (kd !== 'crypto' && kd !== 'stock' && kd !== 'custom' && kd !== 'cash') return false;
  }
  return true;
}

function normalizeAccount(a) {
  var tk = String(a.ticker || '').trim().toUpperCase();
  var nm = String(a.name == null ? '' : a.name).trim() || tk;
  var kd = (a && typeof a.kind === 'string') ? a.kind.trim().toLowerCase() : 'crypto';
  if (kd !== 'crypto' && kd !== 'stock' && kd !== 'custom' && kd !== 'cash') kd = 'crypto';
  var out = {
    id: a.id,
    name: nm,
    ticker: tk,
    kind: kd,
    createdAt: (typeof a.createdAt === 'string' && a.createdAt.length > 0)
      ? a.createdAt
      : new Date().toISOString()
  };
  if (a && typeof a.address === 'string' && a.address.trim() !== '') out.address = a.address.trim().slice(0, 128);
  if (a && typeof a.note === 'string' && a.note.trim() !== '') out.note = a.note.trim().slice(0, 280);
  if (a && isValidHexColor(a.color)) out.color = String(a.color).trim().toUpperCase();
  return out;
}

function normalizeAccountFilter(v) {
  if (v === undefined || v === null) return null; // null = show all assets
  if (!Array.isArray(v)) return null;
  var seen = {};
  var out = [];
  v.forEach(function (t) {
    var u = String(t === undefined || t === null ? '' : t).trim().toUpperCase();
    if (!isValidSymbolCode(u) || seen[u]) return;
    seen[u] = true;
    out.push(u);
  });
  return out; // [] = none selected
}

function normalizeSettings(s, fallback) {
  var fb = fallback || { mainCurrency: 'EUR', costMethod: 'average' };
  if (!isValidSettings(s)) {
    var outFb = { mainCurrency: fb.mainCurrency, costMethod: fb.costMethod };
    var fbf = normalizeAccountFilter(fb.accountFilter);
    if (fbf !== null) outFb.accountFilter = fbf;
    return outFb;
  }
  var res = {
    mainCurrency: String(s.mainCurrency).toUpperCase(),
    costMethod: s.costMethod
  };
  var flt = normalizeAccountFilter(s.accountFilter);
  if (flt !== null) res.accountFilter = flt;
  return res;
}

function loadState() {
  var fallback = defaultState();
  var raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    return fallback;
  }
  if (raw === null || raw === undefined) return fallback;
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  var accounts = Array.isArray(parsed.accounts)
    ? parsed.accounts.filter(isValidAccount).map(normalizeAccount)
    : [];
  var accountIds = accounts.map(function (a) { return a.id; });
  var trades = Array.isArray(parsed.trades)
    ? parsed.trades.filter(function (t) { return isValidImportTrade(t, accountIds); }).map(normalizeTradeForStore)
    : [];
  var priceOverrides = {};
  if (parsed.priceOverrides && typeof parsed.priceOverrides === 'object' && !Array.isArray(parsed.priceOverrides) && isValidPriceOverrides(parsed.priceOverrides)) {
    priceOverrides = parsed.priceOverrides;
  }
  var settings = normalizeSettings(parsed.settings, fallback.settings);
  return {
    settings: settings,
    accounts: accounts,
    trades: trades,
    priceOverrides: priceOverrides
  };
}

function saveState(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    throw new Error('storage-unavailable');
  }
  // Any persisted change may make the drive copy stale: let auto-sync
  // (opt-in, Sync tab) schedule an encrypted push. Never breaks saving.
  try { syncScheduleAuto(); } catch (e) { /* ignore */ }
}

var TRADE_TYPES = ['buy', 'sell', 'transfer', 'income', 'expense'];

function isValidCurrencyCode(c) {
  if (typeof c !== 'string') return false;
  var u = c.trim().toUpperCase();
  if (u === 'CUSTOM') return false;
  return /^[A-Z]{2,10}$/.test(u);
}

function isValidSymbolCode(s) {
  if (typeof s !== 'string') return false;
  var u = s.trim().toUpperCase();
  return /^[A-Z0-9._-]{1,12}$/.test(u);
}

function isValidHexColor(v) {
  return typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

function contrastText(hex) {
  var h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var r = parseInt(h.slice(0, 2), 16);
  var g = parseInt(h.slice(2, 4), 16);
  var b = parseInt(h.slice(4, 6), 16);
  if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return '#1a1408';
  return ((r * 299 + g * 587 + b * 114) / 1000) >= 128 ? '#1a1408' : '#ffffff';
}

function numGte0(v, allowEmpty) {
  if (v === undefined || v === null || String(v).trim() === '') return allowEmpty ? null : false;
  if (typeof v !== 'number' && typeof v !== 'string') return false;
  var n = Number(v);
  if (!isFinite(n) || n < 0) return false;
  return n;
}

// Optional on-chain transaction hash, stored on the trade and linked to
// mempool.space in the record view. Blank/missing means absent (valid);
// when present it must look like a real hash: optional 0x prefix, then
// 8–128 alphanumerics (covers 64-hex BTC, 0x EVM and base58-style ids).
function isValidTxid(v) {
  if (v === undefined || v === null || String(v).trim() === '') return true;
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  return /^(0x)?[A-Za-z0-9]{8,128}$/.test(String(v).trim());
}

function txExplorerUrl(txid) {
  return 'https://mempool.space/tx/' + encodeURIComponent(String(txid).trim());
}

function shortTxid(txid) {
  var s = String(txid).trim();
  if (s.length <= 20) return s;
  return s.slice(0, 8) + '…' + s.slice(-6);
}

function isValidImportTrade(t, accountIds) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  if (TRADE_TYPES.indexOf(t.type) === -1) return false;
  if (!isValidSymbolCode(t.symbol)) return false;
  if (!isValidDateStr(t.date)) return false;
  if (isFutureDateStr(t.date)) return false;
  // fee (fiat) is always optional >= 0 when present
  var feeChk = numGte0(t.fee, true);
  if (feeChk === false) return false;
  if (t.feeCurrency !== undefined && t.feeCurrency !== null && String(t.feeCurrency).trim() !== '') {
    if (!isValidCurrencyCode(t.feeCurrency)) return false;
  }
  // txid is optional metadata; when present it must look like a tx hash
  if (!isValidTxid(t.txid)) return false;
  // networkFee: on-chain fee denominated in the transferred asset itself
  if (t.networkFee !== undefined && t.networkFee !== null && String(t.networkFee).trim() !== '') {
    if (typeof t.networkFee !== 'number' && typeof t.networkFee !== 'string') return false;
    var nf = Number(t.networkFee);
    if (!isFinite(nf) || nf < 0) return false;
  }
  if (t.type === 'transfer') {
    if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return false;
    var tq = Number(t.qty);
    if (!isFinite(tq) || tq <= 0) return false;
    var tnf = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
    if (!isFinite(tnf) || tnf < 0 || tnf >= tq) return false; // net received must stay > 0
    if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
      var tt = Number(t.total);
      if (!isFinite(tt) || tt < 0) return false;
    }
    if (t.currency !== undefined && t.currency !== null && String(t.currency).trim() !== '') {
      if (!isValidCurrencyCode(t.currency)) return false;
    }
    // Destination is optional: without one the transfer is an on-chain move
    // inside the same account (e.g. sweeping to a fresh address), where only
    // the network fee is lost. With one it must be a different known account.
    var hasTo = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
    if (accountIds !== undefined) {
      if (!Array.isArray(accountIds)) return false;
      if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
      if (hasTo && typeof t.toAccountId !== 'string') return false;
      if (accountIds.indexOf(t.accountId) === -1) return false;
      if (hasTo) {
        if (t.accountId === t.toAccountId) return false;
        if (accountIds.indexOf(t.toAccountId) === -1) return false;
      }
    } else {
      if (typeof t.accountId !== 'string' || !t.accountId) return false;
      if (hasTo && typeof t.toAccountId !== 'string') return false;
      if (hasTo && t.accountId === t.toAccountId) return false;
    }
    return true;
  }
  if (t.type === 'income') {
    if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return false;
    var iq = Number(t.qty);
    if (!isFinite(iq) || iq <= 0) return false;
    if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
      if (typeof t.total !== 'number' && typeof t.total !== 'string') return false;
      var it = Number(t.total);
      if (!isFinite(it) || it < 0) return false;
    }
    if (t.currency !== undefined && t.currency !== null && String(t.currency).trim() !== '') {
      if (!isValidCurrencyCode(t.currency)) return false;
    } else if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '' && Number(t.total) > 0) {
      return false; // value without currency is ambiguous
    }
    if (accountIds !== undefined) {
      if (!Array.isArray(accountIds)) return false;
      if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
      if (accountIds.indexOf(t.accountId) === -1) return false;
    }
    return true;
  }
  if (t.type === 'expense') {
    var hasQty = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
    var hasTotal = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
    if (!hasQty && !hasTotal) return false;
    if (hasQty) {
      if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return false;
      var eq = Number(t.qty);
      if (!isFinite(eq) || eq <= 0) return false;
    }
    if (hasTotal) {
      if (typeof t.total !== 'number' && typeof t.total !== 'string') return false;
      var et = Number(t.total);
      if (!isFinite(et) || et < 0) return false;
      if (et === 0 && !hasQty) return false;
    }
    if (typeof t.currency !== 'string' || !isValidCurrencyCode(t.currency)) {
      // crypto-only expense may omit currency; fiat expense must name it
      if (hasTotal) return false;
    }
    if (accountIds !== undefined) {
      if (!Array.isArray(accountIds)) return false;
      if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
      if (accountIds.indexOf(t.accountId) === -1) return false;
    }
    return true;
  }
  // buy / sell (legacy strict path, preserved for tests)
  if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return false;
  var qty = Number(t.qty);
  if (!isFinite(qty) || qty <= 0) return false;
  if (t.total === undefined || t.total === null) return false;
  if (typeof t.total !== 'number' && typeof t.total !== 'string') return false;
  if (String(t.total).trim() === '') return false;
  var total = Number(t.total);
  if (!isFinite(total) || total < 0) return false;
  if (typeof t.currency !== 'string' || !isValidCurrencyCode(t.currency)) return false;
  // Strict v2 membership: when the account roster is supplied, the trade
  // must name one of its accounts. Legacy v1 callers omit it (their trades
  // gain accountIds during grouping instead).
  if (accountIds !== undefined) {
    if (!Array.isArray(accountIds)) return false;
    if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
    if (accountIds.indexOf(t.accountId) === -1) return false;
  }
  return true;
}

function normalizeTradeForStore(t) {
  var c = {};
  for (var k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) c[k] = t[k]; }
  if (typeof c.symbol === 'string') c.symbol = c.symbol.trim().toUpperCase();
  if (typeof c.currency === 'string' && c.currency.trim() !== '') c.currency = c.currency.trim().toUpperCase();
  if (typeof c.feeCurrency === 'string' && c.feeCurrency.trim() !== '') c.feeCurrency = c.feeCurrency.trim().toUpperCase();
  if (typeof c.txid === 'string' && c.txid.trim() !== '') c.txid = c.txid.trim();
  return c;
}

function isValidOverrideValue(v) {
  if (typeof v === 'number') return isFinite(v) && v > 0;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    // Fiat-tagged form {price, vs}: the fiat the manual price was entered in.
    return typeof v.price === 'number' && isFinite(v.price) && v.price > 0 &&
      typeof v.vs === 'string' && /^[A-Z]{2,10}$/.test(v.vs.trim().toUpperCase());
  }
  return false;
}

function isValidPriceOverrides(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  var keys = Object.keys(v);
  for (var i = 0; i < keys.length; i++) {
    if (!isValidOverrideValue(v[keys[i]])) return false;
  }
  return true;
}

function exportState(s) {
  var st = s || {};
  var accounts = Array.isArray(st.accounts)
    ? st.accounts.filter(isValidAccount).map(normalizeAccount)
    : [];
  var accountIds = accounts.map(function (a) { return a.id; });
  var trades = Array.isArray(st.trades)
    ? st.trades.filter(function (t) { return isValidImportTrade(t, accountIds); }).map(normalizeTradeForStore)
    : [];
  var priceOverrides = {};
  if (st.priceOverrides && typeof st.priceOverrides === 'object' && !Array.isArray(st.priceOverrides) && isValidPriceOverrides(st.priceOverrides)) {
    priceOverrides = st.priceOverrides;
  }
  var envelope = {
    app: APP_ID,
    version: STORE_VERSION,
    exportedAt: new Date().toISOString(),
    settings: normalizeSettings(st.settings, defaultState().settings),
    accounts: accounts,
    trades: trades,
    priceOverrides: priceOverrides
  };
  return JSON.stringify(envelope);
}

function importState(json) {
  var data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error('import failed: invalid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('import failed: top-level object expected');
  }
  if (data.app !== APP_ID) {
    throw new Error('import failed: unknown app');
  }
  if (data.version === 1) {
    return importStateV1(data);
  }
  if (data.version !== STORE_VERSION) {
    throw new Error('import failed: unsupported version');
  }
  if (!isValidSettings(data.settings)) {
    throw new Error('import failed: invalid settings');
  }
  if (!Array.isArray(data.accounts)) {
    throw new Error('import failed: accounts must be an array');
  }
  for (var ai = 0; ai < data.accounts.length; ai++) {
    if (!isValidAccount(data.accounts[ai])) {
      throw new Error('import failed: invalid account at index ' + ai);
    }
  }
  var accountIds = data.accounts.map(function (a) { return a.id; });
  var seenIds = {};
  for (var di = 0; di < accountIds.length; di++) {
    if (Object.prototype.hasOwnProperty.call(seenIds, accountIds[di])) {
      throw new Error('import failed: duplicate account id ' + accountIds[di]);
    }
    seenIds[accountIds[di]] = true;
  }
  if (!Array.isArray(data.trades)) {
    throw new Error('import failed: trades must be an array');
  }
  for (var ti = 0; ti < data.trades.length; ti++) {
    if (!isValidImportTrade(data.trades[ti], accountIds)) {
      throw new Error('import failed: invalid trade at index ' + ti);
    }
  }
  var seenTradeIds = {};
  for (var tdi = 0; tdi < data.trades.length; tdi++) {
    var tid = data.trades[tdi] && data.trades[tdi].id;
    if (typeof tid === 'string' && tid.length > 0) {
      if (Object.prototype.hasOwnProperty.call(seenTradeIds, tid)) {
        throw new Error('import failed: duplicate trade id ' + tid);
      }
      seenTradeIds[tid] = true;
    }
  }
  var priceOverrides = {};
  if (data.priceOverrides !== undefined) {
    if (!isValidPriceOverrides(data.priceOverrides)) {
      throw new Error('import failed: invalid priceOverrides');
    }
    priceOverrides = data.priceOverrides;
  }
  // All validation passed — only now replace stored state (never partial).
  // Note: legacy files may carry settings.defaultAccountId; it is ignored.
  var normalizedSettings = normalizeSettings(data.settings, defaultState().settings);
  var mappedTrades = data.trades.map(normalizeTradeForStore);
  // Drop quotes baked in the wrong fiat by the pre-fix freezer (exact live
  // override copies) so imports never reintroduce the nominal lie.
  try { dropBakedExecLocks(mappedTrades, priceOverrides); } catch (e) { /* repair never breaks import */ }
  var next = {
    settings: normalizedSettings,
    accounts: data.accounts.map(normalizeAccount),
    trades: mappedTrades,
    priceOverrides: priceOverrides
  };
  saveState(next);
  return next;
}

// Legacy v1 file import: group v1 trades (account-less) into auto-created
// per-symbol accounts. No legacy runtime paths — v1 is never read from
// localStorage, only accepted here.
function importStateV1(data) {
  if (!isValidSettings(data.settings)) {
    throw new Error('import failed: invalid settings');
  }
  if (!Array.isArray(data.trades)) {
    throw new Error('import failed: trades must be an array');
  }
  for (var ti = 0; ti < data.trades.length; ti++) {
    if (!isValidImportTrade(data.trades[ti])) {
      throw new Error('import failed: invalid trade at index ' + ti);
    }
  }
  var priceOverrides = {};
  if (data.priceOverrides !== undefined) {
    if (!isValidPriceOverrides(data.priceOverrides)) {
      throw new Error('import failed: invalid priceOverrides');
    }
    priceOverrides = data.priceOverrides;
  }
  var accounts = [];
  var bySymbol = {};
  var trades = data.trades.map(function (t) {
    var sym = String(t.symbol).trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(bySymbol, sym)) {
      var acc = { id: uid(), name: sym, ticker: sym, kind: 'crypto', createdAt: new Date().toISOString() };
      bySymbol[sym] = acc;
      accounts.push(acc);
    }
    var copy = {};
    for (var k in t) {
      if (Object.prototype.hasOwnProperty.call(t, k)) copy[k] = t[k];
    }
    copy.symbol = sym;
    copy.accountId = bySymbol[sym].id;
    return normalizeTradeForStore(copy);
  });
  // Membership holds by construction; re-check via the extended validator
  // so a grouping bug can never silently persist a dangling trade.
  var accountIds = accounts.map(function (a) { return a.id; });
  for (var vi = 0; vi < trades.length; vi++) {
    if (!isValidImportTrade(trades[vi], accountIds)) {
      throw new Error('import failed: invalid trade at index ' + vi);
    }
  }
  var next = {
    settings: {
      mainCurrency: data.settings.mainCurrency,
      costMethod: data.settings.costMethod
    },
    accounts: accounts,
    trades: trades,
    priceOverrides: priceOverrides
  };
  saveState(next);
  return next;
}

function accountById(st, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  var list = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

// Expose pure functions for tests.html via window.Inoculens.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.loadState = loadState;
  window.Inoculens.saveState = saveState;
  window.Inoculens.exportState = exportState;
  window.Inoculens.importState = importState;
  window.Inoculens.defaultState = defaultState;
  window.Inoculens.accountById = accountById;
}

// === Fx ===
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
var FX_BASE_URL = 'https://api.frankfurter.dev/v1';

function stableToUsd(ccy) {
  if (typeof ccy !== 'string') return false;
  return FX_STABLES.indexOf(ccy.toUpperCase()) !== -1;
}

function normalizeToMain(total, fee, rate) {
  return (Number(total) + Number(fee)) * Number(rate);
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
      if (isFinite(rate)) {
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
  // tests.html stubs (or later restores) cannot clobber retry/walkBack fetches.
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  function attempt(d, back) {
    if (!d || !isValidDateStr(d)) return Promise.reject(new Error('fx-unavailable'));
    var url = FX_BASE_URL + '/' + d +
      '?from=' + encodeURIComponent(effFrom) + '&to=' + encodeURIComponent(effTo);
    function walkBack() {
      if (back >= FX_MAX_LOOKBACK_DAYS) throw new Error('fx-unavailable');
      var prev = fxShiftDate(d, -1);
      if (!prev) throw new Error('fx-unavailable');
      return attempt(prev, back + 1);
    }
    return fxFetchWithRetry(url, capturedFetch).then(
      function (data) {
        var rate = data && data.rates && data.rates[effTo];
        if (typeof rate === 'number' && isFinite(rate) && rate > 0) {
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
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(FXCACHE_KEY);
  } catch (e) { /* ignore */ }
}

function getCachedRate(date, from, to) {
  var f = String(from || '').toUpperCase();
  var t = String(to || '').toUpperCase();
  if (!f || !t) return null;
  if (f === t || (stableToUsd(f) && stableToUsd(t))) return { rate: 1, source: '1:1' };
  var cache = loadFxCache();
  var hit = cache[fxCacheKey(date, f, t)];
  if (hit && isFinite(Number(hit.rate)) && Number(hit.rate) > 0 && typeof hit.source === 'string') {
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

// Distinct (date, currency) pairs across trades that still need a rate
// into `main`. Same-currency needs nothing (rate 1, no network). One fiat
// per trade: only the trade currency (plus frozen exec / tagged override
// fiats, which ride the same pair when they match) ever needs converting.
function displayPairs(trades, main) {
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
  (trades || []).forEach(function (t) {
    if (!t) return;
    var c = (typeof t.currency === 'string') ? t.currency.toUpperCase() : '';
    var d = (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) ? t.date.slice(0, 10) : '';
    if (!c || !d) return;
    need(d, c);
    // Frozen exec quote in another fiat needs its own historical rate to
    // render in the current main (deduped by `seen` when it matches a leg).
    // Same for a fiat-tagged manual override (Exec falls back to it).
    if (t.type === 'buy' || t.type === 'sell') {
      var fr = null;
      try { fr = frozenExecOf(t); } catch (e) { fr = null; }
      if (fr && fr.vs && fr.vs !== m) need(d, fr.vs);
      var oe = null;
      try { oe = priceOverrideEntry(t.symbol); } catch (e) { oe = null; }
      if (oe && oe.vs && oe.vs !== m) need(d, oe.vs);
    }
  });
  return out;
}

// Fill the cache for every pair the current paint needs. Never rejects:
// a failed pair keeps its stored fxLock (degraded display, corrected later).
function ensureDisplayRates(trades, main) {
  var m = String(main || '').toUpperCase();
  var pairs = displayPairs(trades, m);
  if (!pairs.length) return Promise.resolve(false);
  return Promise.all(pairs.map(function (p) {
    return fetchEcbRate(p.date, p.from, m).then(function (r) {
      cacheRate(p.date, p.from, m, r.rate, r.source);
      return true;
    }, function () { return false; });
  })).then(function (flags) {
    var changed = false;
    flags.forEach(function (f) { if (f) changed = true; });
    if (changed) saveFxCache();
    return changed;
  });
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
  // Total leg.
  if (c === m) {
    clone().fxLock = { pair: c + '/' + m, rate: 1, source: '1:1', interpolated: false };
  } else {
    var tl = lockFor(c);
    if (tl) clone().fxLock = tl;
    // No cached rate yet: keep the stored lock (corrected on re-render).
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

// Expose Fx on window.Inoculens for tests.html, Ledger (Task 4), Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.fetchEcbRate = fetchEcbRate;
  window.Inoculens.stableToUsd = stableToUsd;
  window.Inoculens.normalizeToMain = normalizeToMain;
  window.Inoculens.pickRate = pickRate;
  window.Inoculens.convertTrade = convertTrade;
  window.Inoculens.convertTrades = convertTrades;
  window.Inoculens.displayPairs = displayPairs;
  window.Inoculens.ensureDisplayRates = ensureDisplayRates;
  window.Inoculens.getCachedRate = getCachedRate;
  window.Inoculens.cacheRate = cacheRate;
  window.Inoculens.clearFxCache = clearFxCache;
  window.Inoculens.reloadFxCache = function () { loadFxCache(true); };
}

// === Ledger ===
// Pure cost-basis engine: normalizeTrade + average-cost + FIFO + positions +
// validation. No DOM, no network, no storage. All main-currency conversion
// uses the trade's frozen fxLock.rate (Task 3). Read by Ui (Task 6) via
// computePositions / validateTrade.
//
// Fee economics (all-in model): one fiat per trade — the fee is always
// denominated in the trade currency, so cost counts the FULL total (50 EUR
// in, 0.00058193 BTC out => entry 50/qty, e.g. 85920.99 — the fee simply
// lifts the calculated price, never a separate loss). Fees ride along as
// display-only info (feesFiat/fees sums + "Total fees paid" line); they never
// touch Realized, Unrealized or Total P&L. fee:0 behaves exactly as before.
// Sells book gross proceeds (total, no fee subtraction) for the same reason.

function ledgerFxRate(lock) {
  var r = lock ? Number(lock.rate) : NaN;
  return (isFinite(r) && r > 0) ? r : 1;
}

function normalizeTrade(t) {
  t = t || {};
  var rate = ledgerFxRate(t.fxLock);
  var totalRaw = (t.total === '' || t.total === null || t.total === undefined) ? 0 : Number(t.total);
  var feeRaw = (t.fee === '' || t.fee === null || t.fee === undefined) ? 0 : Number(t.fee);
  var totalMain = (isFinite(totalRaw) && totalRaw >= 0 ? totalRaw : 0) * rate;
  var fee = (isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : 0);
  var out = { totalMain: totalMain, feeMain: fee * rate };
  // All-in cost: the stated total already includes the fee (one fiat per
  // trade), so cost IS the full total. feeLossMain stays 0 — kept only so
  // old stored shapes keep working.
  out.netMain = totalMain;
  out.feeLossMain = 0;
  return out;
}

function ledgerSortByDate(trades) {
  return (trades || []).slice().sort(function (a, b) {
    var da = (a && typeof a.date === 'string') ? a.date : '';
    var db = (b && typeof b.date === 'string') ? b.date : '';
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });
}

function ledgerHoldingDays(openDate, closeDate) {
  function toUtc(d) {
    if (!isValidDateStr(d)) return null;
    var p = d.slice(0, 10).split('-');
    var t = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return isFinite(t) ? t : null;
  }
  var a = toUtc(openDate);
  var b = toUtc(closeDate);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / 86400000);
}

var LEDGER_EPS = 1e-9;

function ledgerSym(t) {
  return String((t && t.symbol) || '').trim().toUpperCase();
}

function computeAverage(trades) {
  var bySym = new Map();
  var list = ledgerSortByDate(trades);
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var sym = ledgerSym(t);
    if (!sym) continue;
    var n = normalizeTrade(t);
    if (t.type === 'buy' || t.type === 'income') {
      var qbi = Number(t.qty);
      if (!isFinite(qbi) || qbi <= 0) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var ebi = bySym.get(sym);
      ebi.qty += qbi;
      ebi.cost += n.netMain; // all-in cost (fee already inside the price)
      ebi.fees = (ebi.fees || 0) + n.feeMain; // display-only info
    } else if (t.type === 'sell') {
      var qs = Number(t.qty);
      if (!isFinite(qs) || qs <= 0) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var e = bySym.get(sym);
      if (e.qty <= LEDGER_EPS) continue; // no inventory: ignore, never negative
      var sellQty = Math.min(qs, e.qty);
      var avg = e.qty > 0 ? e.cost / e.qty : 0;
      // Gross proceeds: fees are already baked into the buy price, so sells
      // book the full total (display-only fee line, zero P&L drag).
      var proceeds = n.totalMain;
      e.fees = (e.fees || 0) + n.feeMain;
      if (qs > e.qty && qs > 0) proceeds = proceeds * (sellQty / qs);
      e.realized += proceeds - avg * sellQty;
      e.cost -= avg * sellQty;
      e.qty -= sellQty;
      if (Math.abs(e.qty) < LEDGER_EPS) { e.qty = 0; e.cost = 0; } // kill float dust
    } else if (t.type === 'expense') {
      var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
      var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
      var qe = hasQ ? Number(t.qty) : 0;
      if (hasQ && (!isFinite(qe) || qe <= 0)) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var ee = bySym.get(sym);
      if (hasQ) {
        if (ee.qty > LEDGER_EPS) {
          var rq = Math.min(qe, ee.qty);
          var aqe = ee.qty > 0 ? ee.cost / ee.qty : 0;
          var cRem = aqe * rq;
          ee.realized -= cRem; // crypto lost: proceeds 0 minus cost
          ee.cost -= cRem;
          ee.qty -= rq;
          if (Math.abs(ee.qty) < LEDGER_EPS) { ee.qty = 0; ee.cost = 0; }
        }
      }
      if (hasT || (n.feeMain > 0)) {
        ee.realized -= n.netMain; // all-in cash lost (fee already in the price)
        ee.fees = (ee.fees || 0) + n.feeMain;
      }
    } else if (t.type === 'transfer') {
      var qt = Number(t.qty);
      if (!isFinite(qt) || qt <= 0) continue;
      var nft = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (!isFinite(nft) || nft < 0 || nft >= qt) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var et = bySym.get(sym);
      var fiatT = n.netMain; // all-in fiat cost (display-only fee, no drag)
      et.fees = (et.fees || 0) + n.feeMain;
      if (et.qty <= LEDGER_EPS) {
        // no inventory: cannot move, but fiat fee still lost
        if (fiatT > 0) et.realized -= fiatT;
        continue;
      }
      var tQty = Math.min(qt, et.qty);
      var scaleT = qt > 0 ? tQty / qt : 0;
      var feeQtyT = nft * scaleT;
      var avgT = et.qty > 0 ? et.cost / et.qty : 0;
      var feeCostT = avgT * feeQtyT;
      et.qty -= feeQtyT; // net movement is -fee (out+in cancel except fee)
      et.cost -= feeCostT;
      et.realized -= feeCostT + fiatT; // on-chain loss + fiat fee are real losses
      if (Math.abs(et.qty) < LEDGER_EPS) { et.qty = 0; et.cost = 0; }
    }
  }
  bySym.forEach(function (e) {
    e.avgEntry = e.qty > LEDGER_EPS ? e.cost / e.qty : 0;
    if (Math.abs(e.qty) < LEDGER_EPS) { e.qty = 0; e.cost = 0; }
  });
  return bySym;
}

function computeFifo(trades) {
  var queues = new Map(); // sym -> [{qty, unitCost, date}]
  var acc = new Map(); // sym -> {realized, lots}
  var list = ledgerSortByDate(trades);
  function state(sym) {
    if (!acc.has(sym)) acc.set(sym, { realized: 0, lots: [], fees: 0, feeDrag: 0 });
    if (!queues.has(sym)) queues.set(sym, []);
    return acc.get(sym);
  }
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var sym = ledgerSym(t);
    if (!sym) continue;
    var n = normalizeTrade(t);
    var st = state(sym);
    var q = queues.get(sym);
    if (t.type === 'buy' || t.type === 'income') {
      var qb = Number(t.qty);
      if (!isFinite(qb) || qb <= 0) continue;
      q.push({ qty: qb, unitCost: qb > 0 ? n.netMain / qb : 0, date: t.date }); // all-in unit cost
      st.fees = (st.fees || 0) + n.feeMain; // display-only
    } else if (t.type === 'sell') {
      var qty = Number(t.qty);
      if (!isFinite(qty) || qty <= 0) continue;
      var heldFifo = q.reduce(function (s, l) { return s + l.qty; }, 0);
      if (heldFifo <= LEDGER_EPS) continue; // no inventory: ignore, never negative
      // Gross proceeds — fees live inside the buy price, never as sell drag.
      var proceedsTotal = n.totalMain;
      st.fees = (st.fees || 0) + n.feeMain;
      var unitProceeds = qty > 0 ? proceedsTotal / qty : 0;
      var sellQty = Math.min(qty, heldFifo);
      // Scale proceeds when the sell is clamped (oversell ignored, no negative).
      if (qty > sellQty && qty > 0) unitProceeds = (proceedsTotal * (sellQty / qty)) / (sellQty || 1);
      var left = sellQty;
      while (left > LEDGER_EPS && q.length > 0) {
        var lot = q[0];
        var take = Math.min(lot.qty, left);
        var proceeds = take * unitProceeds;
        var cost = take * lot.unitCost;
        st.lots.push({
          openDate: lot.date,
          closeDate: t.date,
          qty: take,
          proceeds: proceeds,
          cost: cost,
          gain: proceeds - cost,
          holdingDays: ledgerHoldingDays(lot.date, t.date)
        });
        st.realized += proceeds - cost;
        lot.qty -= take;
        left -= take;
        if (lot.qty <= LEDGER_EPS) q.shift();
      }
    } else if (t.type === 'expense') {
      var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
      var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
      if (hasQ) {
        var qe = Number(t.qty);
        if (!isFinite(qe) || qe <= 0) continue;
        var heldE = q.reduce(function (s, l) { return s + l.qty; }, 0);
        if (heldE > LEDGER_EPS) {
          var rq = Math.min(qe, heldE);
          var leftE = rq;
          while (leftE > LEDGER_EPS && q.length > 0) {
            var lote = q[0];
            var takeE = Math.min(lote.qty, leftE);
            var costE = takeE * lote.unitCost;
            st.lots.push({
              openDate: lote.date,
              closeDate: t.date,
              qty: takeE,
              proceeds: 0,
              cost: costE,
              gain: -costE,
              holdingDays: ledgerHoldingDays(lote.date, t.date)
            });
            st.realized -= costE;
            lote.qty -= takeE;
            leftE -= takeE;
            if (lote.qty <= LEDGER_EPS) q.shift();
          }
        }
      }
      if (hasT || n.feeMain > 0) {
        st.realized -= n.netMain; // all-in cash lost
        st.fees = (st.fees || 0) + n.feeMain;
      }
    } else if (t.type === 'transfer') {
      var qt = Number(t.qty);
      if (!isFinite(qt) || qt <= 0) continue;
      var nft = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (!isFinite(nft) || nft < 0 || nft >= qt) continue;
      var fiatT = n.netMain; // all-in fiat cost
      st.fees = (st.fees || 0) + n.feeMain;
      var heldT = q.reduce(function (s, l) { return s + l.qty; }, 0);
      if (heldT <= LEDGER_EPS) {
        if (fiatT > 0) st.realized -= fiatT;
        continue;
      }
      var tQty = Math.min(qt, heldT);
      var scaleT = qt > 0 ? tQty / qt : 0;
      var feeQtyT = nft * scaleT;
      // Remove gross qty oldest-first, then treat fee slice as expense.
      var removed = [];
      var leftT = tQty;
      while (leftT > LEDGER_EPS && q.length > 0) {
        var lotT = q[0];
        var takeT = Math.min(lotT.qty, leftT);
        removed.push({ qty: takeT, unitCost: lotT.unitCost, openDate: lotT.date });
        lotT.qty -= takeT;
        leftT -= takeT;
        if (lotT.qty <= LEDGER_EPS) q.shift();
      }
      var costOutT = removed.reduce(function (s, l) { return s + l.qty * l.unitCost; }, 0);
      var feeCostT = tQty > 0 ? costOutT * (feeQtyT / tQty) : 0;
      // Record the on-chain fee slice as loss lots (proportional across removed lots).
      if (feeQtyT > LEDGER_EPS && tQty > 0) {
        for (var ri = 0; ri < removed.length; ri++) {
          var rl = removed[ri];
          var ft = rl.qty * (feeQtyT / tQty);
          if (ft <= LEDGER_EPS) continue;
          var fc = ft * rl.unitCost;
          st.lots.push({
            openDate: rl.openDate,
            closeDate: t.date,
            qty: ft,
            proceeds: 0,
            cost: fc,
            gain: -fc,
            holdingDays: ledgerHoldingDays(rl.openDate, t.date)
          });
        }
      }
      st.realized -= feeCostT + fiatT;
      // qty/cost net: gross removed, nothing re-added globally (in+out cancel except fee already accounted via qty reduction below).
      // Re-add net? No: globally out+in cancel, leaving -feeQty. Queues already removed gross; re-add net portion with original lots scaled.
      var netQtyT = tQty - feeQtyT;
      if (netQtyT > LEDGER_EPS && tQty > 0) {
        for (var ni = 0; ni < removed.length; ni++) {
          var ol = removed[ni];
          var keep = ol.qty * (netQtyT / tQty);
          if (keep > LEDGER_EPS) q.push({ qty: keep, unitCost: ol.unitCost, date: ol.openDate });
        }
        // Keep FIFO order stable: moved lots go to back (they are still oldest economically, but queue order preserved by re-append; sort by date to keep oldest-first).
        q.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; });
      }
      // Fix double-count: we removed gross then re-added net, net qty change = -feeQty, net cost change = -feeCost. Queues now reflect that (removed gross, added net). Realized already includes -feeCost-fiat. Good.
      // Recompute: queues currently = old - gross + net = old - fee. Correct.
    }
  }
  var out = new Map();
  acc.forEach(function (st, sym) {
    var q = queues.get(sym) || [];
    var qty = 0;
    var cost = 0;
    for (var k = 0; k < q.length; k++) { qty += q[k].qty; cost += q[k].qty * q[k].unitCost; }
    out.set(sym, {
      qty: qty,
      avgEntry: qty > 0 ? cost / qty : 0, // all-in Real price
      realized: st.realized,
      lots: st.lots,
      fees: st.fees || 0, // display-only info
      feeDrag: 0
    });
  });
  // Symbols with buys only are in queues but maybe not acc; ensure presence.
  queues.forEach(function (q, sym) {
    if (out.has(sym)) return;
    var qty = 0;
    var cost = 0;
    for (var k = 0; k < q.length; k++) { qty += q[k].qty; cost += q[k].qty * q[k].unitCost; }
    out.set(sym, { qty: qty, avgEntry: qty > 0 ? cost / qty : 0, realized: 0, lots: [], fees: 0, feeDrag: 0 });
  });
  return out;
}

function computePositions(trades, live, method) {
  var engine = method === 'fifo' ? computeFifo(trades) : computeAverage(trades);
  var buyCost = {}; // sym -> lifetime all-in buy+income cost (denominator for returnPct)
  var hasBuy = {};
  (trades || []).forEach(function (t) {
    if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
    var sym = ledgerSym(t);
    if (!sym) return;
    var qty = Number(t.qty);
    if (!isFinite(qty) || qty <= 0) return;
    var n = normalizeTrade(t);
    buyCost[sym] = (buyCost[sym] || 0) + n.netMain; // all-in (fee already inside)
    hasBuy[sym] = true;
  });
  var rows = [];
  engine.forEach(function (v, sym) {
    if (!hasBuy[sym] && !(v.qty > LEDGER_EPS) && !(Math.abs(v.realized || 0) > LEDGER_EPS)) return; // skip phantom sell-only rows
    // Unknown live price stays unknown (null) — never coerced to 0, which
    // fabricated a full loss (value 0, unrealized -cost, return -100%).
    var lookup = String(sym).toUpperCase();
    var raw = live ? (live[sym] !== undefined ? live[sym] : live[lookup]) : undefined;
    var num = Number(raw);
    var known = isFinite(num) && num > 0;
    var livePrice = known ? num : null;
    var qtyHeld = v.qty || 0;
    if (Math.abs(qtyHeld) < LEDGER_EPS) qtyHeld = 0;
    var avgEntry = v.avgEntry || 0;
    var marketValue = known ? qtyHeld * num : (qtyHeld === 0 ? 0 : null);
    var unrealized = marketValue === null ? null : marketValue - avgEntry * qtyHeld;
    var realized = v.realized || 0;
    var totalPL = unrealized === null ? realized : unrealized + realized; // fees display-only, zero drag
    var denom = buyCost[sym] || 0;
    var returnPct = denom > LEDGER_EPS
      ? (unrealized === null ? (qtyHeld === 0 ? (realized / denom) * 100 : null) : (totalPL / denom) * 100)
      : null;
    rows.push({
      symbol: sym,
      qtyHeld: qtyHeld,
      avgEntry: avgEntry,
      livePrice: livePrice,
      marketValue: marketValue,
      unrealized: unrealized,
      realized: realized,
      fees: v.fees || 0, // display-only info ("Total fees paid" line)
      feeDrag: 0,
      totalPL: totalPL,
      returnPct: returnPct
    });
  });
  rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  return rows;
}

// --- Joint per-account portfolio engine (transfers move basis between accounts) ---
// Processes ALL trades once in date order, keeping separate cost queues per
// (accountId, symbol). Transfers move cost/lots from source to dest at the
// source's basis (no P&L except network + fiat fees, which are real losses).
// Returns { byAccount: {accId: Map(sym->pos)}, analytics, lots }.
// Positions use the same live-price unknown rules as computePositions.
function computePortfolio(allTrades, live, method) {
  var isFifo = method === 'fifo';
  var sorted = ledgerSortByDate(allTrades || []);
  var acctState = {}; // accId -> sym -> {qty,cost,realized,income,fees,fiatFees,queue,lots}
  function stFor(accId, sym) {
    var a = acctState[accId];
    if (!a) { a = {}; acctState[accId] = a; }
    var s = a[sym];
    if (!s) {
      s = { qty: 0, cost: 0, realized: 0, income: 0, fees: 0, feeDrag: 0, lots: [], queue: [], touched: false };
      a[sym] = s;
    }
    return s;
  }
  var totals = { invested: 0, withdrawn: 0, income: 0, incomeQty: 0, feesFiat: 0, feesCryptoQty: 0, feesCryptoMain: 0, expensesFiat: 0, realized: 0, feeDrag: 0 };
  function avgOf(s) { return s.qty > LEDGER_EPS ? s.cost / s.qty : 0; }
  sorted.forEach(function (t) {
    if (!t) return;
    var sym = ledgerSym(t);
    if (!sym) return;
    var n = normalizeTrade(t);
    if (t.type === 'buy') {
      var qb = Number(t.qty);
      if (!isFinite(qb) || qb <= 0) return;
      var sb = stFor(t.accountId, sym);
      sb.touched = true;
      sb.qty += qb;
      var cb = n.netMain; // all-in (fee already inside the price)
      sb.cost += cb;
      sb.fees += n.feeMain; // display-only
      totals.invested += n.netMain;
      totals.feesFiat += n.feeMain;
      if (isFifo) sb.queue.push({ qty: qb, unitCost: qb > 0 ? cb / qb : 0, date: t.date });
    } else if (t.type === 'income') {
      var qi = Number(t.qty);
      if (!isFinite(qi) || qi <= 0) return;
      var si = stFor(t.accountId, sym);
      si.touched = true;
      si.qty += qi;
      var ci = n.netMain; // all-in
      si.cost += ci;
      si.income += n.totalMain;
      si.fees += n.feeMain; // display-only
      totals.income += n.totalMain;
      totals.incomeQty += qi;
      totals.feesFiat += n.feeMain;
      if (isFifo) si.queue.push({ qty: qi, unitCost: qi > 0 ? ci / qi : 0, date: t.date });
    } else if (t.type === 'sell') {
      var qs = Number(t.qty);
      if (!isFinite(qs) || qs <= 0) return;
      var ss = stFor(t.accountId, sym);
      if (ss.qty <= LEDGER_EPS && (!isFifo || ss.queue.reduce(function (s, l) { return s + l.qty; }, 0) <= LEDGER_EPS)) return;
      ss.touched = true;
      // Gross proceeds (fees live inside the buy price, never as sell drag).
      var proceeds = n.totalMain;
      if (isFifo) {
        var heldF = ss.queue.reduce(function (s, l) { return s + l.qty; }, 0);
        var sQty = Math.min(qs, heldF);
        if (qs > heldF && qs > 0) proceeds = proceeds * (sQty / qs);
        var unitP = sQty > 0 ? proceeds / sQty : 0;
        // also mirror qty/cost for avg view consistency
        var left = sQty;
        while (left > LEDGER_EPS && ss.queue.length) {
          var lot = ss.queue[0];
          var take = Math.min(lot.qty, left);
          var pc = take * unitP;
          var cc = take * lot.unitCost;
          ss.lots.push({ openDate: lot.date, closeDate: t.date, qty: take, proceeds: pc, cost: cc, gain: pc - cc, holdingDays: ledgerHoldingDays(lot.date, t.date), accountId: t.accountId, symbol: sym });
          ss.realized += pc - cc;
          totals.realized += pc - cc;
          lot.qty -= take;
          left -= take;
          if (lot.qty <= LEDGER_EPS) ss.queue.shift();
        }
        ss.qty -= sQty;
        // cost derived from queue; recompute for avg field
        var rc = 0, rq = 0;
        ss.queue.forEach(function (l) { rq += l.qty; rc += l.qty * l.unitCost; });
        ss.cost = rc;
        if (Math.abs(ss.qty) < LEDGER_EPS && Math.abs(rq) < LEDGER_EPS) { ss.qty = 0; ss.cost = 0; }
        else ss.qty = rq;
        totals.withdrawn += proceeds;
        totals.feesFiat += n.feeMain;
        ss.fees += n.feeMain;
      } else {
        var sQty2 = Math.min(qs, ss.qty);
        if (qs > ss.qty && qs > 0) proceeds = proceeds * (sQty2 / qs);
        var a2 = avgOf(ss);
        ss.realized += proceeds - a2 * sQty2;
        totals.realized += proceeds - a2 * sQty2;
        ss.cost -= a2 * sQty2;
        ss.qty -= sQty2;
        if (Math.abs(ss.qty) < LEDGER_EPS) { ss.qty = 0; ss.cost = 0; }
        totals.withdrawn += proceeds;
        totals.feesFiat += n.feeMain;
        ss.fees += n.feeMain;
      }
    } else if (t.type === 'expense') {
      var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
      var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
      if (!hasQ && !hasT) return;
      var se = stFor(t.accountId, sym);
      se.touched = true;
      if (hasQ) {
        var qe = Number(t.qty);
        if (isFinite(qe) && qe > 0) {
          if (isFifo) {
            var heldE = se.queue.reduce(function (s, l) { return s + l.qty; }, 0);
            var rqE = Math.min(qe, heldE);
            var lE = rqE;
            while (lE > LEDGER_EPS && se.queue.length) {
              var le2 = se.queue[0];
              var tk = Math.min(le2.qty, lE);
              var ce2 = tk * le2.unitCost;
              se.lots.push({ openDate: le2.date, closeDate: t.date, qty: tk, proceeds: 0, cost: ce2, gain: -ce2, holdingDays: ledgerHoldingDays(le2.date, t.date), accountId: t.accountId, symbol: sym, kind: 'expense' });
              se.realized -= ce2;
              totals.realized -= ce2;
              totals.feesCryptoMain += ce2;
              totals.feesCryptoQty += tk;
              le2.qty -= tk;
              lE -= tk;
              if (le2.qty <= LEDGER_EPS) se.queue.shift();
            }
            var rq2 = 0, rc2 = 0;
            se.queue.forEach(function (l) { rq2 += l.qty; rc2 += l.qty * l.unitCost; });
            se.qty = rq2; se.cost = rc2;
          } else if (se.qty > LEDGER_EPS) {
            var rqe = Math.min(qe, se.qty);
            var ae = avgOf(se);
            var cre = ae * rqe;
            se.realized -= cre;
            totals.realized -= cre;
            totals.feesCryptoMain += cre;
            totals.feesCryptoQty += rqe;
            se.cost -= cre;
            se.qty -= rqe;
            if (Math.abs(se.qty) < LEDGER_EPS) { se.qty = 0; se.cost = 0; }
          }
        }
      }
      if (hasT || n.feeMain > 0) {
        var fl = n.netMain; // all-in cash lost
        se.realized -= n.netMain;
        totals.realized -= n.netMain;
        totals.expensesFiat += fl;
        totals.feesFiat += n.feeMain;
        se.fees += n.feeMain;
      }
    } else if (t.type === 'transfer') {
      var qt = Number(t.qty);
      if (!isFinite(qt) || qt <= 0) return;
      var nft = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (!isFinite(nft) || nft < 0 || nft >= qt) return;
      var from = stFor(t.accountId, sym);
      // No destination: on-chain move inside the same account (fresh address,
      // same owner) — out and in cancel, only the network fee is lost.
      var to = (t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '')
        ? stFor(t.toAccountId, sym)
        : from;
      from.touched = true;
      to.touched = true;
      var fiatT = n.netMain; // all-in fiat cost (fee display-only)
      if (isFifo) {
        var heldT = from.queue.reduce(function (s, l) { return s + l.qty; }, 0);
        if (heldT <= LEDGER_EPS) {
          if (fiatT > 0) { from.realized -= fiatT; totals.realized -= fiatT; totals.expensesFiat += fiatT; totals.feesFiat += n.feeMain; }
          return;
        }
        var tQty = Math.min(qt, heldT);
        var sc = qt > 0 ? tQty / qt : 0;
        var feeQ = nft * sc;
        var removed = [];
        var lt = tQty;
        while (lt > LEDGER_EPS && from.queue.length) {
          var ltf = from.queue[0];
          var tkf = Math.min(ltf.qty, lt);
          removed.push({ qty: tkf, unitCost: ltf.unitCost, openDate: ltf.date });
          ltf.qty -= tkf;
          lt -= tkf;
          if (ltf.qty <= LEDGER_EPS) from.queue.shift();
        }
        var costOut = removed.reduce(function (s, l) { return s + l.qty * l.unitCost; }, 0);
        var feeC = tQty > 0 ? costOut * (feeQ / tQty) : 0;
        if (feeQ > LEDGER_EPS && tQty > 0) {
          removed.forEach(function (rl) {
            var fsh = rl.qty * (feeQ / tQty);
            if (fsh <= LEDGER_EPS) return;
            var fco = fsh * rl.unitCost;
            from.lots.push({ openDate: rl.openDate, closeDate: t.date, qty: fsh, proceeds: 0, cost: fco, gain: -fco, holdingDays: ledgerHoldingDays(rl.openDate, t.date), accountId: t.accountId, symbol: sym, kind: 'network-fee' });
          });
        }
        from.realized -= feeC + fiatT;
        totals.realized -= feeC + fiatT;
        totals.feesCryptoMain += feeC;
        totals.feesCryptoQty += feeQ;
        totals.expensesFiat += fiatT;
        totals.feesFiat += n.feeMain;
        from.fees += n.feeMain;
        var frq = 0, frc = 0;
        from.queue.forEach(function (l) { frq += l.qty; frc += l.qty * l.unitCost; });
        from.qty = frq; from.cost = frc;
        var netQ = tQty - feeQ;
        if (netQ > LEDGER_EPS && tQty > 0) {
          removed.forEach(function (rl) {
            var keep = rl.qty * (netQ / tQty);
            if (keep > LEDGER_EPS) to.queue.push({ qty: keep, unitCost: rl.unitCost, date: rl.openDate });
          });
          to.queue.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; });
          var trq = 0, trc = 0;
          to.queue.forEach(function (l) { trq += l.qty; trc += l.qty * l.unitCost; });
          to.qty = trq; to.cost = trc;
        }
      } else {
        if (from.qty <= LEDGER_EPS) {
          if (fiatT > 0) { from.realized -= fiatT; totals.realized -= fiatT; totals.expensesFiat += fiatT; totals.feesFiat += n.feeMain; }
          return;
        }
        var tQ2 = Math.min(qt, from.qty);
        var sc2 = qt > 0 ? tQ2 / qt : 0;
        var feeQ2 = nft * sc2;
        var aF = avgOf(from);
        var costO = aF * tQ2;
        var feeC2 = aF * feeQ2;
        var moved = costO - feeC2;
        from.qty -= tQ2;
        from.cost -= costO;
        if (Math.abs(from.qty) < LEDGER_EPS) { from.qty = 0; from.cost = 0; }
        from.realized -= feeC2 + fiatT;
        totals.realized -= feeC2 + fiatT;
        totals.feesCryptoMain += feeC2;
        totals.feesCryptoQty += feeQ2;
        totals.expensesFiat += fiatT;
        totals.feesFiat += n.feeMain;
        from.fees += n.feeMain;
        var netQ2 = tQ2 - feeQ2;
        to.qty += netQ2;
        to.cost += moved;
      }
    }
  });
  // Build per-account position maps with live prices.
  var byAccount = {};
  Object.keys(acctState).forEach(function (accId) {
    var m = new Map();
    var syms = acctState[accId];
    Object.keys(syms).forEach(function (sym) {
      var s = syms[sym];
      if (!s.touched) return; // never active: drop phantom (e.g. sell-only with no inventory)
      var lookup = String(sym).toUpperCase();
      var raw = live ? (live[sym] !== undefined ? live[sym] : live[lookup]) : undefined;
      var num = Number(raw);
      var known = isFinite(num) && num > 0;
      var qtyHeld = Math.abs(s.qty) < LEDGER_EPS ? 0 : s.qty;
      var avgEntry = qtyHeld > 0 ? s.cost / qtyHeld : 0;
      var mv = known ? qtyHeld * num : (qtyHeld === 0 ? 0 : null);
      var un = mv === null ? null : mv - avgEntry * qtyHeld;
      m.set(sym, {
        symbol: sym, qtyHeld: qtyHeld, avgEntry: avgEntry,
        livePrice: known ? num : null, marketValue: mv, unrealized: un,
        realized: s.realized, totalPL: un === null ? s.realized : un + s.realized, // fees display-only
        income: s.income, fees: s.fees, lots: s.lots
      });
    });
    byAccount[accId] = m;
  });
  return { byAccount: byAccount, totals: totals, states: acctState };
}

function computeAnalytics(allTrades, live, method) {
  var pf = computePortfolio(allTrades, live, method);
  var mv = 0, un = 0, rz = pf.totals.realized, mvKnown = false, unKnown = false;
  var accIds = Object.keys(pf.byAccount);
  accIds.forEach(function (id) {
    pf.byAccount[id].forEach(function (p) {
      if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
      if (p.unrealized !== null) { un += p.unrealized; unKnown = true; }
    });
  });
  var feesTotal = (pf.totals.feesFiat || 0) + (pf.totals.feesCryptoMain || 0) + (pf.totals.expensesFiat || 0);
  var baseTpl = (unKnown || Math.abs(rz) > LEDGER_EPS) ? (unKnown ? un + rz : rz) : rz;
  return {
    marketValue: mvKnown ? mv : null,
    unrealized: unKnown ? un : null,
    realized: rz,
    totalPL: baseTpl, // fees display-only ("Total fees paid" line), zero drag
    feeDrag: 0,
    invested: pf.totals.invested,
    withdrawn: pf.totals.withdrawn,
    income: pf.totals.income,
    feesFiat: pf.totals.feesFiat,
    feesCryptoQty: pf.totals.feesCryptoQty,
    feesCryptoMain: pf.totals.feesCryptoMain,
    expensesFiat: pf.totals.expensesFiat,
    feesTotal: feesTotal,
    byAccount: pf.byAccount,
    totals: pf.totals
  };
}

function heldForAccount(allTrades, accountId, symbol) {
  var sym = String(symbol || '').toUpperCase();
  var pf = computePortfolio(allTrades || [], {}, 'average');
  var m = pf.byAccount[accountId];
  if (!m) return 0;
  var p = m.get(sym) || m.get(symbol);
  if (!p) {
    // fallback: try case-insensitive scan
    var found = 0;
    m.forEach(function (v, k) { if (String(k).toUpperCase() === sym) found = v.qtyHeld; });
    return found;
  }
  return p.qtyHeld;
}

function validateTrade(t, heldQty) {
  t = t || {};
  var type = t.type;
  if (type !== undefined && TRADE_TYPES.indexOf(type) === -1) {
    return 'type must be buy, sell, transfer, income or expense';
  }
  var effType = type || 'buy';
  if (effType === 'expense') {
    var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
    var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
    if (!hasQ && !hasT) return 'expense needs qty or total';
    if (hasQ) {
      var qex = Number(t.qty);
      if (!isFinite(qex) || qex <= 0) return 'qty must be > 0';
      if (typeof heldQty === 'number' && isFinite(heldQty)) {
        if (qex > heldQty + LEDGER_EPS) return 'oversell: max sellable is ' + heldQty;
      }
    }
    if (hasT) {
      var tex = Number(t.total);
      if (!isFinite(tex) || tex < 0) return 'total must be >= 0';
      if (!hasQ && tex <= 0) return 'total must be > 0';
    }
  } else {
    if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return 'qty must be > 0';
    if (typeof t.qty === 'string' && t.qty.trim() === '') return 'qty must be > 0';
    var qty = Number(t.qty);
    if (!isFinite(qty) || qty <= 0) return 'qty must be > 0';
    if ((effType === 'sell' || effType === 'transfer') && typeof heldQty === 'number' && isFinite(heldQty)) {
      if (qty > heldQty + LEDGER_EPS) return 'oversell: max sellable is ' + heldQty;
    }
  }
  if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
    if (typeof t.total !== 'number' && typeof t.total !== 'string') return 'total must be >= 0';
    var total = Number(t.total);
    if (!isFinite(total) || total < 0) return 'total must be >= 0';
  }
  if (t.fee !== undefined && t.fee !== null && String(t.fee).trim() !== '') {
    if (typeof t.fee !== 'number' && typeof t.fee !== 'string') return 'fee must be >= 0';
    var fee = Number(t.fee);
    if (!isFinite(fee) || fee < 0) return 'fee must be >= 0';
  }
  // One fiat per trade: the stated total already includes the fee, so the fee
  // cannot exceed an explicitly stated positive total (standalone fees with
  // no total stay allowed).
  if (t.fee !== undefined && t.fee !== null && String(t.fee).trim() !== '' &&
      t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
    var vFee = Number(t.fee);
    var vTot = Number(t.total);
    if (isFinite(vTot) && vTot > 0 && isFinite(vFee) && vFee > vTot) {
      return 'fee cannot exceed total';
    }
  }
  if (t.networkFee !== undefined && t.networkFee !== null && String(t.networkFee).trim() !== '') {
    if (typeof t.networkFee !== 'number' && typeof t.networkFee !== 'string') return 'network fee must be >= 0';
    var nf = Number(t.networkFee);
    if (!isFinite(nf) || nf < 0) return 'network fee must be >= 0';
    if (typeof t.qty === 'number' || typeof t.qty === 'string') {
      var qq = Number(t.qty);
      if (isFinite(qq) && qq > 0 && nf >= qq) return 'network fee must be < qty';
    }
  }
  if (t.feeCurrency !== undefined && t.feeCurrency !== null && String(t.feeCurrency).trim() !== '') {
    if (!isValidCurrencyCode(t.feeCurrency)) return 'fee currency invalid';
  }
  if (!isValidTxid(t.txid)) return 'transaction ID looks invalid — paste the full tx hash';
  if (t.currency !== undefined && t.currency !== null && String(t.currency).trim() !== '') {
    if (!isValidCurrencyCode(t.currency)) return 'currency invalid';
  }
  if (effType === 'transfer') {
    var hasToV = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
    if (hasToV && t.accountId && t.toAccountId && t.accountId === t.toAccountId) return 'transfer needs two different accounts';
  }
  if (typeof t.date === 'string' && t.date.length > 0) {
    if (!isValidDateStr(t.date)) return 'date must be YYYY-MM-DD';
    if (isFutureDateStr(t.date)) return 'date cannot be in the future';
  }
  return null;
}

// Expose Ledger on window.Inoculens for tests.html and Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.normalizeTrade = normalizeTrade;
  window.Inoculens.computeAverage = computeAverage;
  window.Inoculens.computeFifo = computeFifo;
  window.Inoculens.computePositions = computePositions;
  window.Inoculens.validateTrade = validateTrade;
  window.Inoculens.computePortfolio = computePortfolio;
  window.Inoculens.computeAnalytics = computeAnalytics;
  window.Inoculens.heldForAccount = heldForAccount;
  window.Inoculens.TRADE_TYPES = TRADE_TYPES;
}

// === Prices ===
// Live crypto prices via CoinGecko simple/price with manual fallback.
// Resolution order per symbol: (1) manual override from live
// loadState().priceOverrides (wins, no network), (2) CoinGecko
// simple/price for mapped symbols with a 60s in-memory cache,
// (3) null for unknown tickers or failed fetches (last cached price
// is returned when available). Never throws to the UI — failures
// resolve to cached-or-null. Read by Ui (Task 6) via refreshAllPrices.

var SYMBOL_MAP = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  XLM: 'stellar',
  ATOM: 'cosmos',
  UNI: 'uniswap',
  TRX: 'tron',
  NEAR: 'near',
  ARB: 'arbitrum',
  OP: 'optimism',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token',
  APT: 'aptos',
  INJ: 'injective-protocol',
  SUI: 'sui',
  SEI: 'sei-network',
  TIA: 'celestia',
  PEPE: 'pepe',
  SHIB: 'shiba-inu',
  TON: 'toncoin',
  ICP: 'internet-computer',
  FIL: 'filecoin',
  ETC: 'ethereum-classic',
  HBAR: 'hedera-hashgraph',
  VET: 'vechain',
  RENDER: 'render-token',
  FET: 'fetch-ai',
  KAS: 'kaspa',
  MNT: 'mantle',
  STX: 'stacks',
  MKR: 'maker',
  AAVE: 'aave',
  CRV: 'curve-dao-token',
  LDO: 'lido-dao',
  AR: 'arweave',
  SAND: 'the-sandbox',
  MANA: 'decentraland',
  AXS: 'axie-infinity',
  CHZ: 'chiliz',
  ENJ: 'enjincoin',
  BAT: 'basic-attention-token',
  ZEC: 'zcash',
  DASH: 'dash',
  XTZ: 'tezos',
  EOS: 'eos',
  KSM: 'kusama',
  ALGO: 'algorand',
  THETA: 'theta-network',
  FTM: 'fantom',
  CELO: 'celo',
  KAVA: 'kava',
  RUNE: 'thorchain',
  WBTC: 'wrapped-bitcoin',
  WSTETH: 'wrapped-steth',
  RPL: 'rocket-pool',
  SNX: 'havven',
  COMP: 'compound-governance-token',
  YFI: 'yearn-finance',
  SUSHI: 'sushi',
  ASTR: 'astar',
  JUP: 'jupiter-exchange-solana',
  PYTH: 'pyth-network',
  ONDO: 'ondo-finance',
  TAO: 'bittensor',
  XMR: 'monero',
  CRO: 'crypto-com-chain',
  GRT: 'the-graph',
  IMX: 'immutable-x',
  ENS: 'ethereum-name-service',
  LRC: 'loopring',
  QNT: 'quant-network',
  CAKE: 'pancakeswap-token',
  EGLD: 'elrond-erd-2',
  FLOW: 'flow',
  GALA: 'gala',
  APE: 'apecoin',
  JASMY: 'jasmycoin',
  HNT: 'helium',
  WIF: 'dogwifcoin',
  BONK: 'bonk',
  FLOKI: 'floki',
  RAY: 'raydium',
  PENDLE: 'pendle',
  ENA: 'ethena',
  STRK: 'starknet',
  ZK: 'zksync',
  W: 'wormhole',
  BLUR: 'blur',
  ORCA: 'orca'
};

var PRICE_CACHE_TTL_MS = 60000;
var priceCache = {}; // key "SYM:VS" (uppercased) -> {price, at}

function priceCacheKey(symbol, vs) {
  return String(symbol).toUpperCase() + ':' + String(vs).toUpperCase();
}

function priceOverrideFor(symbol) {
  var e = null;
  try { e = priceOverrideEntry(symbol); } catch (err) { e = null; }
  return e ? e.price : null;
}

// Raw override entry with its fiat: {price, vs} where vs is null for legacy
// bare numbers (fiat unknown — treated as the requested fiat, exactly the
// old behavior). New saves always tag the fiat they were entered in.
function priceOverrideEntry(symbol) {
  var sym = String(symbol).trim().toUpperCase();
  var ov = null;
  try {
    var st = loadState();
    ov = st ? st.priceOverrides : null;
  } catch (e) {
    ov = null;
  }
  if (!ov || typeof ov !== 'object') return null;
  var raw = null;
  if (Object.prototype.hasOwnProperty.call(ov, sym)) {
    raw = ov[sym];
  } else {
    // Tolerate differently-cased keys without touching stored data.
    var keys = Object.keys(ov);
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i]).toUpperCase() === sym) { raw = ov[keys[i]]; break; }
    }
  }
  if (typeof raw === 'number') {
    return (isFinite(raw) && raw > 0) ? { price: raw, vs: null } : null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    var p = Number(raw.price);
    var vs = (typeof raw.vs === 'string') ? raw.vs.trim().toUpperCase() : '';
    if (isFinite(p) && p > 0 && /^[A-Z]{2,10}$/.test(vs)) return { price: p, vs: vs };
  }
  return null;
}

function priceDefaultVs(vs) {
  if (typeof vs === 'string' && vs.length > 0) return vs;
  try {
    var st = loadState();
    if (st && st.settings && typeof st.settings.mainCurrency === 'string' && st.settings.mainCurrency.length > 0) {
      return st.settings.mainCurrency;
    }
  } catch (e) { /* fall through */ }
  return 'EUR';
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

function fetchStockPrice(symbol, vs) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = priceDefaultVs(vs);
  cur = String(cur).trim().toUpperCase();
  if (MAIN_CURRENCIES.indexOf(cur) === -1) cur = 'EUR';
  var key = priceCacheKey('STOCK:' + sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  if (cached && (now - cached.at) < PRICE_CACHE_TTL_MS && isFinite(Number(cached.price)) && Number(cached.price) > 0) {
    return Promise.resolve(Number(cached.price));
  }
  var sq = stooqSymbol(sym);
  if (!sq) return Promise.resolve(cached && cached.price > 0 ? Number(cached.price) : null);
  var url = 'https://stooq.com/q/l/?s=' + encodeURIComponent(sq) + '&f=sd2t2ohlcv&h&e=csv';
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Promise.resolve(Number(cached.price));
    return Promise.resolve(null);
  }
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.text();
  }).then(function (csv) {
    var usd = parseStooqClose(csv);
    if (!isFinite(usd) || usd <= 0) {
      if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
      return null;
    }
    if (cur === 'USD') {
      priceCache[key] = { price: usd, at: Date.now() };
      return usd;
    }
    return fetchEcbRate(todayStr(), 'USD', cur).then(function (r) {
      var v = usd * Number(r.rate);
      if (!isFinite(v) || v <= 0) {
        if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
        return null;
      }
      priceCache[key] = { price: v, at: Date.now() };
      return v;
    }, function () {
      if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
      return null;
    });
  }).then(null, function () {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
    return null;
  });
}

var lastPriceErrors = {}; // sym -> short reason for the latest refreshAllPrices run (feeds the error-details popup)

function cachedFreshPrice(sym, cur) {
  var key = priceCacheKey(sym, cur);
  var c = priceCache[key];
  if (c && (Date.now() - c.at) < PRICE_CACHE_TTL_MS && isFinite(Number(c.price)) && Number(c.price) > 0) {
    return Number(c.price);
  }
  return null;
}

// One CoinGecko request for many symbols (ids=csv, vs=main[,usd]). Per-coin
// requests tripped the free-tier rate limit and caused the intermittent
// "unreachable" errors; a single batched call plus one outer retry is far
// more reliable. Resolves {prices, errors}; rejects only on total failure.
function fetchBatchPrices(syms, vs) {
  var cur = String(vs || '').toUpperCase();
  var curLow = cur.toLowerCase();
  var ids = syms.map(function (s) { return SYMBOL_MAP[String(s).toUpperCase()]; });
  var seenIds = {};
  var uniqIds = [];
  ids.forEach(function (id) { if (id && !seenIds[id]) { seenIds[id] = true; uniqIds.push(id); } });
  var needUsd = curLow !== 'usd'; // bridge for mains CoinGecko doesn't quote (e.g. RON)
  var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    uniqIds.map(function (id) { return encodeURIComponent(id); }).join(',') +
    '&vs_currencies=' + encodeURIComponent(curLow) + (needUsd ? ',usd' : '');
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  var done = function (prices, errors) { return { prices: prices, errors: errors }; };
  if (!capturedFetch) {
    var off = {}, offE = {};
    syms.forEach(function (s) {
      var c = priceCache[priceCacheKey(s, cur)];
      if (c && isFinite(Number(c.price)) && Number(c.price) > 0) off[s] = Number(c.price);
      else { off[s] = null; offE[s] = 'offline — no cached price'; }
    });
    return Promise.resolve(done(off, offE));
  }
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var prices = {}, errors = {};
    var usdToCur = null;
    var usdToCurJobs = [];
    syms.forEach(function (s) {
      var id = SYMBOL_MAP[String(s).toUpperCase()];
      var p = data && data[id] && data[id][curLow];
      p = Number(p);
      if (isFinite(p) && p > 0) {
        prices[s] = p;
        priceCache[priceCacheKey(s, cur)] = { price: p, at: Date.now() };
        return;
      }
      if (needUsd) {
        var pu = data && data[id] && data[id].usd;
        pu = Number(pu);
        if (isFinite(pu) && pu > 0) {
          usdToCurJobs.push({ sym: s, usd: pu });
          return;
        }
      }
      prices[s] = null;
      errors[s] = 'no quote returned — try a manual override in Settings';
    });
    if (!usdToCurJobs.length) return done(prices, errors);
    return fetchEcbRate(todayStr(), 'USD', cur).then(function (r) {
      usdToCur = Number(r.rate);
      usdToCurJobs.forEach(function (j) {
        var v = j.usd * usdToCur;
        if (isFinite(v) && v > 0) {
          prices[j.sym] = v;
          priceCache[priceCacheKey(j.sym, cur)] = { price: v, at: Date.now() };
        } else {
          prices[j.sym] = null;
          errors[j.sym] = 'currency bridge failed — try a manual override in Settings';
        }
      });
      return done(prices, errors);
    }, function () {
      usdToCurJobs.forEach(function (j) {
        prices[j.sym] = null;
        errors[j.sym] = 'currency bridge unreachable (ECB) — try a manual override in Settings';
      });
      return done(prices, errors);
    });
  });
}

function fetchLivePrice(symbol, vs, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var cur = priceDefaultVs(vs);
  cur = String(cur).trim().toUpperCase();
  if (MAIN_CURRENCIES.indexOf(cur) === -1 && ['USDC', 'USDT', 'DAI'].indexOf(cur) === -1) cur = 'EUR';
  var curLow = String(cur).toLowerCase();
  // (2) Fresh cache (60s) avoids network.
  var key = priceCacheKey(sym, cur);
  var now = Date.now();
  var cached = priceCache[key];
  // (1) Manual override wins — no market network. A legacy bare number is
  // denominated in the requested fiat (old behavior); a fiat-tagged override
  // converts at the CURRENT rate (it stands in for the live price), and
  // resolves unknown — never mislabeled — when conversion fails.
  var ovEntry = null;
  try { ovEntry = priceOverrideEntry(sym); } catch (e) { ovEntry = null; }
  if (ovEntry !== null) {
    if (!ovEntry.vs || ovEntry.vs === cur) return Promise.resolve(ovEntry.price);
    var ovCached = priceCache[key];
    return fetchEcbRate(todayStr(), ovEntry.vs, cur).then(function (r) {
      var v = ovEntry.price * Number(r.rate);
      if (!isFinite(v) || v <= 0) {
        if (ovCached && isFinite(Number(ovCached.price)) && Number(ovCached.price) > 0) return Number(ovCached.price);
        return null;
      }
      priceCache[key] = { price: v, at: Date.now() };
      return v;
    }, function () {
      if (ovCached && isFinite(Number(ovCached.price)) && Number(ovCached.price) > 0) return Number(ovCached.price);
      return null;
    });
  }
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  if (kd === 'stock') return fetchStockPrice(sym, cur);
  if (kd === 'custom' || kd === 'cash') return Promise.resolve(null);
  // (3a) Unknown ticker: null immediately, never throws, no network.
  var id = SYMBOL_MAP[sym];
  if (!id) return Promise.resolve(null);
  var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' +
    encodeURIComponent(id) + '&vs_currencies=' + encodeURIComponent(curLow);
  // Hermetic async: capture fetch at call time so a later stub restore
  // cannot clobber this operation's continuation.
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) {
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Promise.resolve(Number(cached.price));
    return Promise.resolve(null);
  }
  return capturedFetch(url).then(function (res) {
    if (!res.ok) throw new Error('price-http-' + res.status);
    return res.json();
  }).then(function (data) {
    var p = data && data[id] && data[id][curLow];
    p = Number(p);
    if (isFinite(p) && p > 0) {
      priceCache[key] = { price: p, at: Date.now() };
      return p;
    }
    // Unsupported vs_currency (e.g. RON is absent from CoinGecko's list):
    // bridge via the USD pivot — USD price times live USD->main FX.
    // Cached-or-null fallback preserved below on any failure.
    if (curLow !== 'usd') {
      return fetchLivePrice(sym, 'USD').then(function (pu) {
        pu = Number(pu);
        if (!isFinite(pu) || pu <= 0) {
          if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
          return null;
        }
        return fetchEcbRate(todayStr(), 'USD', cur).then(function (r) {
          var bridged = pu * Number(r.rate);
          if (!isFinite(bridged) || bridged <= 0) {
            if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
            return null;
          }
          priceCache[key] = { price: bridged, at: Date.now() };
          return bridged;
        }, function () {
          if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
          return null;
        });
      });
    }
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
    return null;
  }).then(null, function () {
    // Network error / 429 / bad payload: last cached or null, never throw.
    if (cached && isFinite(Number(cached.price)) && Number(cached.price) > 0) return Number(cached.price);
    return null;
  });
}

function refreshAllPrices(symbols, vs, kinds) {
  var cur = priceDefaultVs(vs);
  var seen = {};
  var uniq = [];
  (symbols || []).forEach(function (s) {
    var sym = String(s || '').toUpperCase();
    if (!sym || seen[sym]) return;
    seen[sym] = true;
    uniq.push(sym);
  });
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
  var out = {};
  var errors = {};
  var crypto = [];
  var stocks = [];
  var ovConvJobs = [];
  uniq.forEach(function (sym) {
    // Manual override wins — no market network. Legacy bare numbers are
    // denominated in the requested fiat; fiat-tagged overrides convert at the
    // current rate (or resolve unknown when conversion fails — never
    // mislabeled).
    var ovE = null;
    try { ovE = priceOverrideEntry(sym); } catch (e) { ovE = null; }
    if (ovE !== null) {
      if (!ovE.vs || ovE.vs === cur) { out[sym] = ovE.price; return; }
      ovConvJobs.push({ sym: sym, price: ovE.price, vs: ovE.vs });
      return;
    }
    var kd = (typeof kindFor(sym) === 'string') ? kindFor(sym).trim().toLowerCase() : '';
    if (kd === 'stock') { stocks.push(sym); return; }
    if (kd === 'custom' || kd === 'cash') {
      out[sym] = null;
      errors[sym] = 'manual price only — add an override in Settings';
      return;
    }
    if (!SYMBOL_MAP[sym]) {
      out[sym] = null;
      errors[sym] = 'no live source mapped — add a manual override in Settings';
      return;
    }
    var fresh = cachedFreshPrice(sym, cur);
    if (fresh !== null) { out[sym] = fresh; return; }
    crypto.push(sym);
  });
  var jobs = [];
  if (ovConvJobs.length) {
    jobs.push(Promise.all(ovConvJobs.map(function (j) {
      return fetchEcbRate(todayStr(), j.vs, cur).then(function (r) {
        var v = j.price * Number(r.rate);
        if (isFinite(v) && v > 0) {
          out[j.sym] = v;
          priceCache[priceCacheKey(j.sym, cur)] = { price: v, at: Date.now() };
        } else {
          out[j.sym] = null;
          errors[j.sym] = 'manual override could not convert to ' + cur + ' — try a manual override in ' + cur + ' under Settings';
        }
        return true;
      }, function () {
        var c = priceCache[priceCacheKey(j.sym, cur)];
        if (c && isFinite(Number(c.price)) && Number(c.price) > 0) out[j.sym] = Number(c.price);
        else {
          out[j.sym] = null;
          errors[j.sym] = 'manual override unreachable in ' + cur + ' (ECB) — try a manual override in ' + cur + ' under Settings';
        }
        return false;
      });
    })).then(function () { /* mapped into out/errors above */ }));
  }
  if (crypto.length) {
    jobs.push(fetchBatchPrices(crypto, cur).then(function (res) {
      Object.keys(res.prices).forEach(function (k) { out[k] = res.prices[k]; });
      Object.keys(res.errors).forEach(function (k) { errors[k] = res.errors[k]; });
    }, function () {
      crypto.forEach(function (sym) {
        var c = priceCache[priceCacheKey(sym, cur)];
        if (c && isFinite(Number(c.price)) && Number(c.price) > 0) out[sym] = Number(c.price);
        else { out[sym] = null; errors[sym] = 'CoinGecko request failed (network or rate limit)'; }
      });
    }));
  }
  stocks.forEach(function (sym) {
    jobs.push(fetchLivePrice(sym, cur, 'stock').then(function (p) {
      if (isFinite(Number(p)) && Number(p) > 0) out[sym] = Number(p);
      else { out[sym] = null; errors[sym] = 'stock feed unreachable — try a manual override in Settings'; }
    }));
  });
  return Promise.all(jobs).then(function () { lastPriceErrors = errors; return out; });
}

// --- Historical execution prices (per-trade market reference) ---
// Exec. price resolution order per trade: (1) manual override from
// loadState().priceOverrides (wins, no network), (2) the trade's frozen
// execLock (stamped once at save time, converted to the display main at the
// historical ECB rate — never refetched), (3) cached historical price for
// (symbol, trade date, main), (4) network history — CoinGecko /history
// (DD-MM-YYYY) for mapped crypto, Stooq daily closes for stock accounts with
// up to 5-day walk-back for weekends/holidays — converted into the display
// main at the HISTORICAL ECB rate of the fixing date (never today's rate),
// (5) null when unknown (row shows "—", never 0). Never throws to the UI.
// Real price stays purely calculated (all-in converted total / qty); Exec is
// the reference-only market quote it is compared against.

var HISTCACHE_KEY = 'inoculens.histcache.v1';
var HISTCACHE_MAX = 1000;
var histPriceCache = null; // key "SYM|DATE|VS|kind" -> {price, source, interpolated, at}; lazy-loaded

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
  try {
    if (typeof localStorage === 'undefined') return;
    var keys = Object.keys(histPriceCache || {});
    var store = histPriceCache;
    if (keys.length > HISTCACHE_MAX) {
      store = {};
      keys.slice(keys.length - 800).forEach(function (k) { store[k] = histPriceCache[k]; });
      histPriceCache = store;
    }
    localStorage.setItem(HISTCACHE_KEY, JSON.stringify(store));
  } catch (e) { /* private mode / quota: memory cache still works */ }
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
      fetchHistoricalPrice(parts[0], parts[1], parts[2], parts[3] === 'stock' ? 'stock' : undefined).then(function (r) {
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

function clearHistCache() {
  histPriceCache = {};
  histFailKeys = {};
  histInflight = {};
  try { feeRateErr = {}; } catch (e) { /* ignore */ }
  try { histDiag = {}; } catch (e) { /* ignore */ }
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(HISTCACHE_KEY);
  } catch (e) { /* ignore */ }
}

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
    var keys = Object.keys(ov);
    (trades || []).forEach(function (t) {
      if (!t || typeof t !== 'object' || (t.type !== 'buy' && t.type !== 'sell')) return;
      var fr = null;
      try { fr = frozenExecOf(t); } catch (e) { fr = null; }
      if (!fr || String(fr.source).toLowerCase() === 'manual') return;
      var sym = String((t && t.symbol) || '').toUpperCase();
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).toUpperCase() !== sym) continue;
        var raw = ov[keys[i]];
        var op = (typeof raw === 'number') ? raw
          : ((raw && typeof raw === 'object' && !Array.isArray(raw)) ? Number(raw.price) : NaN);
        if (isFinite(op) && op > 0 && op === fr.price) {
          try { delete t.execLock; } catch (e) { t.execLock = undefined; }
          changed = true;
        }
        break;
      }
    });
  } catch (e) { /* repair never breaks the run */ }
  return changed;
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
  if (kd !== 'stock' && !SYMBOL_MAP[sym]) return;
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
  try { if (priceOverrideEntry(sym) !== null) return; } catch (e) { /* fall through */ }
  var kk = kd === 'stock' ? 'stock' : 'crypto';
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

// Last tap-to-retry failure per trade (session-only): surfaced as the Fee
// Fiat Rate row's tooltip so an unknown rate says WHY instead of just '—'.
// Cleared whenever a lookup for that trade succeeds.
var feeRateErr = {};
function feeRateWhy(t, kind) {
  if (t && feeRateErr[t.id]) return feeRateErr[t.id];
  var kd = String(kind || '').trim().toLowerCase();
  if (kd === 'custom' || kd === 'cash') return 'No market history for this account kind — tap to retry anyway';
  var sym = t ? String(t.symbol || '').toUpperCase() : '';
  if (kd !== 'stock' && !SYMBOL_MAP[sym]) return 'No market history for this asset — tap to retry anyway';
  return 'Tap to retry the rate lookup';
}
// Point the row's tooltip at new text without repainting (a full render
// would yank the scroll to the top via route()).
function feeRateTitle(id, text) {
  try {
    var el = document.querySelector('[data-trade="' + id + '"] [data-label="Fee in fiat rate"]');
    if (el) el.title = String(text);
  } catch (e) { /* ignore */ }
}
// Compose the fee-rate failure tooltip from the recorded per-host causes.
function feeFailMsg(id, key) {
  var detail = '';
  try { detail = histDiag[key] || ''; } catch (e) { detail = ''; }
  feeRateErr[id] = 'History lookup failed' + (detail ? ' (' + detail + ')' : '') + ' — tap to retry';
  feeRateTitle(id, feeRateErr[id]);
}
// Tap-path failure: same record plus a visible reason popup (hover tooltips
// don't exist on touch screens, and a silent row leaves nothing to debug).
function feeFailTap(id, key) {
  histNoteFail(key);
  feeFailMsg(id, key);
  try { openNoteDialog(feeRateErr[id], 'Fee in fiat rate'); } catch (e) { /* ignore */ }
}
function retryFeeRate(tradeId) {
  var st = null;
  try { st = loadState(); } catch (e) { return; }
  var tr = null;
  (st.trades || []).forEach(function (t) { if (t && t.id === tradeId) tr = t; });
  if (!tr) return;
  var sym = String(tr.symbol || '').toUpperCase();
  var day = (typeof tr.date === 'string') ? tr.date.slice(0, 10) : '';
  var mainU = String((st.settings && st.settings.mainCurrency) || '').toUpperCase();
  if (!sym || !isValidDateStr(day) || isFutureDateStr(day) || !mainU) return;
  var kd = '';
  try {
    var a = accountById(st, tr.accountId);
    if (a && typeof a.kind === 'string') kd = a.kind.trim().toLowerCase();
  } catch (e) { kd = ''; }
  if (kd === 'custom' || kd === 'cash') return;
  if (kd !== 'stock' && !SYMBOL_MAP[sym]) return;
  var kk = kd === 'stock' ? 'stock' : 'crypto';
  var key = sym + '|' + day + '|' + mainU + '|' + kk;
  try { delete histFailKeys[key]; } catch (e) { /* ignore */ }
  if (histInflight[key]) return;
  var hit = null;
  try { hit = getHistCached(sym, day, mainU, kk); } catch (e) { hit = null; }
  if (hit) { try { render(); } catch (e) { /* ignore */ } return; }
  histInflight[key] = true;
  fetchHistoricalPrice(sym, day, mainU, kd).then(function (r) {
    delete histInflight[key];
    var price = (r && typeof r === 'object') ? r.price : r;
    if (isFinite(Number(price)) && Number(price) > 0) {
      try {
        setHistCached(sym, day, mainU, kk, Number(price),
          (r && typeof r === 'object' && r.day) ? ('Stooq-' + r.day) : 'history',
          (r && typeof r === 'object') ? !!r.interpolated : false);
        saveHistCache();
      } catch (e) { /* ignore */ }
      try { delete feeRateErr[tradeId]; } catch (e) { /* ignore */ }
      try { render(); } catch (e) { /* ignore */ }
    } else { feeFailTap(tradeId, key); }
  }, function () { delete histInflight[key]; feeFailTap(tradeId, key); });
}

function setHistCached(symbol, date, vs, kind, price, source, interpolated) {
  if (!isFinite(Number(price)) || Number(price) <= 0) return;
  loadHistCache()[histCacheKey(symbol, date, vs, kind)] = {
    price: Number(price), source: String(source || ''), interpolated: !!interpolated, at: Date.now()
  };
}

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
  return fetchCoinbaseHistory(sym, dateStr, cur).then(function (cb) {
    if (isFinite(cb) && cb > 0) return cb;
    return coingeckoAndBeyond();
  });
}

// Third source for crypto history when the first two fail or omit the fiat:
// Kraken public OHLC, daily close (no key, CORS-enabled). Majors only;
// USD/EUR direct, other fiats via the USD pivot + historical ECB.
var KRAKEN_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH'];
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
  var sq = stooqSymbol(sym);
  if (!sq || !isValidDateStr(dateStr)) return Promise.resolve(null);
  var capturedFetch = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : null;
  if (!capturedFetch) return Promise.resolve(null);
  // Walk back up to 5 days for weekends/holidays (same window as FX).
  function attempt(day, back) {
    var compact = toStooqDay(day);
    var url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(sq) +
      '&d1=' + encodeURIComponent(compact) + '&d2=' + encodeURIComponent(compact) + '&i=d';
    return capturedFetch(url).then(function (res) {
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
  return attempt(dateStr.slice(0, 10), 0).then(function (r) { return r; }, function () { return null; });
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
  try { ovE = priceOverrideEntry(sym); } catch (e) { ovE = null; }
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
  if (!SYMBOL_MAP[sym]) return Promise.resolve(null);
  return fetchHistoricalCryptoPrice(sym, day, cur);
}

// Sync read for paint: override, else cache, else null (async fill follows).
function getHistoricalExec(symbol, dateStr, vs, kind) {
  var sym = String(symbol || '').trim().toUpperCase();
  var day = (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) ? dateStr.slice(0, 10) : '';
  var cur = String(priceDefaultVs(vs)).trim().toUpperCase();
  if (!sym || !isValidDateStr(day)) return null;
  var ov = null;
  try { ov = priceOverrideFor(sym); } catch (e) { ov = null; }
  if (ov !== null) return { price: ov, source: 'manual', interpolated: false };
  var kd = (typeof kind === 'string') ? kind.trim().toLowerCase() : '';
  var hit = getHistCached(sym, day, cur, kd === 'stock' ? 'stock' : 'crypto');
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
    if (!t || (t.type !== 'buy' && t.type !== 'sell' && t.type !== 'transfer')) return;
    var sym = String((t && t.symbol) || '').toUpperCase();
    var day = (t && typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) ? t.date.slice(0, 10) : '';
    if (!sym || !isValidDateStr(day) || isFutureDateStr(day)) return;
    var kd = (typeof kindFor(sym) === 'string') ? kindFor(sym).trim().toLowerCase() : '';
    if (kd === 'custom' || kd === 'cash') return;
    if (kd !== 'stock' && !SYMBOL_MAP[sym]) return;
    var kk = (kd === 'stock' ? 'stock' : 'crypto');
    var key = sym + '|' + day + '|' + m + '|' + kk;
    if (t.id) { (idsByKey[key] = idsByKey[key] || []).push(t.id); }
    if (seen[key]) return;
    seen[key] = true;
    try { if (priceOverrideFor(sym) !== null) return; } catch (e) { /* fall through */ }
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

// Expose Prices on window.Inoculens for tests.html and Ui (Task 6).
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.SYMBOL_MAP = SYMBOL_MAP;
  window.Inoculens.PRICE_CACHE_TTL_MS = PRICE_CACHE_TTL_MS;
  window.Inoculens.priceCache = priceCache;
  window.Inoculens.fetchLivePrice = fetchLivePrice;
  window.Inoculens.refreshAllPrices = refreshAllPrices;
  window.Inoculens.fetchHistoricalPrice = fetchHistoricalPrice;
  window.Inoculens.getHistoricalExec = getHistoricalExec;
  window.Inoculens.ensureHistoricalExec = ensureHistoricalExec;
  window.Inoculens.getHistCached = getHistCached;
  window.Inoculens.setHistCached = setHistCached;
  window.Inoculens.clearHistCache = clearHistCache;
  window.Inoculens.reloadHistCache = function () { loadHistCache(true); };
  window.Inoculens.parseStooqDaily = parseStooqDaily;
  window.Inoculens.toCoingeckoDate = toCoingeckoDate;
  window.Inoculens.roundHalfUp2 = roundHalfUp2;
  window.Inoculens.frozenExecOf = frozenExecOf;
  window.Inoculens.freezeExecLock = freezeExecLock;
  window.Inoculens.retryFeeRate = retryFeeRate;
  window.Inoculens.priceOverrideEntry = priceOverrideEntry;
  window.Inoculens.priceOverrideFor = priceOverrideFor;
  window.Inoculens.resolveExecPrice = resolveExecPrice;
  window.Inoculens.dropBakedExecLocks = dropBakedExecLocks;
}

// === Ui ===
// DOM boot + render loop (Task 6; top-bar + dialogs redesign). Binds the
// sticky top bar, positions/trades tables, trade + settings dialogs,
// import/export and banner to Store/Fx/Ledger/Prices. Render loop: every
// mutation does saveState -> recompute (computePositions) -> render(). A
// main-currency switch re-fetches live prices only; frozen trade fxLocks
// are never rewritten. Money is formatted with Intl.NumberFormat in the
// current mainCurrency. Every positions/trades <td> carries a data-label
// so the mobile card layout (styles.css) can label rows. init() boots on
// DOMContentLoaded; render()/refreshPrices() are the recompute+render
// entry points (also used by tests.html).

// === Version contract (for any AI or human editing this app) ===
// Full rules live in AGENTS.md at the repo root — coding agents load it
// automatically, no prompt needed. Summary:
// The footer version is the commit id + commit count, e.g. "c03f772 (#110)".
// That id only exists AFTER committing, so nobody hand-writes it: the deploy
// build (stamp-version.sh, wired in netlify.toml) stamps the exact values
// into APP_VERSION below on every deploy. Keep a sane fallback value here
// for local/file:// use, and keep bumping the ?v= cache-busters in
// index.html on every change so deployed users load fresh assets. Users only
// ever see the footer version string, never this note.
// === End version contract ===

var APP_VERSION = '35056ef (#140)';

var uiBooted = false;
var livePrices = {}; // SYM (uppercased) -> number|null, latest known live price
var moneyFmtCache = {};

function todayStr() {
  // Local calendar date (user-facing default + date max), matching the
  // local-based download filename. Pure FX calendar math (fxShiftDate,
  // ledgerHoldingDays) intentionally stays on UTC date arithmetic.
  var n = new Date();
  var m = n.getMonth() + 1;
  var d = n.getDate();
  return n.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

function uid() {
  return 't' + Date.now().toString(36) + Math.floor(Math.random() * 0xffffff).toString(36);
}

function uiVal(id, fb) {
  var el = document.getElementById(id);
  return el ? el.value : fb;
}

function uiSetVal(id, v) {
  var el = document.getElementById(id);
  if (el) el.value = v;
}

function moneyFmt(currency) {
  var code = String(currency || 'EUR').toUpperCase();
  if (!moneyFmtCache[code]) {
    try {
      moneyFmtCache[code] = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
    } catch (e) {
      moneyFmtCache[code] = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' });
    }
  }
  return moneyFmtCache[code];
}

function fmtMoney(n, currency) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  try {
    return moneyFmt(currency).format(v);
  } catch (e) {
    return String(Math.round(v * 100) / 100);
  }
}

// Round half-up to 2 decimals (3rd decimal >= 5 rounds up, <= 4 rounds down),
// e.g. 85920.98706029935 -> 85920.99. Display helper: ledger math always
// keeps full precision; only the shown price is rounded.
function roundHalfUp2(n) {
  var v = Number(n);
  if (!isFinite(v)) return NaN;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function fmtQty(n) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(v);
}

function fmtPct(n) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  return (Math.round(v * 100) / 100) + '%';
}

function showBanner(msg, kind, details) {
  var b = document.getElementById('banner');
  if (!b) return;
  var hasDetails = !!(details && ((details.lines && details.lines.length) || details.message));
  if (hasDetails) {
    lastErrorDetails = {
      title: details.title || 'Details',
      message: details.message || String(msg),
      lines: (details.lines || []).slice(0, 200)
    };
  } else {
    lastErrorDetails = null;
  }
  // Settings sits above the page: while it is open the message lives ONLY
  // in the dialog mirror. Errors born here die with the dialog; a message
  // moved in from a pre-existing page banner moves back on close.
  if (!suppressMirror && settingsDialogOpen()) {
    lastMirror = { msg: String(msg), kind: kind, details: details || null, fromPage: false };
    try {
      mirrorBannerToSettings(String(msg), kind === 'info' ? 'info' : 'error', hasDetails);
    } catch (e) { /* never let the mirror break the banner */ }
    return;
  }
  var t = document.getElementById('banner-text');
  if (t) t.textContent = String(msg);
  else b.textContent = String(msg);
  b.classList.remove('error', 'info');
  b.classList.add(kind === 'info' ? 'info' : 'error');
  try { b.dataset.kind = kind === 'info' ? 'info' : 'error'; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  // Optional drill-down: every error with something more to say gets a
  // "More details" button opening the fixed-size error popup. The banner
  // itself stays one calm general line no matter how many tickers fail.
  if (hasDetails) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'banner-details';
    btn.className = 'quiet';
    btn.textContent = 'More details';
    btn.setAttribute('aria-label', 'Show error details');
    btn.addEventListener('click', function () { openErrorDialog(); });
    b.appendChild(btn);
  }
  b.hidden = false;
}

function clearBanner() {
  var b = document.getElementById('banner');
  if (!b) return;
  var t = document.getElementById('banner-text');
  if (t) t.textContent = '';
  else b.textContent = '';
  b.classList.remove('error', 'info');
  try { delete b.dataset.kind; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  lastErrorDetails = null;
  lastMirror = null;
  b.hidden = true;
  try { hideSettingsAlert(); } catch (e) { /* ignore */ }
}

var lastErrorDetails = null; // {title, message, lines[]} for the error-details popup

// While Settings is open the message lives ONLY in the dialog mirror;
// suppressMirror + lastMirror carry it back to the page banner on close.
var suppressMirror = false;
var lastMirror = null; // {msg, kind, details} or null

// Settings-dialog mirror of the page banner: modal dialogs paint above the
// page, so without this an error fired from the Sync tab hides behind the
// dialog until it is closed. The mirror shows the same line (+ its own
// More details button, which stacks above) and hides with clearBanner.
function settingsDialogOpen() {
  try {
    var d = (typeof document !== 'undefined') ? document.getElementById('settings-dialog') : null;
    return !!(d && (d.open || (d.hasAttribute && d.hasAttribute('open'))));
  } catch (e) {
    return false;
  }
}

function settingsAlertEl() {
  var dlg = document.getElementById('settings-dialog');
  var host = document.getElementById('settings-dialog-body');
  if (!dlg || !host) return null;
  var el = document.getElementById('settings-alert');
  if (!el) {
    el = document.createElement('div');
    el.id = 'settings-alert';
    el.className = 'dlg-note';
    el.hidden = true;
    var sp = document.createElement('span');
    sp.id = 'settings-alert-text';
    el.appendChild(sp);
    // Child of the dialog itself (above the body), NOT of the grid body:
    // the body is a single-row grid and a second child would break it.
    dlg.insertBefore(el, host);
  }
  // Once per dialog: when Settings closes, a mirrored message moves back to
  // the page banner so it is not silently lost. Native Esc closes fire
  // 'close' too, so this catches every path (not just closeDialog).
  if (!dlg.getAttribute('data-alert-wired')) {
    dlg.setAttribute('data-alert-wired', '1');
    dlg.addEventListener('close', function () {
      try { flushSettingsAlertToBanner(); } catch (e) { /* ignore */ }
      try { updateModalLock(); } catch (e2) { /* ignore */ }
    });
  }
  return el;
}

function mirrorBannerToSettings(msg, kind, hasDetails) {
  if (typeof document === 'undefined') return;
  if (!settingsDialogOpen()) return;
  var el = settingsAlertEl();
  if (!el) return;
  el.classList.remove('error', 'info');
  el.classList.add(kind === 'info' ? 'info' : 'error');
  var sp = document.getElementById('settings-alert-text');
  if (sp) sp.textContent = String(msg);
  else el.textContent = String(msg);
  var old = document.getElementById('settings-alert-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  if (hasDetails) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'settings-alert-details';
    btn.textContent = 'More details';
    btn.setAttribute('aria-label', 'Show error details');
    btn.addEventListener('click', function () { openErrorDialog(); });
    el.appendChild(btn);
  }
  // Every error gets a way out: dismissing here clears the message
  // everywhere (mirror and page banner are one message).
  var x = document.getElementById('settings-alert-close');
  if (!x) {
    x = document.createElement('button');
    x.type = 'button';
    x.id = 'settings-alert-close';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss this message');
    x.addEventListener('click', function () {
      try { clearBanner(); } catch (e) { /* ignore */ }
    });
  }
  el.appendChild(x); // last: after any details button
  el.hidden = false;
}

function hideSettingsAlert() {
  if (typeof document === 'undefined') return;
  var el = document.getElementById('settings-alert');
  if (el) el.hidden = true;
}

function refreshSettingsAlert() {
  // Settings opened while a page banner shows: move the message into the
  // dialog (it moves back on close), so it lives in exactly one place.
  try {
    var s = pageBannerState();
    if (!s) return;
    hidePageBannerOnly();
    lastMirror = { msg: s.msg, kind: s.kind, details: lastErrorDetails, fromPage: true };
    mirrorBannerToSettings(s.msg, s.kind === 'info' ? 'info' : 'error', s.hasDetails);
  } catch (e) { /* ignore */ }
}

function pageBannerState() {
  try {
    var b = document.getElementById('banner');
    if (!b || b.hidden) return null;
    var t = document.getElementById('banner-text');
    var kind = 'error';
    try { kind = (b.dataset && b.dataset.kind === 'info') ? 'info' : 'error'; } catch (e) { /* ignore */ }
    return { msg: t ? t.textContent : b.textContent, kind: kind, hasDetails: !!document.getElementById('banner-details') };
  } catch (e) {
    return null;
  }
}

function hidePageBannerOnly() {
  // Hides the page banner but keeps lastErrorDetails, for the move into/out
  // of the settings mirror. Prefer clearBanner() when the message is done.
  var b = document.getElementById('banner');
  if (!b) return;
  var t = document.getElementById('banner-text');
  if (t) t.textContent = '';
  else b.textContent = '';
  b.classList.remove('error', 'info');
  try { delete b.dataset.kind; } catch (e) { /* ignore */ }
  var old = document.getElementById('banner-details');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  b.hidden = true;
}

function flushSettingsAlertToBanner() {
  var m = lastMirror;
  lastMirror = null;
  try { hideSettingsAlert(); } catch (e) { /* ignore */ }
  if (!m || !m.fromPage) return;
  suppressMirror = true;
  try {
    showBanner(m.msg, m.kind, m.details);
  } finally {
    suppressMirror = false;
  }
}

function openErrorDialog() {
  var d = lastErrorDetails || { title: 'Details', message: '', lines: [] };
  var t = document.getElementById('error-dialog-title');
  if (t) t.textContent = d.title || 'Details';
  var m = document.getElementById('error-dialog-message');
  if (m) {
    m.textContent = d.message || '';
    m.hidden = !d.message;
  }
  var ul = document.getElementById('error-dialog-list');
  if (ul) {
    ul.innerHTML = '';
    (d.lines || []).forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = String(line);
      ul.appendChild(li);
    });
    ul.hidden = !(d.lines && d.lines.length);
  }
  wireDialog('error-dialog');
  openDialog('error-dialog');
}

// Price notices are informational and transient: only clear the banner
// when it shows a price notice, so FX/storage errors are never wiped.
function clearPriceBanner() {
  // A mirrored info notice lives in the dialog while the page banner hides
  // (see showBanner): clear that copy too — but never an error mirror.
  try {
    if (lastMirror && lastMirror.kind === 'info') {
      lastMirror = null;
      hideSettingsAlert();
    }
  } catch (e) { /* ignore */ }
  var b = document.getElementById('banner');
  if (!b || b.hidden) return;
  var kind = null;
  try { kind = b.dataset.kind; } catch (e) { kind = null; }
  if (kind === 'info') clearBanner();
}

// Guarded persistence for UI mutations: saveState throws
// Error('storage-unavailable') on private-mode/quota failure. Every UI
// mutation must go through here so no storage failure bricks the UI
// uncaught — the failure surfaces via the existing banner path.
function saveStateGuarded(s) {
  try {
    saveState(s);
    return true;
  } catch (e) {
    if (e && e.message === 'storage-unavailable') {
      showBanner('Storage unavailable — change was not saved.', 'error', {
        title: 'Storage error',
        lines: [
          'What failed: saving your latest change to this browser.',
          'Common causes: private window, or storage full / quota exceeded.',
          'Your change was NOT saved — free space or leave private mode, then retry.'
        ]
      });
      return false;
    }
    throw e;
  }
}

function heldQtyFor(trades, symbol) {
  var sym = String(symbol || '').toUpperCase();
  var held = 0;
  (trades || []).forEach(function (t) {
    if (!t || String(t.symbol || '').toUpperCase() !== sym) return;
    if (t.type === 'buy' || t.type === 'income') {
      var qb = Number(t.qty);
      if (!isFinite(qb) || qb <= 0) return;
      held += qb;
    } else if (t.type === 'sell') {
      var qs = Number(t.qty);
      if (!isFinite(qs) || qs <= 0) return;
      held -= qs;
    } else if (t.type === 'expense') {
      if (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') return;
      var qe = Number(t.qty);
      if (!isFinite(qe) || qe <= 0) return;
      held -= qe;
    } else if (t.type === 'transfer') {
      var qt = Number(t.qty);
      if (!isFinite(qt) || qt <= 0) return;
      var nft = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (!isFinite(nft) || nft < 0) nft = 0;
      held -= nft; // global net: out+in cancel except on-chain fee
    }
  });
  return held < 0 ? 0 : held;
}

function uniqueSymbols(trades) {
  var seen = {};
  var out = [];
  (trades || []).forEach(function (t) {
    var s = String((t && t.symbol) || '').toUpperCase();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}


// gain/loss tint for P&L figures (Revolut-style): '' for zero/unknown.
function plClass(n) {
  var v = Number(n);
  if (!isFinite(v) || v === 0) return '';
  return v > 0 ? 'gain' : 'loss';
}

function statCard(label, text, raw) {
  var d = document.createElement('div');
  d.className = 'card';
  d.setAttribute('data-label', label);
  var l = document.createElement('span');
  l.className = 'card-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'card-value num';
  v.textContent = text;
  if (raw !== null && raw !== undefined && isFinite(Number(raw))) {
    d.setAttribute('data-value', String(Number(raw)));
    v.setAttribute('data-value', String(Number(raw)));
  }
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

// Auto-fit hero digits: fixed box, fluid numbers. The digits live in an
// inner span sized here; the outer line keeps its CSS size, so the strut —
// and therefore the box — never moves. Starts from the CSS clamp size and
// steps down until the amount fits one line (floor ~1.4rem); ellipsis
// remains as the last resort. Re-run on render + resize.
function fitHeroValue() {
  try {
    var el = null;
    try { el = document.getElementById('hero-value-num'); } catch (e0) { el = null; }
    if (!el) el = document.getElementById('hero-value');
    if (!el || !el.style) return;
    el.style.fontSize = '';
    if (typeof getComputedStyle !== 'function') return;
    var size = parseFloat(getComputedStyle(el).fontSize);
    if (!isFinite(size) || size <= 0) return;
    var floor = 22;
    var guard = 0;
    while (guard < 30 && size > floor && el.scrollWidth > el.clientWidth + 1) {
      size -= 2;
      el.style.fontSize = size + 'px';
      guard++;
    }
  } catch (e) { /* ignore */ }
}

function renderSummaryCards(st, rows, dtradesOpt, nAcctsOpt) {
  var main = st.settings.mainCurrency;
  var mv = 0;
  var un = 0;
  var rz = 0;
  var pl = 0;
  var mvKnown = false;
  var unKnown = false;
  var hasRealized = false;
  rows.forEach(function (p) {
    rz += p.realized;
    if (Math.abs(p.realized || 0) > 1e-9) hasRealized = true;
    if (p.unrealized === null && Math.abs(p.realized || 0) <= 1e-9) {
      if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
      return; // unknown open position: value may count, P&L stays unknown
    }
    pl += p.totalPL;
    if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
    if (p.unrealized !== null) { un += p.unrealized; unKnown = true; }
  });
  // Lifetime cost denominator (consistent with computePositions returnPct):
  // sum of buy+income cost for symbols with known P&L. Falls back to
  // remaining-cost when trade history is unavailable (tests/native).
  var lifetime = 0;
  try {
    var dtr = dtradesOpt || convertTrades(st.trades, main);
    var buyBySym = {};
    dtr.forEach(function (t) {
      if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
      var s = String(t.symbol || '').toUpperCase();
      if (!s) return;
      var q = Number(t.qty);
      if (!isFinite(q) || q <= 0) return;
      var nn = normalizeTrade(t);
      buyBySym[s] = (buyBySym[s] || 0) + nn.netMain + nn.feeLossMain;
    });
    var knownSyms = {};
    rows.forEach(function (p) {
      if (p.unrealized !== null || Math.abs(p.realized || 0) > 1e-9) knownSyms[p.symbol] = true;
    });
    Object.keys(buyBySym).forEach(function (s) { if (knownSyms[s]) lifetime += buyBySym[s]; });
  } catch (e) { lifetime = 0; }
  if (!(lifetime > 0)) {
    // Fallback: remaining cost (old behaviour) so empty/new portfolios still paint.
    rows.forEach(function (p) {
      if (p.marketValue !== null && p.unrealized !== null) lifetime += p.marketValue - p.unrealized;
    });
    // If fallback yields 0 but we have realized (e.g. closed, price unknown), use it as denominator guard below.
    if (!(lifetime > 0)) lifetime = 0;
  }
  var plKnown = unKnown || hasRealized;
  var tb = document.getElementById('tb-totals');
  if (tb) {
    var nAccts = (typeof nAcctsOpt === 'number' && isFinite(nAcctsOpt)) ? nAcctsOpt : (st.accounts || []).length;
    tb.textContent = rows.length
      ? (nAccts + (nAccts === 1 ? ' account' : ' accounts') + ' · ' +
        (st.settings.costMethod === 'fifo' ? 'FIFO' : 'Average cost') + ' · in ' + main)
      : '';
  }
  var host = document.getElementById('summary-cards');
  if (!host) return;
  host.innerHTML = '';
  if (!rows.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No trades yet — add your first trade.';
    host.appendChild(p);
    return;
  }
  var ret = lifetime > 0 ? ((un + rz) / lifetime) * 100 : null;
  [['Value', mvKnown ? fmtMoney(mv, main) : '—', mvKnown ? mv : null],
   ['Unrealized', unKnown ? fmtMoney(un, main) : '—', unKnown ? un : null],
   ['Realized', fmtMoney(rz, main), rz],
   ['Return', ret !== null ? fmtPct(ret) : '—', ret]].forEach(function (c) {
    var cardEl = statCard(c[0], c[1], c[2]);
    if (c[0] !== 'Value') {
      var sc = plClass(c[2]);
      if (sc) cardEl.querySelector('.card-value').classList.add(sc);
    }
    host.appendChild(cardEl);
  });
  var hv = document.getElementById('hero-value');
  var hvn = null;
  try { hvn = document.getElementById('hero-value-num'); } catch (e0) { hvn = null; }
  var hvTarget = hvn || hv;
  if (hvTarget) {
    hvTarget.textContent = rows.length ? (mvKnown ? fmtMoney(mv, main) : '—') : '—';
  }
  if (hv) hv.title = hvTarget ? hvTarget.textContent : '';
  fitHeroValue();
  // Invested amount: lifetime gross in (every buy + valued income at its
  // locked historical rate) — never reduced by sells, fees or transfers.
  // Sits between value and pill on one small line; truncates, never resizes
  // the box.
  var hi = document.getElementById('hero-invested');
  if (hi) {
    if (!rows.length) {
      hi.textContent = '';
      hi.hidden = true;
    } else {
      var inv = 0;
      try {
        var dtrInv = dtradesOpt || convertTrades(st.trades, main);
        dtrInv.forEach(function (t) {
          if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
          var q = Number(t.qty);
          if (!isFinite(q) || q <= 0) return;
          var nn = normalizeTrade(t);
          if (isFinite(nn.netMain) && nn.netMain > 0) inv += nn.netMain;
        });
      } catch (e) { inv = 0; }
      hi.hidden = false;
      hi.textContent = 'INVESTED AMOUNT: ' + fmtMoney(inv, main);
    }
  }
  // Spent amount: lifetime gross fiat out — sell proceeds, the cash legs of
  // expense and transfer records, plus crypto fees and crypto expenses
  // valued at the frozen tx-date rate (the same ≈ the cards show; 0 while
  // the rate is unknown, never a guess). Each leg uses its locked
  // historical rate. Never reduced by anything; appreciation can push it
  // above invested. feeMain is never added: the all-in totals include it.
  var hs = document.getElementById('hero-spent');
  if (hs) {
    if (!rows.length) {
      hs.textContent = '';
      hs.hidden = true;
    } else {
      var spent = 0;
      try {
        var dtrSpent = dtradesOpt || convertTrades(st.trades, main);
        var kindsSpent = {};
        try {
          (st.accounts || []).forEach(function (a) {
            if (a && a.ticker) kindsSpent[String(a.ticker).toUpperCase()] = a.kind;
          });
        } catch (e) { kindsSpent = {}; }
        dtrSpent.forEach(function (t) {
          if (!t) return;
          var sn = normalizeTrade(t);
          if (t.type === 'sell') {
            if (isFinite(sn.totalMain) && sn.totalMain > 0) spent += sn.totalMain;
          } else if (t.type === 'expense' || t.type === 'transfer') {
            if (isFinite(sn.netMain) && sn.netMain > 0) spent += sn.netMain;
            var cq = (t.type === 'transfer')
              ? ((t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee))
              : ((t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? 0 : Number(t.qty));
            if (isFinite(cq) && cq > 0) {
              var sym = String(t.symbol || '').toUpperCase();
              var kd = kindsSpent[sym];
              var kr = null;
              try { kr = resolveExecPrice(t, main, (typeof kd === 'string') ? kd : undefined); } catch (e) { kr = null; }
              if (kr !== null && isFinite(Number(kr.price)) && Number(kr.price) > 0) {
                spent += cq * Number(kr.price);
              }
            }
          }
        });
      } catch (e) { spent = 0; }
      hs.hidden = false;
      hs.textContent = 'SPENT AMOUNT: ' + fmtMoney(spent, main);
    }
  }
  var hp = document.getElementById('hero-pl');
  if (hp) {
    if (!rows.length || !plKnown) {
      hp.textContent = '';
      hp.className = 'hero-pl';
    } else {
      // Arrow carries the direction; show magnitude so signs never glue (▼-€0.14).
      hp.textContent = fmtMoney(Math.abs(pl), main);
      hp.className = 'hero-pl pill ' + plClass(pl);
    }
  }
}

var accountFilterOpen = false;
var accountFilterFocus = null;
var accountFilterOutsideWired = false;
var selectionMode = false;
var selectedAccounts = {}; // id -> true; survives page flips and re-renders (in-memory working set)
var accountActionOpen = false;

// View filter: null = show every asset, otherwise exactly these tickers.
// Persisted in settings (backup/restore carry it); absent key means all.
function selectedTickers(st) {
  var f = st && st.settings ? st.settings.accountFilter : null;
  if (f === undefined || f === null) return null;
  return normalizeAccountFilter(f);
}

function accountTickers(accounts) {
  var seen = {};
  var out = [];
  (accounts || []).forEach(function (a) {
    var t = String((a && a.ticker) || '').toUpperCase();
    if (!t || seen[t]) return;
    seen[t] = true;
    out.push(t);
  });
  return out.sort();
}

function setAccountFilter(next, focusTicker) {
  var st = loadState();
  st.settings = st.settings || { mainCurrency: 'EUR', costMethod: 'average' };
  if (next === null) {
    try {
      delete st.settings.accountFilter;
    } catch (e) {
      st.settings.accountFilter = null;
    }
  } else {
    st.settings.accountFilter = next;
  }
  accountFilterFocus = focusTicker || null;
  if (!saveStateGuarded(st)) return;
  render();
}

function closeAccountFilter(moveFocus) {
  if (!accountFilterOpen) return;
  accountFilterOpen = false;
  accountFilterFocus = null;
  var host = document.getElementById('accounts');
  var panel = host && host.querySelector ? host.querySelector('[data-filter-panel]') : null;
  var btn = host && host.querySelector ? host.querySelector('[data-filter-btn]') : null;
  if (panel) panel.hidden = true;
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    if (moveFocus && btn.focus) {
      try { btn.focus(); } catch (e) { /* ignore */ }
    }
  }
}

function restoreAccountFilterFocus() {
  if (!accountFilterOpen || !accountFilterFocus) {
    accountFilterFocus = null;
    return;
  }
  try {
    var host = document.getElementById('accounts');
    var el = host && host.querySelector ? host.querySelector('[data-ticker="' + accountFilterFocus + '"]') : null;
    if (el && el.focus) el.focus();
  } catch (e) { /* ignore */ }
  accountFilterFocus = null;
}

function selectedCount() {
  return Object.keys(selectedAccounts).length;
}

function cancelSelection() {
  selectionMode = false;
  selectedAccounts = {};
  accountActionOpen = false;
  render();
}

function toggleAccountSelect(id) {
  if (!id) return;
  if (selectedAccounts[id]) delete selectedAccounts[id];
  else selectedAccounts[id] = true;
  syncSelectionUI();
}

// Paint-only sync (no re-render): cards, count and Action follow the set,
// so rapid multi-select keeps focus and the filter panel stays open.
function syncSelectionUI() {
  var n = selectedCount();
  try {
    var host = document.getElementById('accounts');
    if (host && host.querySelectorAll) {
      Array.prototype.forEach.call(host.querySelectorAll('.account-card'), function (card) {
        var id = card.getAttribute ? card.getAttribute('data-account') : null;
        var on = !!id && !!selectedAccounts[id];
        if (card.classList) card.classList.toggle('selected', on);
        var cb = card.querySelector ? card.querySelector('[data-select-check]') : null;
        if (cb) cb.checked = on;
      });
    }
    if (host && host.querySelector) {
      var count = host.querySelector('[data-select-count]');
      if (count) {
        count.textContent = n + ' selected';
        count.hidden = !(selectionMode && n > 0);
      }
      var awrap = host.querySelector('[data-action-wrap]');
      if (awrap) awrap.hidden = !(selectionMode && n > 0);
    }
  } catch (e) { /* ignore */ }
}

function closeAccountAction() {
  if (!accountActionOpen) return;
  accountActionOpen = false;
  var host = document.getElementById('accounts');
  var panel = host && host.querySelector ? host.querySelector('[data-action-panel]') : null;
  var btn = host && host.querySelector ? host.querySelector('[data-action-btn]') : null;
  if (panel) panel.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function applyColorToSelection(hex) {
  var st = loadState();
  var ids = Object.keys(selectedAccounts).filter(function (id) { return !!accountById(st, id); });
  if (!ids.length) return;
  if (hex !== null) {
    if (!isValidHexColor(hex)) {
      showBanner('Pick a valid color, e.g. #F7931A.');
      return;
    }
    hex = String(hex).trim().toUpperCase();
  }
  ids.forEach(function (id) {
    var a = accountById(st, id);
    if (!a) return;
    if (hex === null) {
      try {
        delete a.color;
      } catch (e) {
        a.color = undefined;
      }
    } else {
      a.color = hex;
    }
  });
  if (!saveStateGuarded(st)) return;
  clearBanner();
  closeDialog('color-dialog');
  render(); // stay in selection mode with the set intact
}

function buildAccountAction() {
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  wrap.setAttribute('data-action-wrap', '1');
  var n = selectedCount();
  wrap.hidden = !(selectionMode && n > 0);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-action-btn', '1');
  btn.textContent = 'Action';
  btn.setAttribute('aria-label', 'Bulk actions for selected accounts');
  btn.setAttribute('aria-expanded', accountActionOpen ? 'true' : 'false');
  btn.addEventListener('click', function () {
    accountActionOpen = !accountActionOpen;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel';
  panel.setAttribute('data-action-panel', '1');
  panel.hidden = !accountActionOpen;
  var col = document.createElement('button');
  col.type = 'button';
  col.className = 'action-opt';
  col.textContent = 'Change color';
  col.setAttribute('aria-label', 'Change color of selected accounts');
  col.addEventListener('click', function () {
    accountActionOpen = false;
    panel.hidden = true;
    var host = document.getElementById('accounts');
    var tgl = host && host.querySelector ? host.querySelector('[data-action-btn]') : null;
    if (tgl) tgl.setAttribute('aria-expanded', 'false');
    openDialog('color-dialog');
  });
  panel.appendChild(col);
  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'action-del';
  del.textContent = 'Delete';
  del.setAttribute('aria-label', 'Delete selected accounts and their trades');
  del.addEventListener('click', function () {
    accountActionOpen = false;
    var total = selectedCount();
    confirmAction('Delete accounts', 'Delete ' + total + (total === 1 ? ' account' : ' accounts') + ' and all their trades? This cannot be undone.', 'Delete', true).then(function (ok) {
      if (!ok) return;
      var s2 = loadState();
      var inSet = {};
      Object.keys(selectedAccounts).forEach(function (id) {
        if (accountById(s2, id)) inSet[id] = true;
      });
      if (!Object.keys(inSet).length) {
        selectedAccounts = {};
        selectionMode = false;
        render();
        return;
      }
      // Owned trades go; transfers pointing into the set go too — otherwise
      // the next load would silently drop the survivors' half of the move.
      s2.trades = (s2.trades || []).filter(function (t) {
        return !t || (!inSet[t.accountId] && !inSet[t.toAccountId]);
      });
      s2.accounts = (s2.accounts || []).filter(function (a) { return !a || !inSet[a.id]; });
      selectedAccounts = {};
      selectionMode = false;
      if (!saveStateGuarded(s2)) return;
      clearBanner();
      render();
    });
  });
  panel.appendChild(del);
  wrap.appendChild(panel);
  return wrap;
}

function buildAccountFilter(st, tickers, effective) {
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-filter-btn', '1');
  var f = selectedTickers(st);
  btn.textContent = (f === null) ? 'Filter' : ('Filter · ' + f.length);
  btn.setAttribute('aria-label', 'Filter accounts by asset');
  btn.setAttribute('aria-expanded', accountFilterOpen ? 'true' : 'false');
  btn.addEventListener('click', function () {
    accountFilterOpen = !accountFilterOpen;
    accountFilterFocus = null;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel';
  panel.setAttribute('data-filter-panel', '1');
  panel.hidden = !accountFilterOpen;
  var title = document.createElement('p');
  title.className = 'filter-title';
  title.textContent = 'Show assets';
  panel.appendChild(title);
  function optRow(labelText, checked, ticker) {
    var lab = document.createElement('label');
    lab.className = 'filter-opt';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    if (ticker === null) cb.setAttribute('data-filter-all', '1');
    else cb.setAttribute('data-ticker', ticker);
    var sp = document.createElement('span');
    sp.textContent = labelText;
    lab.appendChild(cb);
    lab.appendChild(sp);
    cb.addEventListener('change', function () {
      if (ticker === null) {
        setAccountFilter(cb.checked ? null : [], null);
        return;
      }
      var cur = effective.slice();
      var ix = cur.indexOf(ticker);
      if (cb.checked && ix === -1) cur.push(ticker);
      if (!cb.checked && ix !== -1) cur.splice(ix, 1);
      var coversAll = tickers.length > 0 && tickers.every(function (t) { return cur.indexOf(t) !== -1; });
      setAccountFilter(coversAll ? null : cur.sort(), ticker);
    });
    return lab;
  }
  var counts = {};
  (st.accounts || []).forEach(function (a) {
    var t = String((a && a.ticker) || '').toUpperCase();
    if (t) counts[t] = (counts[t] || 0) + 1;
  });
  panel.appendChild(optRow('All', effective.length === tickers.length && tickers.length > 0, null));
  tickers.forEach(function (t) {
    var n = counts[t] || 0;
    panel.appendChild(optRow(t + (n ? ' · ' + n : ''), effective.indexOf(t) !== -1, t));
  });
  wrap.appendChild(panel);
  return wrap;
}

function renderAccounts(st) {
  var host = document.getElementById('accounts');
  if (!host) return;
  var method = st.settings.costMethod;
  var main = st.settings.mainCurrency;
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  // View filter: only the selected assets render (cards + totals).
  var filter = selectedTickers(st);
  var visibleAccounts = filter === null
    ? accounts
    : accounts.filter(function (a) { return filter.indexOf(String(a.ticker).toUpperCase()) !== -1; });
  // Display conversion: native amounts stay in stone; everything shown is
  // converted into the CURRENT main at historical ECB rates (cached).
  var dtrades = convertTrades(st.trades, main);
  // Joint portfolio engine: one date-ordered pass keeps per-account cost
  // queues separate (so AGGREGATE-BEATS-GLOBAL holds for buy/sell), while
  // transfers move basis from source to dest at the source's basis — the
  // on-chain network fee + any fiat fee land as real losses. Each account's
  // rows are read from the joint run and reused for its card below, so
  // cards and grand totals agree by construction.
  var pf = null;
  try { pf = computePortfolio(dtrades, livePrices, method); } catch (e) { pf = null; }
  var perAcctRows;
  if (pf && pf.byAccount) {
    perAcctRows = visibleAccounts.map(function (acc) {
      var m = pf.byAccount[acc.id];
      if (!m) return [];
      var arr = [];
      m.forEach(function (r) { arr.push(r); });
      arr.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
      return arr;
    });
  } else {
    // Fallback: independent per-account runs (no transfers in legacy data).
    perAcctRows = visibleAccounts.map(function (acc) {
      return computePositions(accountTrades({ trades: dtrades }, acc.id), livePrices, method);
    });
  }
  var grandRows = [];
  perAcctRows.forEach(function (rows) {
    rows.forEach(function (r) { grandRows.push(r); });
  });
  renderSummaryCards(st, grandRows, dtrades, visibleAccounts.length);
  // Paged cards, global totals: only the current page renders, while hero,
  // summary and counts always cover every visible account.
  var rowsById = {};
  visibleAccounts.forEach(function (acc, vi) { rowsById[acc.id] = perAcctRows[vi]; });
  var pageCount = Math.max(1, Math.ceil(visibleAccounts.length / ACCOUNT_PAGE_SIZE));
  if (accountPage > pageCount - 1) accountPage = pageCount - 1;
  if (accountPage < 0) accountPage = 0;
  var pageAccounts = visibleAccounts.slice(accountPage * ACCOUNT_PAGE_SIZE, accountPage * ACCOUNT_PAGE_SIZE + ACCOUNT_PAGE_SIZE);
  host.innerHTML = '';
  var landing = document.getElementById('landing');
  var hero = document.getElementById('hero');
  var overview = document.getElementById('overview');
  var fab = document.getElementById('fab-trade');
  var emptyState = !accounts.length;
  var noTrades = !emptyState && !(st.trades || []).length;
  if (landing) landing.hidden = !emptyState;
  if (hero) hero.hidden = emptyState || noTrades;
  if (overview) overview.hidden = emptyState || noTrades;
  if (fab) fab.hidden = emptyState || noTrades;
  document.body.classList.toggle('is-empty', emptyState);
  document.body.classList.toggle('has-no-trades', noTrades);
  if (emptyState) {
    wireLanding();
    return;
  }
  if (noTrades) {
    host.appendChild(buildGuidePanel());
  }
  var headRow = document.createElement('div');
  headRow.className = 'section-head';
  var h2 = document.createElement('h2');
  h2.textContent = 'Accounts';
  h2.className = 'section-title';
  headRow.appendChild(h2);
  var actions = document.createElement('div');
  actions.className = 'section-actions';
  var tickers = accountTickers(accounts);
  var effective = filter === null ? tickers : filter;
  var nSel = selectedCount();
  if (selectionMode) {
    var countEl = document.createElement('span');
    countEl.className = 'muted select-count';
    countEl.setAttribute('data-select-count', '1');
    countEl.textContent = nSel + ' selected';
    countEl.hidden = nSel === 0;
    actions.appendChild(countEl);
    actions.appendChild(buildAccountAction());
  }
  var selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'ghost' + (selectionMode ? ' select-on' : '');
  selectBtn.setAttribute('data-select-btn', '1');
  selectBtn.textContent = 'Select';
  selectBtn.setAttribute('aria-label', 'Select accounts');
  selectBtn.setAttribute('aria-pressed', selectionMode ? 'true' : 'false');
  selectBtn.addEventListener('click', function () {
    if (selectionMode) cancelSelection();
    else { selectionMode = true; render(); }
  });
  actions.appendChild(selectBtn);
  actions.appendChild(buildAccountFilter(st, tickers, effective));
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ghost';
  addBtn.textContent = '+ Account';
  addBtn.setAttribute('aria-label', 'Create account');
  addBtn.addEventListener('click', function () { openAccountDialog(); });
  actions.appendChild(addBtn);
  headRow.appendChild(actions);
  host.appendChild(headRow);
  if (!visibleAccounts.length) {
    if (hero) hero.hidden = true;
    if (overview) overview.hidden = true;
    if (fab) fab.hidden = true;
    var noneNote = document.createElement('p');
    noneNote.className = 'muted';
    noneNote.textContent = 'No accounts match this filter — pick assets in Filter above.';
    host.appendChild(noneNote);
    restoreAccountFilterFocus();
    return;
  }
  pageAccounts.forEach(function (acc) {
    var card = document.createElement('article');
    card.className = 'account-card';
    card.setAttribute('data-account', acc.id);
    card.setAttribute('data-account-nav', acc.id);
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'link');
    card.setAttribute('aria-label', 'Open ' + acc.name + ', ' + String(acc.ticker).toUpperCase());
    var grip = document.createElement('span');
    grip.className = 'drag-handle';
    grip.title = 'Drag to reorder';
    grip.setAttribute('aria-hidden', 'true');
    card.appendChild(grip);
    var avatar = document.createElement('span');
    avatar.className = 'acct-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = String(acc.ticker || '?').substring(0, 4).toUpperCase();
    if (acc.color && isValidHexColor(acc.color)) {
      card.setAttribute('data-colored', '1');
      try {
        card.style.setProperty('--acct-color', String(acc.color).trim().toUpperCase());
        avatar.style.color = contrastText(acc.color);
      } catch (e) { /* ignore */ }
    }
    card.appendChild(avatar);
    var mid = document.createElement('span');
    mid.className = 'acct-mid';
    var nameEl = document.createElement('span');
    nameEl.className = 'account-name';
    nameEl.textContent = acc.name;
    mid.appendChild(nameEl);
    var tickEl = document.createElement('span');
    tickEl.className = 'account-ticker';
    tickEl.textContent = String(acc.ticker).toUpperCase();
    mid.appendChild(tickEl);
    card.appendChild(mid);
    var atrades = accountTrades({ trades: dtrades }, acc.id);
    var rows = rowsById[acc.id] || []; // joint run above, same data as the totals
    var pl = 0;
    var mv = 0;
    var mvKnown = false;
    rows.forEach(function (r) {
      pl += r.totalPL;
      if (r.marketValue !== null) { mv += r.marketValue; mvKnown = true; }
    });
    var figs = document.createElement('span');
    figs.className = 'acct-figs';
    var valv = document.createElement('span');
    valv.className = 'acct-value';
    valv.textContent = mvKnown ? fmtMoney(mv, main) : (atrades.length ? '—' : 'New');
    figs.appendChild(valv);
    var plv = document.createElement('span');
    var hasKnownPl = rows.some(function (r) { return r.unrealized !== null || Math.abs(r.realized || 0) > 1e-9; });
    plv.className = 'acct-pl ' + plClass(pl);
    plv.textContent = hasKnownPl ? fmtMoney(pl, main) : (atrades.length ? '—' : 'New');
    if (isFinite(Number(pl)) && hasKnownPl) plv.setAttribute('data-value', String(Number(pl)));
    figs.appendChild(plv);
    card.appendChild(figs);
    if (selectionMode) {
      var cbx = document.createElement('input');
      cbx.type = 'checkbox';
      cbx.className = 'card-check';
      cbx.setAttribute('data-select-check', acc.id);
      cbx.checked = !!selectedAccounts[acc.id];
      cbx.setAttribute('aria-label', 'Select ' + acc.name);
      cbx.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); });
      cbx.addEventListener('change', function () { toggleAccountSelect(acc.id); });
      if (cbx.checked) card.classList.add('selected');
      card.appendChild(cbx);
    }
    // Cards open on click (see nav wiring); the per-card buttons stay in the
    // DOM hidden for programmatic/test use so they never clutter the card.
    var tradeBtn = document.createElement('button');
    tradeBtn.type = 'button';
    tradeBtn.className = 'quiet';
    tradeBtn.textContent = '+ Record';
    tradeBtn.setAttribute('data-account-trade', acc.id);
    tradeBtn.setAttribute('aria-label', 'Add record to ' + acc.name);
    tradeBtn.hidden = true;
    card.appendChild(tradeBtn);
    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'quiet acct-open';
    openBtn.textContent = 'Open ›';
    openBtn.setAttribute('data-account-open', acc.id);
    openBtn.setAttribute('aria-label', 'Open ' + acc.name);
    openBtn.hidden = true;
    card.appendChild(openBtn);
    host.appendChild(card);
  });
  if (pageCount > 1) host.appendChild(buildAccountPager(pageCount));
  restoreAccountFilterFocus();
}

function buildAccountPager(pageCount) {
  var pager = document.createElement('div');
  pager.className = 'pager';
  pager.setAttribute('role', 'navigation');
  pager.setAttribute('aria-label', 'Account pages');
  function pgBtn(label, attrs, disabled, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost page-btn';
    b.textContent = label;
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) b.setAttribute(k, attrs[k]);
    }
    if (disabled) b.disabled = true;
    b.addEventListener('click', fn);
    return b;
  }
  pager.appendChild(pgBtn('‹ Prev', { 'data-page-prev': '1', 'aria-label': 'Previous account page' }, accountPage <= 0, function () {
    if (accountPage > 0) { accountPage--; render(); }
  }));
  // Sliding window: at most 6 page numbers at once (1–6, then 2–7, …).
  var PAGER_WINDOW = 6;
  var winStart = 0;
  if (pageCount > PAGER_WINDOW) {
    winStart = accountPage - 4;
    if (winStart < 0) winStart = 0;
    if (winStart > pageCount - PAGER_WINDOW) winStart = pageCount - PAGER_WINDOW;
  }
  for (var i = winStart; i < Math.min(winStart + PAGER_WINDOW, pageCount); i++) {
    (function (p) {
      var nb = pgBtn(String(p + 1), { 'data-page-goto': String(p), 'aria-label': 'Go to account page ' + (p + 1) }, false, function () {
        if (accountPage !== p) { accountPage = p; render(); }
      });
      if (p === accountPage) nb.setAttribute('aria-current', 'page');
      pager.appendChild(nb);
    })(i);
  }
  pager.appendChild(pgBtn('Next ›', { 'data-page-next': '1', 'aria-label': 'Next account page' }, accountPage >= pageCount - 1, function () {
    if (accountPage < pageCount - 1) { accountPage++; render(); }
  }));
  return pager;
}

function startInlineRename(accId, headEl, nameEl) {
  var st = loadState();
  var acc = accountById(st, accId);
  if (!acc || !headEl || !nameEl) return;
  if (headEl.querySelector('[data-rename-input]')) return;
  var input = document.createElement('input');
  input.setAttribute('data-rename-input', '1');
  input.value = acc.name;
  input.setAttribute('aria-label', 'New name for ' + acc.name);
  headEl.insertBefore(input, nameEl);
  headEl.removeChild(nameEl);
  try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    renameAccount(accId, input.value);
  }
  function cancel() {
    if (done) return;
    done = true;
    render();
  }
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

function startInlineLabelEdit(accId) {
  var st = loadState();
  var acc = accountById(st, accId);
  if (!acc) return;
  var host = document.getElementById('account-detail');
  if (!host || !host.querySelector) return;
  var block = host.querySelector('.detail-meta-block');
  var headEl = host.querySelector('.detail-head');
  if (!block && headEl) {
    block = document.createElement('div');
    block.className = 'detail-meta-block';
    headEl.appendChild(block);
  }
  if (!block || block.querySelector('[data-label-input]')) return;
  block.innerHTML = '';
  var input = document.createElement('textarea');
  input.setAttribute('data-label-input', '1');
  input.value = acc.address || '';
  input.setAttribute('aria-label', 'Label for ' + acc.name);
  input.setAttribute('maxlength', '128');
  input.setAttribute('rows', '3');
  input.setAttribute('placeholder', 'e.g. cold storage');
  input.setAttribute('autocomplete', 'off');
  var row = document.createElement('div');
  row.className = 'label-edit-row';
  var save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save';
  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  row.appendChild(save);
  row.appendChild(cancelBtn);
  block.appendChild(input);
  block.appendChild(row);
  try { input.focus(); input.select(); } catch (e) { /* ignore */ }
  var done = false;
  function commit() {
    if (done) return;
    done = true;
    var s2 = loadState();
    var a2 = accountById(s2, accId);
    if (!a2) return;
    var v = String(input.value === undefined || input.value === null ? '' : input.value).trim().slice(0, 128);
    if (v) a2.address = v;
    else {
      try {
        delete a2.address;
      } catch (e) {
        a2.address = undefined;
      }
    }
    if (!saveStateGuarded(s2)) { done = false; return; }
    clearBanner();
    render();
  }
  function cancelFn() {
    if (done) return;
    done = true;
    render();
  }
  save.addEventListener('click', commit);
  // Mousedown first: keep focus so blur-commit doesn't fire before Cancel.
  cancelBtn.addEventListener('mousedown', function (e) { if (e && e.preventDefault) e.preventDefault(); });
  cancelBtn.addEventListener('click', cancelFn);
  input.addEventListener('keydown', function (e) {
    // Plain Enter inserts a newline (multi-line label); Ctrl/Cmd+Enter saves.
    if ((e.key === 'Enter') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') cancelFn();
  });
  input.addEventListener('blur', commit);
}

// --- Account detail view (list → detail navigation) ---
// Home shows minimal folder cards; clicking one routes to #/account/<id>
// and this renders the full account page: header, figures, stacked position
// facts and trades, and a ··· menu (trade / default / rename / delete).
// Facts carry data-label/data-value, so numbers read top to bottom and the
// FX conversion always gets its own line. Unknown account id routes home.

function historyOK() {
  try {
    return typeof history !== 'undefined' && !!history.pushState &&
      String((typeof location !== 'undefined' && location.protocol) || '').indexOf('http') === 0;
  } catch (e) { return false; }
}

// Current account route, history path first (clean production URLs), hash
// fallback (file://, tests, legacy links).
function currentRouteId() {
  try {
    var p = String((typeof location !== 'undefined' && location.pathname) || '');
    var m = /^\/account\/([^\/?#]+)/.exec(p);
    if (m) return decodeURIComponent(m[1]);
  } catch (e) { /* fall through to hash */ }
  return accountDetailIdHash();
}

function accountDetailIdHash() {
  var h = String((typeof location !== 'undefined' && location.hash) || '');
  var hm = /^#\/account\/([^\/?#]+)/.exec(h);
  return hm ? decodeURIComponent(hm[1]) : null;
}

function accountDetailId() {
  return currentRouteId();
}

function navTo(id) {
  if (historyOK()) {
    try {
      history.pushState({ accountId: id || null }, '', id ? '/account/' + encodeURIComponent(id) : '/');
      route();
      return;
    } catch (e) { /* fall through to hash */ }
  }
  if (typeof location !== 'undefined') location.hash = id ? '#/account/' + encodeURIComponent(id) : '#/';
  route();
}

function navHome() {
  navTo(null);
}

// --- Stacked facts (minimalist detail layout) ---
// One fact per row: muted label left, tabular value right. Values carry
// data-label (stable test hook) and data-value when known; P&L figures
// tint gain/loss. The FX conversion always gets its own line so amounts
// never run into their provenance.

function statRow(label, text, raw, tint) {  var d = document.createElement('div');
  d.className = 'stat-row';
  d.setAttribute('data-label', label);
  var l = document.createElement('span');
  l.className = 'stat-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'stat-val num';
  v.textContent = text;
  if (raw !== null && raw !== undefined && isFinite(Number(raw))) {
    d.setAttribute('data-value', String(Number(raw)));
    if (tint) {
      var sc = plClass(raw);
      if (sc) v.classList.add(sc);
    }
  }
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

function sectionTitle(text) {
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = text;
  return h;
}

function fmtFeeAmount(t) {
  var f = Number(t.fee);
  if (!(isFinite(f) && f > 0)) return '—';
  // One fiat per trade: the fee is always denominated in the trade currency.
  var code = String(t.currency || '').toUpperCase();
  var fiatCodes = ['EUR', 'USD', 'GBP', 'CHF', 'RON', 'USDC', 'USDT', 'DAI', 'JPY', 'CAD', 'AUD'];
  if (fiatCodes.indexOf(code) !== -1 || /^[A-Z]{3}$/.test(code)) {
    // fiat-like: money; crypto-like fee (BTC/ETH) would be caught below? Keep money for 3-letter fiat, qty otherwise.
    if (['EUR', 'USD', 'GBP', 'CHF', 'RON', 'JPY', 'CAD', 'AUD'].indexOf(code) !== -1) {
      try { return moneyFmt(code).format(f); } catch (e) { return fmtQty(f) + ' ' + code; }
    }
  }
  return fmtQty(f) + ' ' + code;
}

function tradeTypeMeta(type) {
  if (type === 'sell') return { label: 'Sell', cls: 'side-sell' };
  if (type === 'transfer') return { label: 'Transfer', cls: 'side-transfer' };
  if (type === 'income') return { label: 'Income', cls: 'side-income' };
  if (type === 'expense') return { label: 'Expense', cls: 'side-expense' };
  return { label: 'Buy', cls: 'side-buy' };
}

function openNoteDialog(text, title) {
  var p = document.getElementById('note-dialog-text');
  if (p) p.textContent = String(text === undefined || text === null ? '' : text);
  var h = document.getElementById('note-dialog-title');
  if (h) h.textContent = title || 'Note';
  openDialog('note-dialog');
}

// Resolve the reference Exec quote for a trade row: {price, ccy} or null.
// Precedence is deliberate: a fiat-tagged global override is explicit live
// intent and always convertible; a frozen per-trade quote carries its own
// known fiat and beats a legacy bare-number override (whose fiat is unknown
// — showing it raw in a foreign main would be a nominal lie); the legacy
// number still serves when nothing better exists; then async history.
// Cross-fiat values convert at the trade-date historical rate; when the rate
// is unavailable the value shows in its OWN fiat, never nominal in the
// display fiat. Never throws; P&L never reads this (display-only).
function resolveExecPrice(t, main, kind) {
  var m = String(main || '').toUpperCase();
  if (!t || typeof t !== 'object' || !m) return null;
  function converted(price, vs) {
    var p = Number(price);
    var from = String(vs || '').trim().toUpperCase();
    if (!isFinite(p) || p <= 0 || !/^[A-Z]{2,10}$/.test(from)) return null;
    if (from === m) return { price: p, ccy: m };
    var hr = null;
    try { hr = getCachedRate(t.date, from, m); } catch (e) { hr = null; }
    if (hr && isFinite(Number(hr.rate)) && Number(hr.rate) > 0) {
      return { price: p * Number(hr.rate), ccy: m };
    }
    return { price: p, ccy: from };
  }
  var oe = null;
  try { oe = priceOverrideEntry(t.symbol); } catch (e) { oe = null; }
  if (oe !== null && oe.vs) return converted(oe.price, oe.vs);
  var fr = null;
  try { fr = frozenExecOf(t); } catch (e) { fr = null; }
  if (fr) return converted(fr.price, fr.vs);
  if (oe !== null) {
    var lp = Number(oe.price);
    if (isFinite(lp) && lp > 0) return { price: lp, ccy: m }; // legacy bare: old nominal behavior
    return null;
  }
  var hi = null;
  try { hi = getHistoricalExec(t.symbol, t.date, main, kind); } catch (e) { hi = null; }
  if (hi && isFinite(Number(hi.price)) && Number(hi.price) > 0) return { price: Number(hi.price), ccy: m };
  return null;
}

// Plain-language fee economics for transfer cards: what the fee was worth
// at move time vs what the books record (original cost). Numbers come from
// the record itself; nothing here touches P&L.
function openFeeExplainer(t, main, feeQty, rate) {
  var sym = String((t && t.symbol) || '').toUpperCase();
  var fq = Number(feeQty);
  var worth = (rate !== null && isFinite(fq) && fq > 0)
    ? fmtMoney(fq * rate.price, rate.ccy) : null;
  var rateTxt = (rate !== null)
    ? fmtMoney(rate.price, rate.ccy) + ' / ' + sym : null;
  var entry = 0;
  try {
    var st = loadState();
    var dtr = convertTrades(st.trades || [], main);
    var eng = computeAverage(dtr);
    var pos = eng.get(sym) || eng.get(String((t && t.symbol) || ''));
    if (pos && isFinite(Number(pos.avgEntry)) && Number(pos.avgEntry) > 0) entry = Number(pos.avgEntry);
  } catch (e) { entry = 0; }
  var lines = [];
  if (worth !== null && rateTxt !== null) {
    lines.push('Worth ' + worth + ' at the transfer-day price (' + rateTxt + ').');
  } else {
    lines.push('No rate known yet for this move — tap Fee in fiat rate to retry the lookup.');
  }
  if (worth !== null && entry > 0) {
    lines.push('Books record its ' + fmtMoney(fq * entry, main) + ' cost (your ' + fmtMoney(entry, main) + ' average entry) as the realized loss.');
    lines.push('The difference is the market move while you held — not an error.');
  } else if (worth !== null) {
    lines.push('Books record what those coins cost you when bought — not this market value.');
  }
  openNoteDialog(lines.join('\n'), 'Transfer fees');
}

// Discoverability for tap-for-info rows: an ⓘ badge on the label that
// opens the same popup as the value. Pass the value element when the popup
// only exists on overflow — syncInfoDots then hides decorative dots whose
// value fits. Omit it when the tap always opens something (Transfer fees).
function infoDot(labelEl, openFn, valueEl) {
  if (!labelEl || typeof openFn !== 'function') return;
  var dot = document.createElement('span');
  dot.className = 'info-dot';
  dot.textContent = 'ⓘ';
  dot.setAttribute('aria-hidden', 'true');
  labelEl.appendChild(dot);
  try { labelEl.style.cursor = 'pointer'; } catch (e) { /* ignore */ }
  labelEl.addEventListener('click', function () { try { openFn(); } catch (e) { /* ignore */ } });
  if (valueEl) {
    try { valueEl.setAttribute('data-info-cond', '1'); } catch (e) { /* ignore */ }
  }
}

// Overflow-gated dots mean something only when the value is actually
// truncated: hide the decorative ones after layout settles. The pointer
// follows the same truth — text cursor for fitting text, hand only where
// a tap does something. Runs on every paint and on resize (truncation
// follows width).
function syncInfoDots() {
  try {
    var vals = document.querySelectorAll('.stat-val[data-info-cond], .detail-meta-val[data-info-cond]');
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      var box = null;
      try { box = v.closest ? v.closest('.stat-row, .detail-meta') : null; } catch (e) { box = null; }
      if (!box) continue;
      var dot = box.querySelector('.info-dot');
      var lab = null;
      try { lab = box.querySelector('.stat-label, .detail-meta-label'); } catch (e) { lab = null; }
      var overflowing = false;
      try { overflowing = v.scrollWidth > v.clientWidth + 1; } catch (e) { overflowing = false; }
      if (dot) dot.style.display = overflowing ? '' : 'none';
      try { v.style.cursor = overflowing ? 'pointer' : ''; } catch (e) { /* ignore */ }
      if (lab) {
        try { lab.style.cursor = overflowing ? 'pointer' : ''; } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
}

function rateRow(label, text) {
  var rate = document.createElement('div');
  rate.className = 'stat-row rate-line';
  rate.setAttribute('data-label', label);
  var rl = document.createElement('span');
  rl.className = 'stat-label';
  rl.textContent = label;
  var rv = document.createElement('span');
  rv.className = 'stat-val muted';
  rv.textContent = text;
  rv.setAttribute('role', 'button');
  rv.setAttribute('tabindex', '0');
  rv.setAttribute('aria-label', 'Show full rate');
  function openRate() {
    // Popup only when the text actually overflows the row.
    if (rv.scrollWidth <= rv.clientWidth + 1) return;
    openNoteDialog(text, label);
  }
  rv.addEventListener('click', openRate);
  rv.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openRate();
    }
  });
  infoDot(rl, openRate, rv);
  rate.appendChild(rl);
  rate.appendChild(rv);
  return rate;
}

function tradeBlock(t, main, accountNameById, kind) {
  var n = normalizeTrade(t);
  // The Converted row only earns its place when there is something to
  // convert: same-fiat views would just print the native number twice.
  var tCcy = String(t.currency || '').toUpperCase();
  var showConverted = tCcy === '' || tCcy !== String(main || '').toUpperCase();
  var box = document.createElement('article');
  box.className = 'trade-block';
  box.setAttribute('data-trade', t.id || '');
  var head = document.createElement('div');
  head.className = 'trade-head';
  var meta = tradeTypeMeta(t.type);
  var side = document.createElement('span');
  side.className = 'side ' + meta.cls;
  side.textContent = meta.label;
  head.appendChild(side);
  var whatTxt = '';
  if (t.type === 'transfer' && t.toAccountId && accountNameById) {
    try {
      var fn = accountNameById(t.accountId);
      var tn = accountNameById(t.toAccountId);
      if (fn || tn) whatTxt = (fn || '') + ' → ' + (tn || '');
    } catch (e) { /* ignore */ }
  }
  if (t.swapId) whatTxt += (whatTxt ? ' · ' : '') + 'swap';
  if (whatTxt) {
    var what = document.createElement('span');
    what.className = 'trade-what';
    what.textContent = whatTxt;
    head.appendChild(what);
  }
  var when = document.createElement('span');
  when.className = 'trade-when muted';
  when.textContent = t.date || '';
  head.appendChild(when);
  var edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'quiet trade-edit';
  edit.textContent = '✎';
  edit.setAttribute('data-edit', t.id || '');
  edit.setAttribute('aria-label', 'Edit record ' + String(t.symbol || '') + ' ' + String(t.date || ''));
  edit.addEventListener('click', function () { openEditTrade(edit.getAttribute('data-edit')); });
  head.appendChild(edit);
  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'quiet danger trade-del';
  del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  del.setAttribute('data-del', t.id || '');
  del.setAttribute('aria-label', 'Delete trade ' + String(t.symbol || '') + ' ' + String(t.date || ''));
  del.addEventListener('click', function () { deleteTrade(del.getAttribute('data-del')); });
  head.appendChild(del);
  box.appendChild(head);
  var isXfer = t.type === 'transfer';
  // Transfer fee valuation: the network fee in fiat at the frozen tx-date
  // rate. Resolved once here and reused by the Transfer fees (≈) and Fee Fiat
  // Rate rows; null (→ '—') when nothing is known, never a guess.
  var xferFee = 0;
  var xferRate = null;
  if (isXfer) {
    var nfRawX = (t.networkFee === undefined || t.networkFee === null) ? '' : String(t.networkFee).trim();
    xferFee = (nfRawX === '') ? 0 : Number(t.networkFee);
    if (!isFinite(xferFee) || xferFee < 0) xferFee = 0;
    try { xferRate = resolveExecPrice(t, main, kind); } catch (e) { xferRate = null; }
  }
  if (t.type === 'transfer') {
    var tSym = String(t.symbol || '').toUpperCase();
    var netQ = Number(t.qty) - xferFee;
    box.appendChild(statRow('Moved', fmtQty(t.qty) + ' ' + tSym, t.qty, false));
    if (xferFee > 0) {
      var feeTxtT = fmtQty(t.networkFee) + ' ' + tSym;
      if (xferRate !== null) feeTxtT += ' (≈ ' + fmtMoney(xferFee * xferRate.price, xferRate.ccy) + ')';
      var feeRowT = statRow('Transfer fees', feeTxtT, t.networkFee, false);
      // Tap explains the two numbers in plain language (market worth vs
      // booked cost) — the card stays clean, the math stays one tap away.
      var feeValT = feeRowT.querySelector('.stat-val');
      var feeLabT = feeRowT.querySelector('.stat-label');
      if (feeValT) {
        feeValT.setAttribute('role', 'button');
        feeValT.setAttribute('tabindex', '0');
        feeValT.setAttribute('aria-label', 'Explain the transfer fee');
        feeValT.title = 'Tap to explain this fee';
        (function (tr, mn, fq, rt) {
          function open() { try { openFeeExplainer(tr, mn, fq, rt); } catch (e) { /* ignore */ } }
          feeValT.addEventListener('click', open);
          feeValT.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
          });
          infoDot(feeLabT, open);
        })(t, main, xferFee, xferRate);
      }
      box.appendChild(feeRowT);
      // Fee in fiat rate sits right after Transfer fees — it is the rate behind
      // the (≈) above, frozen at the tx date. Unknown: tap retries the
      // lookup on demand instead of waiting for the backoff.
      var feeRateTxt = (xferRate !== null)
        ? fmtMoney(xferRate.price, xferRate.ccy) + ' / ' + tSym
        : '—';
      var feeRateEl = rateRow('Fee in fiat rate', feeRateTxt);
      if (xferRate === null) {
        feeRateEl.title = feeRateWhy(t, kind);
        (function (el, id) {
          el.addEventListener('click', function () {
            try { retryFeeRate(id); } catch (e) { /* ignore */ }
          });
        })(feeRateEl, t.id);
      }
      box.appendChild(feeRateEl);
    }
    box.appendChild(statRow('Received', fmtQty(netQ) + ' ' + tSym, netQ, false));
    if ((Number(t.total) > 0 || Number(t.fee) > 0)) {
      box.appendChild(statRow('Fiat cost', fmtMoney(n.netMain, main), n.netMain, false));
    }
  } else if (t.type === 'income') {
    box.appendChild(statRow('Received', fmtQty(t.qty) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false));
    if (Number(t.total) > 0) {
      box.appendChild(statRow('Value', fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false));
      if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    } else {
      box.appendChild(statRow('Value', '— (free)', null, false));
    }
  } else if (t.type === 'expense') {
    if (t.qty !== undefined && t.qty !== null && String(t.qty).trim() !== '') {
      box.appendChild(statRow('Lost', fmtQty(t.qty) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false));
    }
    if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '' && Number(t.total) > 0) {
      box.appendChild(statRow('Fiat lost', fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false));
      if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    }
  } else {
    box.appendChild(statRow('Paid', fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false));
    if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    // Real price is calculated, never quoted: the FULL all-in total converted
    // at the historical FX rate (or manual rate), divided by qty received —
    // e.g. 50 EUR / 0.00058193 BTC = 85920.99. Shown rounded half-up to 2
    // decimals; the books run on this exact value (== Average entry). Exec is
    // the reference-only market quote resolved by resolveExecPrice(); it never
    // touches P&L; "—" only when nothing is known (never 0, never a guess).
    var pq = Number(t.qty);
    if (isFinite(pq) && pq > 0 && n.netMain > 0) {
      var symU = String(t.symbol || '').toUpperCase();
      var realP = n.netMain / pq;
      var ex = null;
      try { ex = resolveExecPrice(t, main, kind); } catch (e) { ex = null; }
      if (ex !== null) {
        box.appendChild(statRow('Exec. price', fmtMoney(ex.price, ex.ccy) + ' / ' + symU, ex.price, false));
      } else {
        box.appendChild(statRow('Exec. price', '—', null, false));
      }
      box.appendChild(statRow('Real price', fmtMoney(realP, main) + ' / ' + symU, realP, false));
    }
  }
  // Same-asset moves have no FX: the meaningless '1:1 @ 1' Rate is gone for
  // transfers (Fee in fiat rate lives next to Transfer fees instead), and the
  // fiat Fee row is gone too — the network fee IS the fee.
  if (!isXfer) {
    box.appendChild(rateRow('Rate', fxBadgeText(t)));
  }
  if (!isXfer) {
  var feeRow = statRow('Fee', fmtFeeAmount(t), t.fee, false);
  box.appendChild(feeRow);
  }
  if (t.note) {
    var noteRow = statRow('Note', String(t.note), null, false);
    var noteVal = noteRow.querySelector('.stat-val');
    if (noteVal) {
      noteVal.classList.add('note-clamp');
      noteVal.setAttribute('role', 'button');
      noteVal.setAttribute('tabindex', '0');
      noteVal.setAttribute('aria-label', 'Show full note');
      noteVal.title = String(t.note);
      (function (val, txt) {
        function open() {
          // Popup only when the text actually overflows the row.
          if (val.scrollWidth <= val.clientWidth + 1) return;
          openNoteDialog(txt);
        }
        val.addEventListener('click', open);
        val.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        });
        infoDot(noteRow.querySelector('.stat-label'), open, val);
      })(noteVal, t.note);
    }
    box.appendChild(noteRow);
  }
  if (t.txid && isValidTxid(t.txid)) {
    var txFull = String(t.txid).trim();
    var txRow = document.createElement('div');
    txRow.className = 'stat-row';
    txRow.setAttribute('data-label', 'Tx');
    var txL = document.createElement('span');
    txL.className = 'stat-label';
    txL.textContent = 'Tx';
    var txV = document.createElement('span');
    txV.className = 'stat-val num';
    var txA = document.createElement('a');
    txA.className = 'tx-link';
    txA.href = txExplorerUrl(txFull);
    txA.target = '_blank';
    txA.rel = 'noopener';
    txA.textContent = shortTxid(txFull);
    txA.title = txFull;
    txV.appendChild(txA);
    txRow.appendChild(txL);
    txRow.appendChild(txV);
    box.appendChild(txRow);
  }
  if (t.type === 'buy' || t.type === 'sell') {
    box.appendChild(statRow('Amount', fmtQty(t.qty) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false));
  }
  // One true facts line: gather every fact row into a non-wrapping strip so
  // nothing ever spills to a second row — long values trim with … instead
  // (Rate/Note are capped; the popup still opens the full text on click).
  var facts = document.createElement('div');
  facts.className = 'trade-facts';
  Array.prototype.forEach.call(box.querySelectorAll(':scope > .stat-row'), function (r) { facts.appendChild(r); });
  box.appendChild(facts);
  return box;
}

function detailMetaRow(label, text, title) {
  var d = document.createElement('div');
  d.className = 'detail-meta';
  d.setAttribute('data-label', label);
  // Account labels stack: caption on top, wrapped text underneath.
  if (String(label) === 'Label') d.classList.add('detail-meta-stacked');
  var l = document.createElement('span');
  l.className = 'detail-meta-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'detail-meta-val';
  // Account labels are multi-line by design: wrap them fully instead of
  // trimming to one line. Notes keep the trim + popup treatment.
  if (String(label) === 'Label') v.classList.add('detail-meta-multiline');
  v.textContent = String(text);
  v.title = String(text);
  v.setAttribute('role', 'button');
  v.setAttribute('tabindex', '0');
  v.setAttribute('aria-label', 'Show full ' + String(title).toLowerCase());
  function open() {
    if (v.scrollWidth <= v.clientWidth + 1) return;
    openNoteDialog(text, title);
  }
  v.addEventListener('click', open);
  v.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  // Wrapped rows (multi-line labels) show everything: no hidden info, no dot.
  if (!v.classList.contains('detail-meta-multiline')) infoDot(l, open, v);
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

function renderAccountDetail(st, id) {
  var host = document.getElementById('account-detail');
  if (!host) return;
  var acc = accountById(st, id);
  if (!acc) {
    navHome();
    return;
  }
  var main = st.settings.mainCurrency;
  var method = st.settings.costMethod;
  var dtrades = convertTrades(st.trades, main);
  var rows = [];
  try {
    var pfDet = computePortfolio(dtrades, livePrices, method);
    var mDet = pfDet.byAccount[id];
    if (mDet) mDet.forEach(function (r) { rows.push(r); });
    rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  } catch (e) {
    rows = computePositions(accountTrades({ trades: dtrades }, acc.id), livePrices, method);
  }
  var atrades = accountTrades({ trades: dtrades }, acc.id);
  host.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'account-head detail-head';
  var nameEl = document.createElement('h1');
  nameEl.className = 'account-name detail-name';
  nameEl.textContent = acc.name;
  head.appendChild(nameEl);
  var chip = document.createElement('span');
  chip.className = 'ticker-chip';
  var lv = livePrices[String(acc.ticker || '').toUpperCase()];
  var lvNum = Number(lv);
  chip.textContent = String(acc.ticker).toUpperCase() + ((isFinite(lvNum) && lvNum > 0) ? ' · ' + fmtMoney(lvNum, main) : '');
  head.appendChild(chip);
  var menu = document.createElement('details');
  menu.className = 'menu';
  var sum = document.createElement('summary');
  sum.textContent = '···';
  sum.setAttribute('aria-label', 'Account options');
  menu.appendChild(sum);
  var mbox = document.createElement('div');
  mbox.className = 'menu-box';
  function menuBtn(text, label, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label + ' ' + acc.name);
    b.addEventListener('click', function () {
      menu.removeAttribute('open');
      fn();
    });
    mbox.appendChild(b);
    return b;
  }
  menuBtn('Rename', 'Rename', function () { startInlineRename(acc.id, head, nameEl); });
  menuBtn('Edit label', 'Edit label for', function () { startInlineLabelEdit(acc.id); });
  menuBtn('Delete', 'Delete', function () { deleteAccount(acc.id); });
  menu.appendChild(mbox);
  head.appendChild(menu);
  host.appendChild(head);
  // Optional free-text label entered at creation (wallet, note, anything) —
  // shown inside the header box with popup-on-overflow like trade notes.
  var metaBlock = null;
  function addMeta(label, text, title) {
    if (!metaBlock) {
      metaBlock = document.createElement('div');
      metaBlock.className = 'detail-meta-block';
      head.appendChild(metaBlock);
    }
    metaBlock.appendChild(detailMetaRow(label, text, title));
  }
  if (acc.address) addMeta('Label', acc.address, 'Label');
  if (acc.note) addMeta('Note', acc.note, 'Account note');
  var stats = document.createElement('div');
  stats.className = 'cards detail-stats';
  var pl = 0;
  var mv = 0;
  var mvKnown = false;
  var un = 0;
  var unKnown = false;
  var rz = 0;
  rows.forEach(function (r) {
    rz += r.realized;
    pl += r.totalPL;
    if (r.marketValue !== null) { mv += r.marketValue; mvKnown = true; }
    if (r.unrealized !== null) { un += r.unrealized; unKnown = true; }
  });
  var cost = mv - un;
  var ret = null;
  // Lifetime return: realized+unrealized vs lifetime buy+income cost (consistent with overview).
  var lifetimeForRet = 0;
  try {
    atrades.forEach(function (t) {
      if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
      var cn = normalizeTrade(t);
      // For transfers-in, cost is already in dest's buy-like inflow? No: transfers carry basis via joint engine, but lifetime here should count original buys+income only (transfers move, not new money).
      // atrades includes transfer-in with no total (total 0) so it adds 0 — safe.
      lifetimeForRet += cn.netMain + cn.feeLossMain;
    });
  } catch (e) { lifetimeForRet = 0; }
  if (lifetimeForRet <= 0) lifetimeForRet = cost; // fallback to remaining (closed edge handled below)
  if (mvKnown && unKnown && lifetimeForRet > 0) ret = ((un + rz) / lifetimeForRet) * 100;
  // Holding first, then worth, market, cost, gains: Quantity, Value,
  // Live price, Average entry, Unrealized, Realized, Total P&L, Return.
  // (Single ticker per account, so rows[0] is the position.)
  // A closed position states facts, not leftovers: average of nothing is
  // unknown, the notice sits above the grid (never inside it), and final
  // return is realized vs lifetime buy cost.
  var pos = rows.length ? rows[0] : null;
  var closed = !!(pos && pos.qtyHeld === 0);
  var lifetimeCost = 0;
  if (closed || true) {
    atrades.forEach(function (t) {
      if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
      var cn = normalizeTrade(t);
      lifetimeCost += cn.netMain + cn.feeLossMain;
    });
    if (closed) {
      var closedFlag = document.createElement('p');
      closedFlag.className = 'muted closed-flag';
      closedFlag.textContent = 'Closed — nothing held.';
      host.appendChild(closedFlag);
    }
  }
  stats.appendChild(statCard('Quantity', pos ? (fmtQty(pos.qtyHeld) + ' ' + String(pos.symbol || '').toUpperCase()) : '—', pos ? pos.qtyHeld : null));
  // Full grid even with no records yet: unknowns show —, and the live price
  // resolves from the ticker alone so a fresh account already quotes.
  var liveShow = pos ? pos.livePrice : ((isFinite(lvNum) && lvNum > 0) ? lvNum : null);
  stats.appendChild(statCard('Value', mvKnown ? fmtMoney(mv, main) : '—', mvKnown ? mv : null));
  stats.appendChild(statCard('Live price', liveShow !== null ? fmtMoney(liveShow, main) : '—', liveShow));
  stats.appendChild(statCard('Average entry', (pos && !closed) ? fmtMoney(pos.avgEntry, main) : '—', (pos && !closed) ? pos.avgEntry : null));
  stats.appendChild(statCard('Unrealized', unKnown ? fmtMoney(un, main) : '—', unKnown ? un : null));
  stats.appendChild(statCard('Realized', fmtMoney(rz, main), rz));
  if (pos) {
    var tplCard = statCard('Total P&L', fmtMoney(pos.totalPL, main), pos.totalPL);
    var tsc = plClass(pos.totalPL);
    if (tsc) tplCard.querySelector('.card-value').classList.add(tsc);
    stats.appendChild(tplCard);
  } else {
    stats.appendChild(statCard('Total P&L', '—', null));
  }
  if (closed && lifetimeCost > 0) ret = (rz / lifetimeCost) * 100;
  var retCard = statCard('Return', ret !== null ? fmtPct(ret) : '—', ret);
  var rsc = plClass(ret);
  if (rsc) retCard.querySelector('.card-value').classList.add(rsc);
  stats.appendChild(retCard);
  // Fee info lives below the 8-card grid as one line (display-only: the fee
  // is already baked into the calculated Real price, zero P&L drag).
  var feesSum = 0, incomeSum = 0;
  rows.forEach(function (r) { feesSum += Number(r.fees) || 0; incomeSum += Number(r.income) || 0; });
  if (Math.abs(incomeSum) > 1e-9) stats.appendChild(statCard('Income', fmtMoney(incomeSum, main), incomeSum));
  host.appendChild(stats);
  // Per-account spent (this account only): lifetime sell proceeds, cash legs
  // and crypto fees at the frozen tx-date rate — same definition as the home
  // SPENT AMOUNT, scoped to atrades. Orange pill above the red fees pill.
  var spentSum = 0;
  try {
    atrades.forEach(function (t) {
      if (!t) return;
      var sn = normalizeTrade(t);
      if (t.type === 'sell') {
        if (isFinite(sn.totalMain) && sn.totalMain > 0) spentSum += sn.totalMain;
      } else if (t.type === 'expense' || t.type === 'transfer') {
        if (isFinite(sn.netMain) && sn.netMain > 0) spentSum += sn.netMain;
        var cq = (t.type === 'transfer')
          ? ((t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee))
          : ((t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? 0 : Number(t.qty));
        if (isFinite(cq) && cq > 0) {
          var kr = null;
          try { kr = resolveExecPrice(t, main, accKind); } catch (e) { kr = null; }
          if (kr !== null && isFinite(Number(kr.price)) && Number(kr.price) > 0) {
            spentSum += cq * Number(kr.price);
          }
        }
      }
    });
  } catch (e) { spentSum = 0; }
  if (spentSum > 1e-9) {
    var spentLine = document.createElement('p');
    spentLine.className = 'spent-line';
    spentLine.setAttribute('data-label', 'Spent amount');
    spentLine.setAttribute('data-value', String(spentSum));
    spentLine.textContent = 'Spent amount: ' + fmtMoney(spentSum, main);
    host.appendChild(spentLine);
  }
  if (Math.abs(feesSum) > 1e-9) {
    var feesLine = document.createElement('p');
    feesLine.className = 'fees-line';
    feesLine.setAttribute('data-label', 'Total fees paid');
    feesLine.setAttribute('data-value', String(feesSum));
    feesLine.textContent = 'Total fees paid: ' + fmtMoney(feesSum, main);
    host.appendChild(feesLine);
  }
  var tHead = document.createElement('div');
  tHead.className = 'section-head';
  var tTitle = document.createElement('h2');
  tTitle.className = 'section-title';
  tTitle.textContent = 'Trades';
  tHead.appendChild(tTitle);
  if (atrades.length) {
    var tAdd = document.createElement('button');
    tAdd.type = 'button';
    tAdd.className = 'ghost';
    tAdd.textContent = '+ Record';
    tAdd.setAttribute('aria-label', 'Add record to ' + acc.name);
    tAdd.addEventListener('click', function () { openPrefillTrade(acc.id, true); });
    tHead.appendChild(tAdd);
    host.appendChild(tHead);
    var nameById = function (aid) { var a = accountById(st, aid); return a ? a.name : ''; };
    var accKind = (acc && typeof acc.kind === 'string') ? acc.kind : undefined;
    ledgerSortByDate(atrades).reverse().forEach(function (t) {
      host.appendChild(tradeBlock(t, main, nameById, accKind));
    });
  } else {
    host.appendChild(tHead);
    var emptyTrades = document.createElement('div');
    emptyTrades.className = 'empty-trades';
    var muted = document.createElement('p');
    muted.className = 'muted';
    muted.textContent = 'No trades yet — add one to see P&L.';
    emptyTrades.appendChild(muted);
    var eAdd = document.createElement('button');
    eAdd.type = 'button';
    eAdd.className = 'primary';
    eAdd.textContent = '+ Record';
    eAdd.setAttribute('aria-label', 'Add record to ' + acc.name);
    eAdd.addEventListener('click', function () { openPrefillTrade(acc.id, true); });
    emptyTrades.appendChild(eAdd);
    host.appendChild(emptyTrades);
  }
  // FIFO cost basis is only visible here: closed lots with holding periods,
  // so the method toggle shows its work instead of just changing numbers.
  if (method === 'fifo') {
    var allLots = [];
    rows.forEach(function (r) {
      (r.lots || []).forEach(function (l) { allLots.push(l); });
    });
    if (allLots.length) {
      allLots.sort(function (a, b) {
        var ca = String(a.closeDate || ''), cb = String(b.closeDate || '');
        return ca < cb ? 1 : ca > cb ? -1 : 0;
      });
      var lotHead = document.createElement('h2');
      lotHead.className = 'section-title';
      lotHead.textContent = 'Closed lots (FIFO)';
      host.appendChild(lotHead);
      var lotBox = document.createElement('article');
      lotBox.className = 'trade-block';
      allLots.forEach(function (l) {
        var sym = String(l.symbol || (rows.length ? rows[0].symbol : '') || '').toUpperCase();
        lotBox.appendChild(statRow(
          String(l.openDate || '') + ' → ' + String(l.closeDate || ''),
          fmtQty(l.qty) + ' ' + sym + ' · ' + fmtMoney(l.gain, main) + ' (' + l.holdingDays + 'd)',
          l.gain, true
        ));
      });
      host.appendChild(lotBox);
    }
  }
}

function route() {
  var home = document.getElementById('view-home');
  var det = document.getElementById('view-account');
  if (!home || !det) return;
  var id = accountDetailId();
  if (id) {
    home.hidden = true;
    det.hidden = false;
    var st;
    try {
      st = loadState();
    } catch (e) {
      st = defaultState();
    }
    if (!st || !st.settings) st = defaultState();
    renderAccountDetail(st, id);
    var acc = accountById(st, id);
    try { document.title = (acc ? acc.name + ' · ' + String(acc.ticker).toUpperCase() + ' — ' : '') + 'INOCULENS PLUTUS'; } catch (e) { /* ignore */ }
    var back = document.getElementById('acct-back');
    if (back && typeof back.focus === 'function') {
      try {
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.account-card')) back.focus({ preventScroll: true });
      } catch (e) { /* ignore */ }
    }
    try { if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  } else {
    det.hidden = true;
    home.hidden = false;
    try { document.title = 'INOCULENS PLUTUS — Local-First Portfolio Tracker'; } catch (e) { /* ignore */ }
  }
  // Views just toggled: hidden-while-rendered content (e.g. the hero after
  // deleting the open account) measures zero until now — sync sizes now that
  // the right view is visible.
  try { syncHeroAllocHeight(); } catch (e) { /* ignore */ }
  syncTradeButtons();
}

// Trade entry lives inside accounts only: the top-bar +Trade and the mobile
// FAB hide on home (the elements stay in the DOM so programmatic clicks and
// tests keep working). First-run onboarding keeps its own guide CTA.
function syncTradeButtons() {
  var st = null;
  try {
    st = loadState();
  } catch (e) {
    st = null;
  }
  if (!st || !st.settings) {
    try {
      st = defaultState();
    } catch (e2) {
      st = { settings: {}, accounts: [], trades: [] };
    }
  }
  var id = null;
  try {
    id = accountDetailId();
  } catch (e) {
    id = null;
  }
  var inAccount = !!id && !!accountById(st, id);
  var hasAccts = Array.isArray(st.accounts) && st.accounts.length > 0;
  var hasTrades = Array.isArray(st.trades) && st.trades.length > 0;
  // Entry points live with their lists now (+ Account above accounts,
  // + Record above trades), so the top-bar duplicates stay hidden everywhere
  // (elements remain in the DOM for tests and programmatic use).
  var add = document.getElementById('tb-add');
  if (add) add.hidden = true;
  var acctBtn = document.getElementById('tb-account');
  if (acctBtn) acctBtn.hidden = true;
  var fab = document.getElementById('fab-trade');
  if (fab) fab.hidden = !(inAccount && hasAccts && hasTrades);
}

// --- Accounts CRUD (restored: must never be removed — the exposure block
// below and the UI/tests reference every one of these) ---

function accountTrades(st, accountId) {
  // Single-arg form accountTrades(accountId) reads live state (test helper).
  if (typeof st === 'string' && accountId === undefined) {
    return accountTrades(loadState(), st);
  }
  return ((st && st.trades) || []).filter(function (t) {
    return t && (t.accountId === accountId || t.toAccountId === accountId);
  });
}

function fxBadgeText(t) {
  var lock = t ? t.fxLock : null;
  if (!lock) return 'legacy rate';
  var r = Number(lock.rate);
  var bits = String(lock.source || 'rate');
  if (isFinite(r)) {
    var rounded = Math.round(r * 10000) / 10000;
    bits += ' @ ' + rounded;
  }
  if (lock.interpolated) bits += ' (prev close)';
  var head = bits;
  if (t && stableToUsd(t.currency)) {
    head = String(t.currency).toUpperCase() + '→USD 1.0 · ' + bits;
  }
  return head;
}

function createAccount(name, ticker, kind, extra) {
  var st = loadState();
  var tk = String(ticker || '').trim().toUpperCase();
  var nm = String(name || '').trim();
  if (!tk) { showBanner('Ticker is required (e.g. BTC).'); return null; }
  if (!/^[A-Z0-9._-]{1,12}$/.test(tk)) { showBanner('Ticker looks invalid — letters/numbers, up to 12 chars.'); return null; }
  if (!nm) nm = tk; // name defaults to ticker
  var kd = (typeof kind === 'string' && kind) ? kind.trim().toLowerCase() : 'crypto';
  if (kd !== 'crypto' && kd !== 'stock' && kd !== 'custom' && kd !== 'cash') kd = 'crypto';
  var acc = { id: uid(), name: nm, ticker: tk, kind: kd, createdAt: new Date().toISOString() };
  if (extra && typeof extra === 'object') {
    if (typeof extra.address === 'string' && extra.address.trim() !== '') acc.address = extra.address.trim().slice(0, 128);
    if (typeof extra.note === 'string' && extra.note.trim() !== '') acc.note = extra.note.trim().slice(0, 280);
  }
  st.accounts.push(acc);
  if (!saveStateGuarded(st)) return null;
  clearBanner();
  render();
  return acc;
}

function openAccountDialog() {
  buildAccountDialog();
  openDialog('account-dialog');
  return null;
}

function renameAccount(id, name) {
  if (!id) return;
  var st = loadState();
  var acc = accountById(st, id);
  if (!acc) return;
  var nm = String(name === undefined || name === null ? '' : name).trim();
  if (!nm) { showBanner('Account name cannot be empty.'); return; }
  acc.name = nm;
  if (!saveStateGuarded(st)) return;
  clearBanner();
  render();
}

function deleteAccount(id) {
  if (!id) return;
  var st = loadState();
  var acc = accountById(st, id);
  if (!acc) return; // unknown id: no write, no dialog
  var n = accountTrades(st, id).length;
  var msg = 'Delete account "' + acc.name + '" (' + acc.ticker + ')' +
    (n ? ' and its ' + n + ' trade' + (n === 1 ? '' : 's') : '') +
    '? This cannot be undone.';
  confirmAction('Delete account', msg, 'Delete', true).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    if (!accountById(s2, id)) return;
    s2.trades = (s2.trades || []).filter(function (t) { return !t || (t.accountId !== id && t.toAccountId !== id); });
    s2.accounts = (s2.accounts || []).filter(function (a) { return !a || a.id !== id; });
    if (!saveStateGuarded(s2)) return;
    clearBanner();
    render();
  });
}

function deleteTrade(id) {
  if (!id) return;
  var st = loadState();
  var doomed = null;
  (st.trades || []).forEach(function (t) { if (t && t.id === id) doomed = t; });
  if (!doomed) return; // unknown id: no write
  // Swap legs live and die as a pair: deleting one side alone would orphan
  // the other (a costless sale booking phantom gains, or a purposeless buy
  // inflating holdings) and corrupt P&L.
  var pair = [];
  if (doomed.swapId) {
    (st.trades || []).forEach(function (t) {
      if (t && t.swapId === doomed.swapId && t.id !== doomed.id) pair.push(t);
    });
  }
  var desc = (doomed.type === 'sell' ? 'Sell ' : 'Buy ') + doomed.qty + ' ' +
    String(doomed.symbol || '') + ' (' + (doomed.date || 'no date') + ')';
  var msg = pair.length
    ? 'Delete swap (' + desc + ' + its linked leg)? This cannot be undone.'
    : 'Delete trade ' + desc + '? This cannot be undone.';
  confirmAction('Delete trade', msg, 'Delete', true).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    var drop = {};
    drop[id] = true;
    pair.forEach(function (t) { drop[t.id] = true; });
    var kept = (s2.trades || []).filter(function (t) { return !t || !drop[t.id]; });
    if (kept.length === (s2.trades || []).length) return;
    s2.trades = kept;
    if (!saveStateGuarded(s2)) return;
    render(); // cached live prices stay; no refetch needed on delete
  });
}

function buildAccountCreateRow() {
  var row = document.createElement('div');
  row.className = 'account-create-row';
  var fn = document.createElement('div');
  fn.className = 'fld';
  var ln = document.createElement('label');
  ln.setAttribute('for', 'acct-name');
  ln.textContent = 'Account name';
  var inName = document.createElement('input');
  inName.id = 'acct-name';
  inName.setAttribute('autocomplete', 'off');
  inName.setAttribute('spellcheck', 'false');
  inName.setAttribute('placeholder', 'e.g. Cold wallet');
  fn.appendChild(ln);
  fn.appendChild(inName);
  var ft = document.createElement('div');
  ft.className = 'fld';
  var lt = document.createElement('label');
  lt.setAttribute('for', 'acct-ticker');
  lt.textContent = 'Ticker';
  var inTick = document.createElement('input');
  inTick.id = 'acct-ticker';
  inTick.setAttribute('autocomplete', 'off');
  inTick.setAttribute('spellcheck', 'false');
  inTick.setAttribute('placeholder', 'e.g. BTC');
  ft.appendChild(lt);
  ft.appendChild(inTick);
  var create = document.createElement('button');
  create.type = 'button';
  create.id = 'acct-create';
  create.className = 'primary';
  create.textContent = 'Create account';
  row.appendChild(fn);
  row.appendChild(ft);
  row.appendChild(create);
  return row;
}

function buildGuidePanel() {
  var box = document.createElement('section');
  box.className = 'guide-panel';
  box.setAttribute('aria-label', 'Next step');
  var step = document.createElement('p');
  step.className = 'guide-step';
  step.textContent = 'Step 2 of 3';
  box.appendChild(step);
  var title = document.createElement('h2');
  title.className = 'guide-title';
  title.textContent = 'Add your first trade';
  box.appendChild(title);
  var sub = document.createElement('p');
  sub.className = 'guide-sub';
  sub.textContent = 'Tell Plutus what you bought — how much, what you paid, and when. Prices and currency math are automatic.';
  box.appendChild(sub);
  var ctas = document.createElement('div');
  ctas.className = 'guide-ctas';
  var go = document.createElement('button');
  go.type = 'button';
  go.className = 'primary';
  go.textContent = 'Add my first trade';
  go.setAttribute('data-guide-trade', '1');
  ctas.appendChild(go);
  box.appendChild(ctas);
  return box;
}

function wireLanding() {
  var c = document.getElementById('landing-create');
  if (c && !c.getAttribute('data-wired')) {
    c.setAttribute('data-wired', '1');
    c.addEventListener('click', function () { openAccountDialog(); });
  }
  var r = document.getElementById('landing-restore');
  if (r && !r.getAttribute('data-wired')) {
    r.setAttribute('data-wired', '1');
    r.addEventListener('click', function () {
      buildSettings();
      showSettingsTab('backup');
      openDialog('settings-dialog');
    });
  }
}

function buildAccounts() {
  var host = document.getElementById('accounts');
  if (host && !host.getAttribute('data-wired')) {
    host.setAttribute('data-wired', '1');
    host.addEventListener('click', function (e) {
      var t = e && e.target && e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.id === 'acct-create') {
        createAccount(uiVal('acct-name', ''), uiVal('acct-ticker', ''));
        return;
      }
      if (t.hasAttribute('data-guide-trade')) {
        openPrefillTrade(null);
        return;
      }
      if (t.hasAttribute('data-account-trade')) {
        openPrefillTrade(t.getAttribute('data-account-trade'), true);
        return;
      }
      if (t.hasAttribute('data-account-open')) {
        navTo(t.getAttribute('data-account-open'));
        return;
      }
      if (t.hasAttribute('data-account-rename')) {
        var rid = t.getAttribute('data-account-rename');
        var card = t.closest ? t.closest('[data-account]') : null;
        var headEl = t.closest ? t.closest('.account-head') : null;
        var nameEl = card ? card.querySelector('.account-name') : null;
        startInlineRename(rid, headEl, nameEl);
        return;
      }
      if (t.hasAttribute('data-account-delete')) {
        deleteAccount(t.getAttribute('data-account-delete'));
        return;
      }
      var del = e.target && e.target.closest ? e.target.closest('[data-del]') : null;
      if (del) {
        deleteTrade(del.getAttribute('data-del'));
        return;
      }
    });
  }
  var add = document.getElementById('tb-account');
  if (add && !add.getAttribute('data-wired')) {
    add.setAttribute('data-wired', '1');
    add.addEventListener('click', function () { openAccountDialog(); });
  }
  // Folder-card navigation (home → detail). Buttons keep their own
  // behavior; anything else on the card opens the account page.
  // Mousemove spotlight: cursor position feeds the card sheen (CSS vars).
  var navHost = document.getElementById('accounts');
  if (navHost && !navHost.getAttribute('data-nav-wired')) {
    navHost.setAttribute('data-nav-wired', '1');
    navHost.addEventListener('mousemove', function (e) {
      var card = e.target && e.target.closest ? e.target.closest('.account-card') : null;
      if (!card) return;
      var r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
    navHost.addEventListener('click', function (e) {
      if (!e || !e.target || !e.target.closest) return;
      if (suppressCardClick) { suppressCardClick = false; return; } // just finished a drag
      if (selectionMode) {
        var scard = e.target.closest('.account-card');
        if (scard && scard.getAttribute('data-account')) {
          toggleAccountSelect(scard.getAttribute('data-account'));
          return;
        }
      }
      if (e.target.closest('button')) return;
      var nav = e.target.closest('[data-account-nav]');
      if (nav && nav.getAttribute('data-account-nav')) {
        navTo(nav.getAttribute('data-account-nav'));
      }
    });
    navHost.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('button')) return;
      var nav = e.target.closest('[data-account-nav]');
      if (nav && nav.getAttribute('data-account-nav')) {
        e.preventDefault();
        navTo(nav.getAttribute('data-account-nav'));
      }
    });
  }
  wireAccountDnD();
  // Filter panel dismissal: click outside or Escape closes without render.
  if (!accountFilterOutsideWired && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    accountFilterOutsideWired = true;
    document.addEventListener('pointerdown', function (e) {
      var t = e && e.target;
      var inF = t && t.closest && (t.closest('[data-filter-panel]') || t.closest('[data-filter-btn]'));
      var inA = t && t.closest && (t.closest('[data-action-panel]') || t.closest('[data-action-btn]'));
      if (!inF) closeAccountFilter(false);
      if (!inA) closeAccountAction();
    });
    document.addEventListener('keydown', function (e) {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) { closeAccountFilter(true); closeAccountAction(); }
    });
  }
}

// --- Account drag-and-drop reorder (dice-grip handle, desktop) ---
// Order is the accounts array itself: saveState persists it to localStorage
// and export/import preserve it, so a reorder survives backup + restore with
// no extra fields. Drags start from the grip only; card clicks still open.

var ACCOUNT_PAGE_SIZE = 6;
var accountPage = 0;
var acctDrag = null; // {id,startX,startY,started,ghost,overId,after,flipTimer,flipCoolUntil,armedBtn}
var suppressCardClick = false;

function clearDropMarks() {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelectorAll) return;
  Array.prototype.forEach.call(host.querySelectorAll('.account-card.drag-src,.account-card.drop-before,.account-card.drop-after'), function (el) {
    el.classList.remove('drag-src', 'drop-before', 'drop-after');
  });
}

function clearCardMarks() {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelectorAll) return;
  Array.prototype.forEach.call(host.querySelectorAll('.account-card.drop-before,.account-card.drop-after'), function (el) {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function acctDragCardEl(id) {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelector) return null;
  try {
    return host.querySelector('[data-account="' + String(id).replace(/"/g, '') + '"]');
  } catch (e) {
    return null;
  }
}

function visibleAccountIds(st) {
  var f = selectedTickers(st);
  return (st.accounts || []).filter(function (a) {
    return f === null || f.indexOf(String(a.ticker).toUpperCase()) !== -1;
  }).map(function (a) { return a.id; });
}

function pagerTargetPage(btn) {
  if (!btn || !btn.hasAttribute) return accountPage;
  if (btn.hasAttribute('data-page-prev')) return accountPage - 1;
  if (btn.hasAttribute('data-page-next')) return accountPage + 1;
  if (btn.hasAttribute('data-page-goto')) {
    var p = Number(btn.getAttribute('data-page-goto'));
    return isFinite(p) ? p : accountPage;
  }
  return accountPage;
}

function acctDragCleanup() {
  if (acctDrag && acctDrag.flipTimer) {
    try { clearTimeout(acctDrag.flipTimer); } catch (e) {}
  }
  if (acctDrag && acctDrag.ghost && acctDrag.ghost.parentNode) {
    try { acctDrag.ghost.parentNode.removeChild(acctDrag.ghost); } catch (e) {}
  }
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = '';
  } catch (e) {}
  try {
    var hintHost = (typeof document !== 'undefined') ? document.getElementById('accounts') : null;
    if (hintHost && hintHost.querySelectorAll) {
      Array.prototype.forEach.call(hintHost.querySelectorAll('[data-drag-hint]'), function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
    }
  } catch (e) {}
  clearDropMarks();
  acctDrag = null;
}

function markAcctDragSrc() {
  if (!acctDrag) return;
  var src = acctDragCardEl(acctDrag.id);
  if (src) src.classList.add('drag-src');
}

function acctStartDrag(src) {
  var r = null;
  try { r = src.getBoundingClientRect(); } catch (e) { r = null; }
  var ghost = null;
  try {
    ghost = src.cloneNode(true);
    ghost.classList.remove('drop-before', 'drop-after', 'drag-src');
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('id');
    ghost.style.width = (r && r.width ? r.width : 320) + 'px';
    ghost.style.left = (r ? r.left : 0) + 'px';
    ghost.style.top = (r ? r.top : 0) + 'px';
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(ghost);
    else ghost = null;
  } catch (e) { ghost = null; }
  acctDrag.started = true;
  acctDrag.ghost = ghost;
  suppressCardClick = true;
  acctShowDragHint();
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = 'none';
  } catch (e) {}
  markAcctDragSrc();
}

function acctShowDragHint() {
  try {
    var host = document.getElementById('accounts');
    if (!host) return;
    var st = loadState();
    if (visibleAccountIds(st).length <= ACCOUNT_PAGE_SIZE) return;
    if (host.querySelector && host.querySelector('[data-drag-hint]')) return;
    var hint = document.createElement('div');
    hint.className = 'pager-hint';
    hint.setAttribute('data-drag-hint', '1');
    hint.textContent = 'Drop on ‹ Prev, a page number, or Next › to move the card there';
    host.appendChild(hint);
  } catch (e) {}
}

function acctDisarmFlip() {
  if (acctDrag && acctDrag.flipTimer) {
    try { clearTimeout(acctDrag.flipTimer); } catch (e) {}
    acctDrag.flipTimer = null;
  }
  var host = document.getElementById('accounts');
  if (host && host.querySelectorAll) {
    Array.prototype.forEach.call(host.querySelectorAll('.page-btn.hot'), function (b) { b.classList.remove('hot'); });
  }
  if (acctDrag) acctDrag.armedBtn = null;
}

function acctFlipTo(page) {
  var st = loadState();
  var vis = visibleAccountIds(st);
  var pages = Math.max(1, Math.ceil(vis.length / ACCOUNT_PAGE_SIZE));
  if (page < 0 || page > pages - 1) return false;
  accountPage = page;
  render();
  if (acctDrag) {
    acctDrag.flipCoolUntil = Date.now() + 900;
    acctDrag.overId = null;
    acctDrag.after = false;
    markAcctDragSrc();
  }
  return true;
}

function wireAccountDnD() {
  var host = document.getElementById('accounts');
  if (!host || host.getAttribute('data-dnd-wired')) return;
  host.setAttribute('data-dnd-wired', '1');
  host.addEventListener('pointerdown', function (e) {
    var grip = e.target && e.target.closest ? e.target.closest('.drag-handle') : null;
    if (!grip) return;
    var card = grip.closest('.account-card');
    if (!card || !card.getAttribute('data-account')) return;
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    if (typeof e.clientX !== 'number') return;
    acctDrag = { id: card.getAttribute('data-account'), startX: e.clientX, startY: e.clientY, started: false, ghost: null, overId: null, after: false, flipTimer: null, flipCoolUntil: 0, armedBtn: null };
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
  });
  host.addEventListener('pointermove', function (e) {
    if (!acctDrag || !e || typeof e.clientX !== 'number') return;
    var dx = e.clientX - acctDrag.startX;
    var dy = e.clientY - acctDrag.startY;
    if (!acctDrag.started) {
      if (dx * dx + dy * dy < 49) return;
      var src = acctDragCardEl(acctDrag.id);
      if (!src) { acctDragCleanup(); return; }
      acctStartDrag(src);
    }
    if (acctDrag.ghost) {
      acctDrag.ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    var under = null;
    try {
      under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
    } catch (err) { under = null; }
    // Cross-page targets: pager buttons (prev, numbers, next) glow blue;
    // lingering on one flips the page while you keep holding.
    var pgBtn = under && under.closest ? under.closest('[data-page-prev],[data-page-next],[data-page-goto]') : null;
    var pgTarget = pgBtn ? pagerTargetPage(pgBtn) : accountPage;
    if (pgBtn && !pgBtn.disabled && pgTarget !== accountPage && Date.now() >= (acctDrag.flipCoolUntil || 0)) {
      if (acctDrag.armedBtn !== pgBtn) {
        acctDisarmFlip();
        acctDrag.armedBtn = pgBtn;
        pgBtn.classList.add('hot');
        acctDrag.flipTimer = setTimeout(function () {
          if (!acctDrag) return;
          acctDisarmFlip();
          acctFlipTo(pgTarget);
        }, 650);
      }
    } else {
      acctDisarmFlip();
    }
    clearCardMarks();
    var card = under && under.closest ? under.closest('.account-card') : null;
    acctDrag.overId = null;
    if (card && card.getAttribute('data-account') !== acctDrag.id) {
      var r = null;
      try { r = card.getBoundingClientRect(); } catch (err2) { r = null; }
      acctDrag.after = !!(r && (e.clientY - r.top) > r.height / 2);
      acctDrag.overId = card.getAttribute('data-account');
      card.classList.add(acctDrag.after ? 'drop-after' : 'drop-before');
    }
  });
  function acctFinishDrop(e) {
    if (!acctDrag) return;
    var wasStarted = acctDrag.started;
    var id = acctDrag.id;
    var overId = null;
    var after = false;
    var onPager = null;
    if (wasStarted && e && typeof e.clientX === 'number') {
      try {
        var under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
        var pb = under && under.closest ? under.closest('[data-page-prev],[data-page-next],[data-page-goto]') : null;
        if (pb && !pb.disabled) onPager = pb;
        else {
          var card = under && under.closest ? under.closest('.account-card') : null;
          if (card && card.getAttribute('data-account') !== id) {
            overId = card.getAttribute('data-account');
            var r = null;
            try { r = card.getBoundingClientRect(); } catch (err) { r = null; }
            after = !!(r && (e.clientY - r.top) > r.height / 2);
          }
        }
      } catch (err2) {}
    }
    acctDragCleanup();
    if (!wasStarted) return; // plain click: the nav handler opens the card
    var st = loadState();
    var vis = visibleAccountIds(st);
    if (vis.indexOf(id) === -1) { render(); return; }
    var fullIds = (st.accounts || []).map(function (a) { return a && a.id; });
    var fullFrom = fullIds.indexOf(id);
    var insertFull = -1;
    if (onPager) {
      var targetPage = pagerTargetPage(onPager);
      var pages = Math.max(1, Math.ceil(vis.length / ACCOUNT_PAGE_SIZE));
      if (targetPage < 0) targetPage = 0;
      if (targetPage > pages - 1) targetPage = pages - 1;
      if (targetPage === accountPage) { render(); return; } // dropped on the current page number
      // Prev + page numbers land at the page start, Next at the page end.
      var atEnd = onPager.hasAttribute && onPager.hasAttribute('data-page-next');
      accountPage = targetPage;
      var visIx = atEnd ? Math.min(vis.length, (targetPage + 1) * ACCOUNT_PAGE_SIZE) : targetPage * ACCOUNT_PAGE_SIZE;
      insertFull = visIx >= vis.length ? fullIds.length : fullIds.indexOf(vis[visIx]);
      if (insertFull === -1) insertFull = atEnd ? fullIds.length : 0;
    } else if (overId) {
      var visTo = vis.indexOf(overId);
      if (visTo === -1) { render(); return; }
      var wantVis = after ? visTo + 1 : visTo;
      insertFull = wantVis >= vis.length ? fullIds.length : fullIds.indexOf(vis[wantVis]);
      if (insertFull === -1) insertFull = fullIds.length;
    } else {
      render(); // released over nothing meaningful: snap back
      return;
    }
    var moved = st.accounts.splice(fullFrom, 1)[0];
    if (fullFrom < insertFull) insertFull--;
    if (insertFull !== fullFrom) {
      st.accounts.splice(insertFull, 0, moved);
      if (!saveStateGuarded(st)) { render(); return; }
    }
    render();
  }
  host.addEventListener('pointerup', acctFinishDrop);
  host.addEventListener('pointercancel', function () { acctDragCleanup(); });
}

// --- New-account dialog ---
// Name + ticker only (story step one). Wired once; empty-state inline row
// keeps its own acct-* ids so the two never collide.

function naError(msg) {
  var p = document.getElementById('na-error');
  if (!p) return;
  if (!msg) {
    p.textContent = '';
    p.hidden = true;
    return;
  }
  p.textContent = String(msg);
  p.hidden = false;
}

function buildAccountDialog() {
  var host = document.getElementById('account-dialog-body');
  if (!host || document.getElementById('na-create')) return;
  wireDialog('account-dialog');
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<label for="na-name">Account name</label>' +
    '<input id="na-name" autocomplete="off" spellcheck="false" placeholder="e.g. Cold wallet">' +
    '<label for="na-ticker">Ticker</label>' +
    '<input id="na-ticker" autocomplete="off" spellcheck="false" placeholder="e.g. BTC">' +
    '<label for="na-kind">Asset type</label>' +
    '<select id="na-kind"><option value="crypto">Crypto (live via CoinGecko)</option><option value="stock">Stock / ETF (live via Stooq)</option><option value="custom">Custom (manual price only)</option><option value="cash">Cash</option></select>' +
    '<label for="na-address">Label (optional)</label>' +
    '<input id="na-address" autocomplete="off" spellcheck="false" placeholder="e.g. cold storage">' +
    '<p id="na-error" class="banner-error" role="alert" hidden></p>' +
    '<button id="na-create" class="primary" type="button">Create account</button>';
  host.appendChild(wrap);
  document.getElementById('na-create').addEventListener('click', function () {
    naError(null);
    var tk = uiVal('na-ticker', '').trim().toUpperCase();
    if (!tk) { naError('Ticker is required (e.g. BTC).'); return; }
    if (!/^[A-Z0-9._-]{1,12}$/.test(tk)) { naError('Ticker looks invalid — letters/numbers, up to 12 chars.'); return; }
    var hadTrades = (loadState().trades || []).length > 0;
    var acc = createAccount(uiVal('na-name', ''), tk, uiVal('na-kind', 'crypto'), { address: uiVal('na-address', '') });
    if (!acc) { naError('Could not create the account — storage unavailable.'); return; }
    uiSetVal('na-name', '');
    uiSetVal('na-ticker', '');
    uiSetVal('na-address', '');
    closeDialog('account-dialog');
    // Story guidance: first account + no trades yet → continue straight
    // to Step 2 instead of leaving the user on a quiet screen.
    if (!hadTrades) openPrefillTrade(acc.id, true);
  });
}

// --- Trade form ---
var TRADE_CCY_OPTIONS = ['EUR', 'USD', 'GBP', 'CHF', 'RON', 'USDC', 'USDT', 'DAI'];

function ccyOptions(selected) {
  var base = TRADE_CCY_OPTIONS.map(function (c) {
    return '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + '</option>';
  }).join('');
  return base + '<option value="CUSTOM"' + (selected === 'CUSTOM' ? ' selected' : '') + '>Other…</option>';
}

function buildTradeForm() {
  var host = document.getElementById('trade-dialog-body');
  if (!host || document.getElementById('trade-form')) return;
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<form id="trade-form">' +
    '<label for="t-side">Type</label>' +
    '<select id="t-side"><option value="buy">Buy</option><option value="sell">Sell</option><option value="transfer">Transfer (self move + gas)</option><option value="income">Income (reward / airdrop)</option><option value="expense">Expense / fee</option><option value="swap">Swap (coin → coin)</option></select>' +
    '<div id="t-account-row"><label for="t-account">Account</label>' +
    '<select id="t-account"></select></div>' +
    '<div id="t-toaccount-row" hidden><label for="t-toaccount">To account</label>' +
    '<select id="t-toaccount"></select><p class="fld-hint" id="t-toaccount-hint">Transfer moves cost basis — only the network + fiat fees count as losses.</p></div>' +
    '<div class="fld-locked" hidden><span class="fld-label">Symbol (locked to account)</span> <span id="t-symbol-locked" role="status"></span></div>' +
    '<div id="t-qty-row"><label for="t-qty" id="t-qty-label">Quantity</label>' +
    '<input id="t-qty" inputmode="decimal" placeholder="e.g. 1">' +
    '<p class="fld-hint" id="t-qty-hint">Amount you received (net of any fee taken in asset).</p></div>' +
    '<div id="t-toqty-row" hidden><label for="t-toqty" id="t-toqty-label">Received quantity</label>' +
    '<input id="t-toqty" inputmode="decimal" placeholder="e.g. 15.2">' +
    '<p class="fld-hint" id="t-toqty-hint"></p></div>' +
    '<div id="t-total-row"><label for="t-total" id="t-total-label">Total (native currency)</label>' +
    '<input id="t-total" inputmode="decimal" placeholder="e.g. 50000">' +
    '<p class="fld-hint" id="t-total-hint">Full amount paid, including the fee below.</p></div>' +
    '<div id="t-currency-row"><label for="t-currency">Currency</label>' +
    '<select id="t-currency">' + ccyOptions('EUR') + '</select></div>' +
    '<label for="t-custom-ccy" id="t-custom-ccy-label" hidden>Custom currency code</label>' +
    '<input id="t-custom-ccy" autocomplete="off" spellcheck="false" placeholder="Code, e.g. JPY" hidden>' +
    '<label for="t-date">Date</label>' +
    '<input id="t-date" type="date">' +
    '<details class="adv"><summary>Details</summary>' +
    '<div id="t-networkfee-row" hidden><label for="t-networkfee">Transfer fees (in same asset)</label>' +
    '<input id="t-networkfee" inputmode="decimal" placeholder="e.g. 0.0005" readonly>' +
    '<p class="fld-hint" id="t-networkfee-hint">Fee calculated automatically from the send and received inputs above.</p></div>' +
    '<div id="t-feefiat-row"><label for="t-fee">Fee (fiat)</label>' +
    '<input id="t-fee" inputmode="decimal" placeholder="e.g. 0">' +
    '<p class="fld-hint">Denominated in the Currency above, like everything else on this trade. The total already includes it — the Real price is simply total ÷ qty (e.g. 50 EUR ÷ 0.00058193 BTC). Info only, zero P&L drag.</p></div>' +
    '<label for="t-note">Note</label>' +
    '<input id="t-note" autocomplete="off" placeholder="e.g. monthly savings">' +
    '<label for="t-txid">Transaction ID</label>' +
    '<input id="t-txid" autocomplete="off" spellcheck="false" placeholder="e.g. paste the tx hash">' +
    '<p class="fld-hint">Optional — saved with the record and linked to mempool.space.</p>' +
    '<label for="t-manual-rate">Manual FX rate (fallback when ECB is unavailable)</label>' +
    '<input id="t-manual-rate" inputmode="decimal" placeholder="e.g. 0.92">' +
    '<label for="t-manual-price">Manual exec price (this trade only, in trade fiat)</label>' +
    '<input id="t-manual-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '</details>' +
    '<div class="fld-error-row"><p id="t-error" class="banner-error" role="alert" hidden></p>' +
    '<button type="button" id="t-error-close" aria-label="Dismiss this message" hidden>✕</button></div>' +
    '<button class="primary" type="submit" id="t-submit">Add record</button>' +
    '</form>';
  host.appendChild(wrap);
  var form = document.getElementById('trade-form');
  form.addEventListener('submit', onTradeSubmit);
  var acctSel = document.getElementById('t-account');
  if (acctSel) {
    acctSel.addEventListener('change', function () { syncLockedSymbol(); syncTradeTypeUI(); });
  }
  var sideSel = document.getElementById('t-side');
  if (sideSel) sideSel.addEventListener('change', syncTradeTypeUI);
  var qtyEl = document.getElementById('t-qty');
  if (qtyEl) qtyEl.addEventListener('input', function () { try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var toQtyEl = document.getElementById('t-toqty');
  if (toQtyEl) toQtyEl.addEventListener('input', function () { try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var toSel = document.getElementById('t-toaccount');
  if (toSel) toSel.addEventListener('change', function () { /* hint only */ });
  var ccy = document.getElementById('t-currency');
  var custom = document.getElementById('t-custom-ccy');
  ccy.addEventListener('change', function () {
    var needCustom = (ccy.value === 'CUSTOM');
    custom.hidden = !needCustom;
    var clabel = document.getElementById('t-custom-ccy-label');
    if (clabel) clabel.hidden = !needCustom;
  });
  syncTradeTypeUI();
}

function syncTradeTypeUI() {
  var sideEl = document.getElementById('t-side');
  var type = sideEl ? sideEl.value : 'buy';
  function setHidden(id, hide) { var el = document.getElementById(id); if (el) el.hidden = !!hide; }
  function setLabel(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }
  var isTransfer = type === 'transfer';
  var isSwap = type === 'swap';
  var isIncome = type === 'income';
  var isExpense = type === 'expense';
  var isBuySell = type === 'buy' || type === 'sell';
  setHidden('t-toaccount-row', !(isTransfer || isSwap));
  setHidden('t-toqty-row', !(isSwap || isTransfer));
  setHidden('t-networkfee-row', !(isTransfer));
  // Transfers carry no fiat of their own: the network fee IS the fee, valued
  // in fiat at the frozen historical rate. Fiat fee + total + currency stay
  // for the other types only.
  setHidden('t-feefiat-row', isTransfer);
  setHidden('t-total-row', isTransfer);
  setHidden('t-currency-row', isTransfer);
  if (isTransfer) {
    var custT = document.getElementById('t-custom-ccy');
    if (custT) custT.hidden = true;
    var clabT = document.getElementById('t-custom-ccy-label');
    if (clabT) clabT.hidden = true;
  }
  if (isTransfer) {
    setLabel('t-qty-label', 'You send');
    setLabel('t-toqty-label', 'You receive');
    setLabel('t-total-label', 'Fiat fee value (optional, leave 0)');
    setLabel('t-qty-hint', 'Amount leaving the source (before any fee).');
    setLabel('t-total-hint', 'Optional cash fee on top — leave empty when the fee is crypto-only.');
  } else if (isSwap) {
    setLabel('t-qty-label', 'From quantity (you send)');
    setLabel('t-toqty-label', 'Received quantity');
    setLabel('t-total-label', 'Fiat value of swap (for tax, e.g. 50000)');
    setLabel('t-qty-hint', 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else if (isIncome) {
    setLabel('t-qty-label', 'Quantity received');
    setLabel('t-total-label', 'Market value at receipt (optional, 0 = free)');
    setLabel('t-qty-hint', 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else if (isExpense) {
    setLabel('t-qty-label', 'Quantity lost (optional if cash-only)');
    setLabel('t-total-label', 'Fiat lost (optional if crypto-only)');
    setLabel('t-qty-hint', 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else {
    setLabel('t-qty-label', 'Quantity');
    setLabel('t-total-label', 'Total (native currency)');
    setLabel('t-qty-hint', 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  }
  if (!isTransfer) {
    // Leaving a transfer must restore the custom-currency input when the
    // (now visible again) Currency select sits on Other….
    try {
      var ccySel = document.getElementById('t-currency');
      var needCustom = !!(ccySel && ccySel.value === 'CUSTOM');
      var custR = document.getElementById('t-custom-ccy');
      if (custR) custR.hidden = !needCustom;
      var clabR = document.getElementById('t-custom-ccy-label');
      if (clabR) clabR.hidden = !needCustom;
    } catch (e) { /* ignore */ }
  }
  // Rebuild to-account options: transfer = same ticker only, swap = any other account.
  try {
    var st = loadState();
    var fromId = uiVal('t-account', '');
    var fromAcc = accountById(st, fromId);
    var toSel = document.getElementById('t-toaccount');
    var hint = document.getElementById('t-toaccount-hint');
    if (toSel && (isTransfer || isSwap)) {
      var cur = toSel.value;
      toSel.innerHTML = '';
      var curKept = false;
      var eligible = 0;
      if (isTransfer) {
        // No destination: plain on-chain move inside this account (new address,
        // same owner) — only the network fee is recorded as lost.
        var sameOpt = document.createElement('option');
        sameOpt.value = '';
        sameOpt.textContent = 'Same account — on-chain move';
        toSel.appendChild(sameOpt);
      }
      (st.accounts || []).forEach(function (a) {
        if (a.id === fromId) return;
        if (isTransfer && fromAcc && String(a.ticker).toUpperCase() !== String(fromAcc.ticker).toUpperCase()) return; // same asset only
        var o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
        toSel.appendChild(o);
        eligible++;
        if (a.id === cur) curKept = true;
      });
      // Keep the previous pick only if still eligible; otherwise park on the
      // first entry (the on-chain move for transfers).
      if (cur && curKept) toSel.value = cur;
      else if (toSel.options.length) toSel.selectedIndex = 0;
      if (hint) {
        if (isTransfer && eligible === 0) {
          var need = fromAcc ? String(fromAcc.ticker).toUpperCase() : 'this asset';
          hint.textContent = 'No other ' + need + ' account — recording as an on-chain move in this account.';
        } else {
          hint.textContent = 'Transfer moves cost basis — only the network + fiat fees count as losses.';
        }
      }
    }
  } catch (e) { /* ignore */ }
  void isBuySell; void isIncome; void isExpense;
  try { syncTransferFeePreview(); } catch (e) { /* ignore */ }
}

// Transfer send/receive helper: fee = sent − received. The fee field is
// computed-only (read-only in the form): the two amounts are the source of
// truth, so a saved fee can never contradict them. Received is required.
// Derived amounts are rounded to 8 decimals (the app's quantity precision):
// raw binary subtraction leaves dust like 0.000017260000000000062.
function roundQty8(v) {
  var r = Math.round(Number(v) * 1e8) / 1e8;
  return (Math.abs(r) < 1e-12) ? 0 : r;
}
function transferFeeFrom(sentRaw, recvRaw) {
  var sent = Number(sentRaw);
  var recv = Number(recvRaw);
  if (String(recvRaw).trim() === '') return null;
  if (!isFinite(sent) || sent <= 0) return null;
  if (!isFinite(recv) || recv <= 0 || recv > sent) return null;
  var fee = roundQty8(sent - recv);
  if (!(fee >= 0 && fee < sent)) return null;
  return { sent: sent, recv: recv, fee: fee };
}

function syncTransferFeePreview() {
  var sideEl = document.getElementById('t-side');
  if (!sideEl || sideEl.value !== 'transfer') return;
  var hint = document.getElementById('t-toqty-hint');
  var feeInput = document.getElementById('t-networkfee');
  var r = transferFeeFrom(uiVal('t-qty', ''), uiVal('t-toqty', ''));
  var sym = '';
  try {
    var acc = accountById(loadState(), uiVal('t-account', ''));
    if (acc) sym = ' ' + String(acc.ticker).toUpperCase();
  } catch (e) { sym = ''; }
  if (!r) {
    var recvTxt = String(uiVal('t-toqty', '')).trim();
    if (hint) {
      if (recvTxt === '') hint.textContent = 'Enter what arrived — the fee below fills in itself.';
      else hint.textContent = 'Received must be > 0 and at most what you sent.';
    }
    if (feeInput) feeInput.value = '';
    return;
  }
  if (feeInput) feeInput.value = String(r.fee);
  if (hint) {
    hint.textContent = r.fee === 0
      ? 'No fee — received equals sent.'
      : 'Fee ' + String(r.fee) + sym + ' will be recorded as the loss.';
  }
}

// --- Account-bound trade dialog (Task 3) ---
// First field is the Account select (options rebuilt on every open);
// the symbol is shown locked read-only to that account's ticker.
// openPrefillTrade(accountId|null) preselects the originating card's
// account (or the default for null/unknown) and opens the dialog.

function syncLockedSymbol() {
  var sel = document.getElementById('t-account');
  var locked = document.getElementById('t-symbol-locked');
  if (!sel || !locked) return;
  var acc = accountById(loadState(), sel.value);
  locked.textContent = acc ? String(acc.ticker).toUpperCase() : '';
}

var editingTradeId = null;

// Fresh-trade reset: a new dialog must never inherit type, amounts, notes or
// destination picks from the previous entry — otherwise e.g. a Transfer's
// To-account row leaks into the next Buy.
function resetTradeForm() {
  editingTradeId = null;
  uiSetVal('t-side', 'buy');
  uiSetVal('t-qty', '');
  uiSetVal('t-toqty', '');
  uiSetVal('t-total', '');
  var ccy = document.getElementById('t-currency');
  if (ccy) ccy.value = 'EUR';
  uiSetVal('t-custom-ccy', '');
  var cust = document.getElementById('t-custom-ccy');
  if (cust) cust.hidden = true;
  var clab = document.getElementById('t-custom-ccy-label');
  if (clab) clab.hidden = true;
  uiSetVal('t-fee', '');
  uiSetVal('t-note', '');
  uiSetVal('t-txid', '');
  uiSetVal('t-networkfee', '');
  uiSetVal('t-manual-rate', '');
  uiSetVal('t-manual-price', '');
  var toSel = document.getElementById('t-toaccount');
  if (toSel) toSel.innerHTML = '';
  var submitBtn0 = document.getElementById('t-submit');
  if (submitBtn0) { submitBtn0.textContent = 'Add record'; submitBtn0.disabled = false; }
  var titleEl0 = document.getElementById('trade-dialog-title');
  if (titleEl0) titleEl0.textContent = 'Add record';
  var dd = document.getElementById('t-date');
  if (dd) dd.value = todayStr();
  tradeFormError(null);
}

function openPrefillTrade(accountId, lockIt, presetType) {
  var st = loadState();
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  if (!accounts.length) {
    showBanner('Create your first account to enable Add record.');
    var host = document.getElementById('accounts');
    if (host && host.scrollIntoView) {
      try { host.scrollIntoView(); } catch (e) { /* ignore */ }
    }
    return null;
  }
  editingTradeId = null;
  var target = ((typeof accountId === 'string' && accountId.length > 0) && accountById(st, accountId)) ||
    accounts[0];
  buildTradeForm(); // ensure the form exists (init normally builds it)
  var sel = document.getElementById('t-account');
  if (sel) {
    sel.innerHTML = '';
    accounts.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = target.id;
  }
  var sideSel = document.getElementById('t-side');
  if (sideSel && presetType && TRADE_TYPES.concat(['swap']).indexOf(presetType) !== -1) sideSel.value = presetType;
  // Locked context (e.g. opened from an account page): the account is fixed,
  // so the select is hidden. From home the select stays visible.
  var row = document.getElementById('t-account-row');
  if (row) row.style.display = (lockIt && target) ? 'none' : '';
  syncLockedSymbol();
  resetTradeForm();
  // resetTradeForm defaults the type to Buy; re-apply an explicit preset after it.
  if (sideSel && presetType && TRADE_TYPES.concat(['swap']).indexOf(presetType) !== -1) sideSel.value = presetType;
  syncTradeTypeUI();
  openDialog('trade-dialog');
  return target;
}

function openEditTrade(tradeId) {
  var st = loadState();
  var tr = null;
  (st.trades || []).forEach(function (t) { if (t && t.id === tradeId) tr = t; });
  if (!tr) return;
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  if (!accounts.length) return;
  buildTradeForm();
  editingTradeId = tradeId;
  var sel = document.getElementById('t-account');
  if (sel) {
    sel.innerHTML = '';
    accounts.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = tr.accountId || accounts[0].id;
  }
  var row = document.getElementById('t-account-row');
  if (row) row.style.display = '';
  var sideSel = document.getElementById('t-side');
  if (sideSel) {
    var tt = tr.type === 'buy' || tr.type === 'sell' || tr.type === 'transfer' || tr.type === 'income' || tr.type === 'expense' ? tr.type : 'buy';
    sideSel.value = tt;
  }
  syncLockedSymbol();
  syncTradeTypeUI();
  uiSetVal('t-qty', tr.qty !== undefined && tr.qty !== null ? String(tr.qty) : '');
  uiSetVal('t-toqty', '');
  uiSetVal('t-total', tr.total !== undefined && tr.total !== null ? String(tr.total) : '');
  try {
    var cSel = document.getElementById('t-currency');
    if (cSel && tr.currency) {
      var cu = String(tr.currency).toUpperCase();
      var has = Array.prototype.some.call(cSel.options, function (o) { return o.value === cu; });
      if (has) cSel.value = cu;
      else { cSel.value = 'CUSTOM'; cSel.dispatchEvent(new Event('change', { bubbles: true })); uiSetVal('t-custom-ccy', cu); }
    }
  } catch (e) { /* ignore */ }
  uiSetVal('t-date', tr.date || todayStr());
  uiSetVal('t-fee', tr.fee !== undefined && tr.fee !== null ? String(tr.fee) : '');
  uiSetVal('t-note', tr.note || '');
  uiSetVal('t-txid', tr.txid !== undefined && tr.txid !== null ? String(tr.txid) : '');
  uiSetVal('t-networkfee', tr.networkFee !== undefined && tr.networkFee !== null ? String(tr.networkFee) : '');
  if (tr.type === 'transfer') {
    var trQty = Number(tr.qty);
    var trNf = (tr.networkFee === undefined || tr.networkFee === null || String(tr.networkFee).trim() === '') ? 0 : Number(tr.networkFee);
    if (isFinite(trQty) && trQty > 0 && isFinite(trNf) && trNf >= 0 && trNf < trQty) {
      var recv = roundQty8(trQty - trNf);
      uiSetVal('t-toqty', String(recv));
    }
  }
  // Manual fields reflect their persistent state, like every other input:
  // the FX rate lives on in the trade's manual fxLock, the price in the
  // trade's manual execLock (else the global override for the symbol).
  // Blank only when nothing is stored anywhere.
  var manualFxRate = '';
  try {
    if (tr.fxLock && tr.fxLock.source === 'manual' && isFinite(Number(tr.fxLock.rate)) && Number(tr.fxLock.rate) > 0) {
      manualFxRate = String(tr.fxLock.rate);
    }
  } catch (e) { manualFxRate = ''; }
  uiSetVal('t-manual-rate', manualFxRate);
  var manualPx = '';
  try {
    var frMan = frozenExecOf(tr);
    if (frMan && String(frMan.source).toLowerCase() === 'manual') {
      manualPx = String(frMan.price);
    } else {
      var ovMan = priceOverrideEntry(tr.symbol);
      if (ovMan !== null) manualPx = String(ovMan.price);
    }
  } catch (e) { manualPx = ''; }
  uiSetVal('t-manual-price', manualPx);
  try {
    var toSel = document.getElementById('t-toaccount');
    if (toSel && tr.toAccountId) {
      // ensure options exist for transfer/swap
      syncTradeTypeUI();
      toSel.value = tr.toAccountId;
    }
  } catch (e) { /* ignore */ }
  try { syncTransferFeePreview(); } catch (e) { /* ignore */ }
  var submitBtn2 = document.getElementById('t-submit');
  if (submitBtn2) { submitBtn2.textContent = 'Save changes'; submitBtn2.disabled = false; }
  var titleEl2 = document.getElementById('trade-dialog-title');
  if (titleEl2) titleEl2.textContent = 'Edit record';
  tradeFormError(null);
  openDialog('trade-dialog');
}

function tradeFormError(msg) {
  var p = document.getElementById('t-error');
  if (!p) return;
  var x = document.getElementById('t-error-close');
  if (!msg) {
    p.textContent = '';
    p.hidden = true;
    if (x) x.hidden = true;
    return;
  }
  p.textContent = String(msg);
  p.hidden = false;
  if (x) {
    x.hidden = false;
    if (!x.getAttribute('data-wired')) {
      x.setAttribute('data-wired', '1');
      x.addEventListener('click', function () { tradeFormError(null); });
    }
  }
}

function onTradeSubmit(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  tradeFormError(null);
  var st0 = loadState();
  var main = st0.settings.mainCurrency;
  var rawSide = uiVal('t-side', 'buy');
  var side = (rawSide === 'sell' || rawSide === 'transfer' || rawSide === 'income' || rawSide === 'expense' || rawSide === 'swap') ? rawSide : 'buy';
  var list = Array.isArray(st0.accounts) ? st0.accounts : [];
  var acc = accountById(st0, uiVal('t-account', '')) || list[0];
  if (!acc) { tradeFormError('Create your first account to enable Add record.'); return; }
  var symbol = String(acc.ticker).toUpperCase();
  var accountId = acc.id;
  var submitBtn = document.getElementById('t-submit');
  function lockSubmit(locked, label) {
    if (!submitBtn) return;
    submitBtn.disabled = !!locked;
    if (label) submitBtn.textContent = label;
  }
  var date = uiVal('t-date', '') || todayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { tradeFormError('Date must be YYYY-MM-DD.'); return; }
  if (!isValidDateStr(date)) { tradeFormError('Date must be YYYY-MM-DD.'); return; }
  if (isFutureDateStr(date)) { tradeFormError('date cannot be in the future'); return; }
  var note = uiVal('t-note', '').trim();
  var txid = uiVal('t-txid', '').trim();
  if (txid !== '' && !isValidTxid(txid)) { tradeFormError('Transaction ID looks invalid — paste the full tx hash.'); return; }
  var manualRateRaw = uiVal('t-manual-rate', '').trim();
  var manualPriceRaw = uiVal('t-manual-price', '').trim();
  var manualRate = (manualRateRaw === '') ? null : Number(manualRateRaw);
  if (manualRate !== null && (!isFinite(manualRate) || manualRate <= 0)) { tradeFormError('Manual rate must be > 0.'); return; }
  var manualPrice = (manualPriceRaw === '') ? null : Number(manualPriceRaw);
  if (manualPrice !== null && (!isFinite(manualPrice) || manualPrice <= 0)) { tradeFormError('Manual price must be > 0.'); return; }
  var isEditing = !!(editingTradeId);
  // --- Swap: creates a linked sell+buy pair ---
  if (side === 'swap' && !isEditing) {
    var toAccSwap = accountById(st0, uiVal('t-toaccount', ''));
    if (!toAccSwap) { tradeFormError('Pick a destination account for the swap.'); return; }
    if (toAccSwap.id === accountId) { tradeFormError('Swap needs two different accounts.'); return; }
    var fromSym = symbol;
    var toSym = String(toAccSwap.ticker).toUpperCase();
    if (fromSym === toSym) { tradeFormError('Same asset — use Transfer instead of Swap.'); return; }
    var fromQty = Number(uiVal('t-qty', ''));
    var toQty = Number(uiVal('t-toqty', ''));
    var swapTotal = Number(uiVal('t-total', ''));
    var ccySelS = uiVal('t-currency', 'EUR');
    var swapCcy = (ccySelS === 'CUSTOM' ? uiVal('t-custom-ccy', '').trim().toUpperCase() : String(ccySelS).toUpperCase());
    var feeRawS = uiVal('t-fee', '').trim();
    var feeS = (feeRawS === '') ? 0 : Number(feeRawS);
    var feeCcyS = swapCcy; // one fiat per trade: fee follows the trade currency
    if (!isFinite(fromQty) || fromQty <= 0) { tradeFormError('From quantity must be > 0.'); return; }
    if (!isFinite(toQty) || toQty <= 0) { tradeFormError('Received quantity must be > 0.'); return; }
    if (!isFinite(swapTotal) || swapTotal <= 0) { tradeFormError('Fiat value must be > 0 (for tax).'); return; }
    if (!isValidCurrencyCode(swapCcy)) { tradeFormError('Currency code invalid.'); return; }
    if (!isFinite(feeS) || feeS < 0) { tradeFormError('Fee must be >= 0.'); return; }
    var heldFrom = 0;
    try { heldFrom = heldForAccount(st0.trades, accountId, fromSym); } catch (e) { heldFrom = heldQtyFor(accountTrades(st0, accountId), fromSym); }
    if (fromQty > heldFrom + LEDGER_EPS) { tradeFormError('oversell: max sellable is ' + heldFrom); return; }
    lockSubmit(true, 'Saving…');
    function proceedSwap(lock) {
      var st = loadState();
      var swapId = uid();
      var sellLeg = { id: uid(), type: 'sell', symbol: fromSym, qty: fromQty, total: swapTotal, currency: swapCcy, date: date, fee: feeS, feeCurrency: feeCcyS, note: (note ? note + ' ' : '') + '[swap]', fxLock: lock, accountId: accountId, swapId: swapId, createdAt: new Date().toISOString() };
      var buyLeg = { id: uid(), type: 'buy', symbol: toSym, qty: toQty, total: swapTotal, currency: swapCcy, date: date, fee: 0, feeCurrency: swapCcy, note: (note ? note + ' ' : '') + '[swap]', fxLock: lock, accountId: toAccSwap.id, swapId: swapId, createdAt: new Date().toISOString() };
      if (manualPrice !== null) {
        // Manual quote is for the received asset, denominated in the trade's
        // own Currency (like total and fee) — never the header display fiat.
        // The sold leg freezes via history.
        buyLeg.execLock = { price: manualPrice, vs: String(swapCcy).toUpperCase(), source: 'manual' };
      }
      var e1 = validateTrade(sellLeg, heldFrom);
      if (e1) { tradeFormError(e1); lockSubmit(false, 'Add record'); return; }
      st.trades.push(sellLeg);
      st.trades.push(buyLeg);
      if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Add record'); return; }
      // Freeze reference exec quotes in the background (saving never waits).
      try { freezeExecLock(sellLeg.id, fromSym, date, String(main).toUpperCase(), (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
      try { freezeExecLock(buyLeg.id, toSym, date, String(main).toUpperCase(), (toAccSwap && toAccSwap.kind) || undefined); } catch (e) { /* ignore */ }
      uiSetVal('t-qty', ''); uiSetVal('t-toqty', ''); uiSetVal('t-total', ''); uiSetVal('t-note', ''); uiSetVal('t-txid', ''); uiSetVal('t-manual-rate', ''); uiSetVal('t-manual-price', '');
      var dd = document.getElementById('t-date'); if (dd) dd.value = todayStr();
      tradeFormError(null);
      lockSubmit(false, 'Add record');
      refreshPrices();
      navTo(accountId);
      render();
      closeDialog('trade-dialog');
    }
    (function resolveSwapFx() {
      var mainU = String(main).toUpperCase();
      var needTotalS = (swapCcy !== mainU);
      function lock11S(f) { return { pair: f + '/' + mainU, rate: 1, source: '1:1', interpolated: false }; }
      function failSwap(pairs) {
        lockSubmit(false, 'Add record');
        showBanner('FX rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.', 'error', {
          title: 'FX error',
          lines: [
            'Pair: ' + pairs.join(', '),
            'Trade date: ' + date,
            'Cause: no ECB fixing cached and the rate request failed (weekend gap or network).',
            'Tip: nothing was saved yet — enter the rate manually to proceed.'
          ]
        });
        tradeFormError('ECB rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.');
      }
      if (!needTotalS) {
        proceedSwap(lock11S(swapCcy));
        return;
      }
      if (manualRate !== null) {
        proceedSwap({ pair: swapCcy + '/' + mainU, rate: manualRate, source: 'manual', interpolated: false });
        return;
      }
      lockSubmit(true, 'Saving…');
      fetchEcbRate(date, swapCcy, mainU).then(function (tRes) {
        var tl = { pair: swapCcy + '/' + mainU, rate: tRes.rate, source: tRes.source, interpolated: !!tRes.interpolated };
        try { cacheRate(date, swapCcy, mainU, tRes.rate, tRes.source); saveFxCache(); } catch (e) { /* ignore */ }
        proceedSwap(tl);
      }, function () {
        failSwap([swapCcy + ' → ' + mainU]);
      });
    })();
    return;
  }
  // --- Single-leg types (buy/sell/transfer/income/expense), new or edit ---
  var qtyRaw = uiVal('t-qty', '');
  var totalRaw = uiVal('t-total', '');
  var ccySel = uiVal('t-currency', 'EUR');
  var currency = (ccySel === 'CUSTOM' ? uiVal('t-custom-ccy', '').trim().toUpperCase() : String(ccySel).toUpperCase());
  var feeRaw = uiVal('t-fee', '').trim();
  var fee = (feeRaw === '') ? 0 : Number(feeRaw);
  var feeCurrency = currency; // one fiat per trade: fee follows Currency
  var netRaw = uiVal('t-networkfee', '');
  var networkFee = (netRaw === undefined || netRaw === null || String(netRaw).trim() === '') ? 0 : Number(netRaw);
  var toQtyRaw = uiVal('t-toqty', '');
  // Send + receive mode: the fee is always the difference (exchange +
  // network fee), recorded as the loss — e.g. exchange → self-custody or
  // wallet → wallet. Received is required; the fee field is computed-only.
  if (side === 'transfer') {
    if (String(toQtyRaw).trim() === '') { tradeFormError('Enter what you received (> 0).'); return; }
    var sentChk = Number(qtyRaw);
    var recvChk = Number(toQtyRaw);
    if (!isFinite(sentChk) || sentChk <= 0) { tradeFormError('Enter how much you sent (> 0).'); return; }
    if (!isFinite(recvChk) || recvChk <= 0) { tradeFormError('Received must be > 0.'); return; }
    if (recvChk > sentChk) { tradeFormError('Received cannot exceed sent — the fee cannot be negative.'); return; }
    networkFee = roundQty8(sentChk - recvChk);
    uiSetVal('t-networkfee', String(networkFee));
  }
  var toAccId = uiVal('t-toaccount', '');
  if (!symbol || !/^[A-Z0-9._-]{1,12}$/.test(symbol)) { tradeFormError('Account ticker looks invalid.'); return; }
  if (!isFinite(fee) || fee < 0) { tradeFormError('Fee must be >= 0.'); return; }
  if (!isFinite(networkFee) || networkFee < 0) { tradeFormError('Transfer fees must be >= 0.'); return; }
  var qty = (side === 'expense' && String(qtyRaw).trim() === '') ? null : Number(qtyRaw);
  var total = (String(totalRaw).trim() === '') ? (side === 'buy' || side === 'sell' ? NaN : 0) : Number(totalRaw);
  if (side === 'transfer') {
    // Transfers carry no fiat of their own: the network fee IS the fee,
    // valued in fiat at the frozen historical rate. Ignore any stale fiat
    // inputs (the rows are hidden for transfers).
    fee = 0; total = 0; currency = String(main).toUpperCase(); feeCurrency = currency;
  }
  // Per-type validation (messages match legacy for buy/sell so tests keep passing).
  if (side === 'buy' || side === 'sell') {
    if (!isFinite(qty) || qty <= 0) { tradeFormError('Quantity must be > 0.'); return; }
    if (!isFinite(total) || total < 0) { tradeFormError('Total must be >= 0.'); return; }
    if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid — pick one or enter a 2–10 letter code.'); return; }
  } else if (side === 'transfer') {
    if (!isFinite(qty) || qty <= 0) { tradeFormError('Enter how much you sent (> 0).'); return; }
    if (!isFinite(networkFee) || networkFee < 0 || networkFee >= qty) { tradeFormError('Transfer fees must be >= 0 and < qty.'); return; }
    // No destination: on-chain move inside this account (fresh address, same
    // owner). With one: it must be a different account with the same asset.
    var toAccT = toAccId ? accountById(st0, toAccId) : null;
    if (toAccId && !toAccT) { tradeFormError('Destination account not found.'); return; }
    if (toAccT) {
      if (toAccT.id === accountId) { tradeFormError('Transfer needs two different accounts.'); return; }
      if (String(toAccT.ticker).toUpperCase() !== symbol) { tradeFormError('Transfer needs the same asset in both accounts — use Swap for different assets.'); return; }
    }
  } else if (side === 'income') {
    if (!isFinite(qty) || qty <= 0) { tradeFormError('Quantity must be > 0.'); return; }
    if (String(totalRaw).trim() !== '' && (!isFinite(total) || total < 0)) { tradeFormError('Total must be >= 0.'); return; }
    if (String(totalRaw).trim() !== '') {
      if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid.'); return; }
    } else { total = 0; currency = String(main).toUpperCase(); }
  } else if (side === 'expense') {
    var hasQ = !(String(qtyRaw).trim() === '');
    var hasT = !(String(totalRaw).trim() === '');
    if (!hasQ && !hasT) { tradeFormError('Expense needs a quantity or a cash amount.'); return; }
    if (hasQ && (!isFinite(qty) || qty <= 0)) { tradeFormError('Quantity must be > 0.'); return; }
    if (hasT && (!isFinite(total) || total <= 0)) { tradeFormError('Fiat amount must be > 0.'); return; }
    if (!hasQ) qty = null;
    if (!hasT) { total = 0; currency = String(main).toUpperCase(); }
    else if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid.'); return; }
  }
  var from = currency;
  // Held checks (directional: source holdings for sell/transfer/expense-qty).
  try {
    if (side === 'sell' || side === 'transfer' || (side === 'expense' && qty !== null)) {
      var heldNeed = side === 'transfer' ? qty : qty;
      var heldHave = 0;
      try { heldHave = heldForAccount(st0.trades, accountId, symbol); }
      catch (e) { heldHave = heldQtyFor(accountTrades(st0, accountId), symbol); }
      // When editing, add back the old qty if same account+symbol (so saving unchanged passes).
      if (isEditing) {
        var oldTr = null;
        (st0.trades || []).forEach(function (t) { if (t && t.id === editingTradeId) oldTr = t; });
        if (oldTr && oldTr.accountId === accountId && String(oldTr.symbol).toUpperCase() === symbol) {
          if (oldTr.type === 'sell' || oldTr.type === 'expense') heldHave += Number(oldTr.qty) || 0;
          else if (oldTr.type === 'buy' || oldTr.type === 'income') heldHave -= 0; // buys don't reduce held for oversell check of new qty? Actually editing a buy doesn't need held check.
          else if (oldTr.type === 'transfer' && oldTr.accountId === accountId) heldHave += Number(oldTr.qty) || 0;
        }
      }
      if (side !== 'buy' && side !== 'income' && qty !== null && qty > heldHave + LEDGER_EPS) {
        tradeFormError('oversell: max sellable is ' + heldHave);
        return;
      }
    }
  } catch (e) { /* validation continues; engine clamps anyway */ }
  // proceed() re-reads state so a slow ECB fetch cannot clobber newer writes.
    function proceed(lock) {
    var st = loadState();
    // NOTE: a trade-dialog manual price stays per-trade (trade.execLock,
    // attached below) and never touches the global live-price overrides —
    // those belong to Settings only.
    function withFeeLock(trade) {
      // One fiat per trade: no separate fee lock is ever written; a stale one
      // from older data is dropped so the fee always rides the trade lock.
      try { delete trade.feeFxLock; } catch (e) { /* ignore */ }
      return trade;
    }
    var trade;
    if (isEditing) {
      var idx = -1;
      for (var ii = 0; ii < (st.trades || []).length; ii++) if (st.trades[ii] && st.trades[ii].id === editingTradeId) { idx = ii; break; }
      if (idx === -1) { tradeFormError('Trade not found — it may have been deleted.'); lockSubmit(false, 'Save changes'); return; }
      var prev = st.trades[idx];
      trade = {
        id: prev.id,
        type: side,
        symbol: symbol,
        qty: qty,
        total: total,
        currency: from,
        date: date,
        fee: fee,
        feeCurrency: feeCurrency,
        note: note,
        fxLock: lock,
        accountId: accountId,
        createdAt: prev.createdAt || new Date().toISOString()
      };
      if (txid !== '') trade.txid = txid;
      withFeeLock(trade);
      // Reference exec quote: manual wins; else keep the frozen quote when the
      // identifying fields are untouched; otherwise refreeze after save.
      // Transfers freeze it too: it values the network fee in fiat at the
      // tx-date rate (Fee in fiat rate). Other rows carry no execLock.
      var needRefreeze = false;
      if (side === 'buy' || side === 'sell' || side === 'transfer') {
        if (manualPrice !== null) {
          // Manual quote follows the trade's Currency field (like total and
          // fee), never the header display fiat — display converts it.
          trade.execLock = { price: manualPrice, vs: String(from).toUpperCase(), source: 'manual' };
        } else {
          var prevFrozen = null;
          try { prevFrozen = frozenExecOf(prev); } catch (e) { prevFrozen = null; }
          // A cleared manual field drops the manual quote (history refreezes);
          // an untouched history quote is kept as-is, no refetch.
          var keepIt = prevFrozen && String(prevFrozen.source).toLowerCase() !== 'manual' &&
            prev.date === date && String(prev.symbol).toUpperCase() === symbol;
          if (keepIt) {
            trade.execLock = { price: prevFrozen.price, vs: prevFrozen.vs, source: prevFrozen.source };
          } else {
            try { delete trade.execLock; } catch (e) { /* ignore */ }
            needRefreeze = true;
          }
        }
      } else {
        try { delete trade.execLock; } catch (e) { /* ignore */ }
      }
      if (side === 'transfer') { if (toAccId) trade.toAccountId = toAccId; trade.networkFee = networkFee; }
      else if (side === 'expense' && qty === null) { delete trade.qty; }
      if (prev.swapId) trade.swapId = prev.swapId;
      var errE = validateTrade(trade, 1e18); // structural only; held already checked directionally above
      if (errE && String(errE).indexOf('oversell') === -1) { tradeFormError(errE); lockSubmit(false, 'Save changes'); return; }
      // Re-check oversell directionally with fresh state (excluding self).
      try {
        var others = (st.trades || []).filter(function (t) { return !t || t.id !== editingTradeId; });
        if (side === 'sell' || side === 'transfer' || (side === 'expense' && qty !== null)) {
          var h2 = heldForAccount(others, accountId, symbol);
          var need2 = qty;
          if (need2 > h2 + LEDGER_EPS) { tradeFormError('oversell: max sellable is ' + h2); lockSubmit(false, 'Save changes'); return; }
        }
      } catch (e2) { /* ignore */ }
      st.trades[idx] = trade;
      if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Save changes'); return; }
      if (needRefreeze) {
        try { freezeExecLock(trade.id, symbol, date, mainU, (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
      }
      editingTradeId = null;
      tradeFormError(null);
      lockSubmit(false, 'Add record');
      var sb2 = document.getElementById('t-submit'); if (sb2) sb2.textContent = 'Add record';
      var tt2 = document.getElementById('trade-dialog-title'); if (tt2) tt2.textContent = 'Add record';
      refreshPrices();
      render();
      closeDialog('trade-dialog');
      return;
    }
    trade = {
      id: uid(),
      type: side,
      symbol: symbol,
      qty: qty,
      total: total,
      currency: from,
      date: date,
      fee: fee,
      feeCurrency: feeCurrency,
      note: note,
      fxLock: lock,
      accountId: accountId,
      createdAt: new Date().toISOString()
    };
    if (txid !== '') trade.txid = txid;
    withFeeLock(trade);
    if (side === 'transfer') { if (toAccId) trade.toAccountId = toAccId; trade.networkFee = networkFee; }
    if (side === 'expense' && qty === null) { delete trade.qty; }
    if (side === 'buy' || side === 'sell' || side === 'transfer') {
      if (manualPrice !== null) {
        // Same rule as the edit path: the manual quote follows the trade's
        // Currency field, never the header display fiat.
        trade.execLock = { price: manualPrice, vs: String(from).toUpperCase(), source: 'manual' };
      }
    } else {
      try { delete trade.execLock; } catch (e) { /* ignore */ }
    }
    var heldForCheck = 1e18;
    try {
      if (side === 'sell' || side === 'transfer' || (side === 'expense' && qty !== null)) {
        heldForCheck = heldForAccount(st.trades, accountId, symbol);
      }
    } catch (e3) { heldForCheck = heldQtyFor(accountTrades(st, accountId), symbol); }
    var err = (side === 'sell' || side === 'transfer' || (side === 'expense' && qty !== null))
      ? validateTrade(trade, heldForCheck)
      : validateTrade(trade, 1e18);
    if (err) { tradeFormError(err); lockSubmit(false, 'Add record'); return; }
    st.trades.push(trade);
    if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Add record'); return; }
    if ((side === 'buy' || side === 'sell' || side === 'transfer') && manualPrice === null) {
      // No manual quote: freeze the reference exec price in the background.
      // Saving never waits on it; failure just leaves the legacy async path.
      try { freezeExecLock(trade.id, symbol, date, mainU, (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
    }
    uiSetVal('t-qty', '');
    uiSetVal('t-toqty', '');
    uiSetVal('t-total', '');
    uiSetVal('t-note', '');
    uiSetVal('t-txid', '');
    uiSetVal('t-networkfee', '');
    uiSetVal('t-manual-rate', '');
    uiSetVal('t-manual-price', '');
    var d = document.getElementById('t-date');
    if (d) d.value = todayStr();
    tradeFormError(null);
    lockSubmit(false, 'Add record');
    refreshPrices(); // recompute + render when fresh prices land (renders sync too)
    navTo(side === 'transfer' ? accountId : accountId);
    render(); // route() picks up the URL: the trade's account page shows the new rows
    closeDialog('trade-dialog');
  }
  // One fiat per trade: only the trade currency->main rate is ever needed.
  // Native total/fee stay in stone; only the lock converts for display/P&L.
  var mainU = String(main).toUpperCase();
  var needTotal = (total > 0 && from !== mainU);
  function lock11(pairFrom) {
    return { pair: pairFrom + '/' + mainU, rate: 1, source: '1:1', interpolated: false };
  }
  function fxError(pairs) {
    lockSubmit(false, 'Add record');
    showBanner('FX rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.', 'error', {
      title: 'FX error',
      lines: [
        'Pair: ' + pairs.join(', '),
        'Trade date: ' + date,
        'Cause: no ECB fixing cached and the rate request failed (weekend gap or network).',
        'Tip: nothing was saved yet — enter the rate manually to proceed.'
      ]
    });
    tradeFormError('ECB rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.');
  }
  if (!needTotal) {
    proceed(lock11(from));
    return;
  }
  if (manualRate !== null) {
    proceed((from === mainU) ? lock11(from)
      : { pair: from + '/' + mainU, rate: manualRate, source: 'manual', interpolated: false });
    return;
  }
  lockSubmit(true, 'Saving…');
  fetchEcbRate(date, from, mainU).then(function (totalRes) {
    var tLock = { pair: from + '/' + mainU, rate: totalRes.rate, source: totalRes.source, interpolated: !!totalRes.interpolated };
    try { cacheRate(date, from, mainU, totalRes.rate, totalRes.source); saveFxCache(); } catch (e) { /* ignore */ }
    proceed(tLock);
  }, function () {
    fxError([from + ' → ' + mainU]);
  });
}

// --- Top bar + dialogs ---
// Sticky top panel: totals, main currency, cost toggle, Add record +
// Settings buttons. The trade form and settings live in modal <dialog>s
// so the page never scrolls through them. Dialog content keeps the same
// element IDs, so tests.html and existing handlers keep working.

var dialogOpener = null;

// While any modal dialog is open the page underneath is frozen: no
// background scroll (body lock) and no background interaction (native
// showModal already makes the backdrop inert + traps focus). Stacked
// dialogs (e.g. Settings + confirm) count, so closing one never unlocks
// while another is still open. Ancient browsers without showModal fall
// back to the [open] attribute: scroll still locks, clicks do not.
var MODAL_IDS = ['trade-dialog', 'account-dialog', 'settings-dialog', 'confirm-dialog', 'note-dialog', 'error-dialog', 'color-dialog'];

function updateModalLock() {
  try {
    if (typeof document === 'undefined') return;
    var open = 0;
    var i, d;
    for (i = 0; i < MODAL_IDS.length; i++) {
      d = document.getElementById(MODAL_IDS[i]);
      if (d && (d.open || (d.hasAttribute && d.hasAttribute('open')))) open++;
    }
    var body = document.body;
    if (!body || !body.classList) return;
    if (open > 0) {
      try { body.classList.add('modal-open'); } catch (e) { /* ignore */ }
    } else {
      try { body.classList.remove('modal-open'); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

function openDialog(id) {
  var dlg = document.getElementById(id);
  if (!dlg) return;
  dialogOpener = document.activeElement;
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
  try { updateModalLock(); } catch (e) { /* ignore */ }
  if (id === 'settings-dialog') {
    try { refreshSettingsAlert(); } catch (e) { /* ignore */ }
  }
  var first = dlg.querySelector('input, select, button:not([data-close])');
  if (first && typeof first.focus === 'function') {
    try { first.focus(); } catch (e) { /* ignore */ }
  }
}

function closeDialog(id) {
  var dlg = typeof id === 'string' ? document.getElementById(id) : id;
  if (!dlg) return;
  if (typeof dlg.close === 'function' && dlg.open) dlg.close();
  else dlg.removeAttribute('open');
  try { updateModalLock(); } catch (e) { /* ignore */ }
}

function returnFocus() {
  if (dialogOpener && typeof dialogOpener.focus === 'function') {
    try { dialogOpener.focus(); } catch (e) { /* ignore */ }
  }
  dialogOpener = null;
}

// --- Custom confirm (no browser alerts) ---
// confirmAction renders the in-app confirm dialog and resolves true/false.
// Only one pending confirm exists at a time; a newer call settles the older
// one as cancelled. Esc settles as cancelled via close/cancel.

var confirmSettle = null;

function confirmAction(title, message, okText, danger) {
  if (confirmSettle) settleConfirm(false);
  if (confirmSettle3) settleConfirm3('dismiss');
  var dlg = document.getElementById('confirm-dialog');
  var t = document.getElementById('confirm-title');
  var m = document.getElementById('confirm-message');
  var ok = document.getElementById('confirm-ok');
  var cancel = document.getElementById('confirm-cancel');
  if (!dlg || !t || !m || !ok) {
    return Promise.resolve(typeof window.confirm === 'function' ? window.confirm(message) : true);
  }
  t.textContent = title || 'Are you sure?';
  m.textContent = message || '';
  ok.textContent = okText || 'Confirm';
  ok.className = danger === false ? 'primary' : 'primary danger-btn';
  // A three-way confirm may have relabeled/restyled the shared buttons:
  // always restore the plain Cancel look here.
  if (cancel) {
    cancel.textContent = 'Cancel';
    cancel.className = '';
  }
  openDialog('confirm-dialog');
  return new Promise(function (resolve) { confirmSettle = resolve; });
}

function settleConfirm(v) {
  var dlg = document.getElementById('confirm-dialog');
  if (dlg) closeDialog(dlg);
  if (confirmSettle) {
    var s = confirmSettle;
    confirmSettle = null;
    s(v);
  }
}

// Three-way variant for decisions with two real actions (e.g. a taken sync
// name: download the drive copy OR upload over it). Resolves 'primary',
// 'secondary', or 'dismiss' (Esc/close, preemption). The shared
// buttons route to whichever confirm is pending; bool callers are unaffected.
var confirmSettle3 = null;

function settleConfirm3(v) {
  var dlg = document.getElementById('confirm-dialog');
  if (dlg) closeDialog(dlg);
  if (confirmSettle3) {
    var s = confirmSettle3;
    confirmSettle3 = null;
    s(v);
  }
}

function confirmAction3(title, message, primaryText, secondaryText) {
  if (confirmSettle) settleConfirm(false);
  if (confirmSettle3) settleConfirm3('dismiss');
  var dlg = document.getElementById('confirm-dialog');
  var t = document.getElementById('confirm-title');
  var m = document.getElementById('confirm-message');
  var ok = document.getElementById('confirm-ok');
  var cancel = document.getElementById('confirm-cancel');
  if (!dlg || !t || !m || !ok || !cancel) {
    return Promise.resolve(typeof window.confirm === 'function' ? (window.confirm(message) ? 'primary' : 'dismiss') : 'dismiss');
  }
  t.textContent = title || 'Are you sure?';
  m.textContent = message || '';
  ok.textContent = primaryText || 'Confirm';
  ok.className = 'primary';
  cancel.textContent = secondaryText || 'Cancel';
  cancel.className = 'primary danger-btn';
  openDialog('confirm-dialog');
  return new Promise(function (resolve) { confirmSettle3 = resolve; });
}

function wireDialog(id) {
  var dlg = document.getElementById(id);
  if (!dlg || dlg.getAttribute('data-wired')) return;
  dlg.setAttribute('data-wired', '1');
  dlg.addEventListener('click', function (e) {
    // No backdrop dismiss: dialogs close only via their X / action buttons
    // or Esc. (A stray outside click must never silently drop a form.)
    var c = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (c) closeDialog(dlg);
  });
  dlg.addEventListener('close', returnFocus);
  // Native Esc closes bypass closeDialog(): recompute the
  // background freeze here so it can never stick (or lift early).
  dlg.addEventListener('close', updateModalLock);
}

var menuOutsideWired = false;

// The account ··· menu is a native <details>: it only toggles on its own
// summary, so dismiss it on outside click / focus leave / Escape.
function wireMenuOutside() {
  if (menuOutsideWired) return;
  menuOutsideWired = true;
  function closeOpenMenus(except) {
    var open = (typeof document !== 'undefined' && document.querySelectorAll)
      ? document.querySelectorAll('details.menu[open]')
      : [];
    for (var i = 0; i < open.length; i++) {
      if (except && (open[i] === except || open[i].contains(except))) continue;
      open[i].removeAttribute('open');
    }
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', function (e) {
      var t = e ? e.target : null;
      if (t && t.closest && t.closest('details.menu')) return; // inside: native toggle / buttons handle it
      closeOpenMenus(null);
    });
    document.addEventListener('focusin', function (e) {
      var t = e ? e.target : null;
      if (t && t.closest && t.closest('details.menu')) return;
      closeOpenMenus(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) closeOpenMenus(null);
    });
  }
}

function buildTopbar() {
  wireDialog('trade-dialog');
  wireDialog('settings-dialog');
  wireDialog('account-dialog');
  wireDialog('confirm-dialog');
  wireDialog('note-dialog');
  wireDialog('error-dialog');
  wireDialog('color-dialog');
  var cdlg = document.getElementById('color-dialog');
  if (cdlg && !cdlg.getAttribute('data-color-wired')) {
    cdlg.setAttribute('data-color-wired', '1');
    cdlg.addEventListener('click', function (e) {
      var pick = e.target && e.target.closest ? e.target.closest('[data-color-pick]') : null;
      if (pick) {
        applyColorToSelection(pick.getAttribute('data-color-pick'));
        return;
      }
    });
  }
  var cApply = document.getElementById('c-apply');
  if (cApply && !cApply.getAttribute('data-wired')) {
    cApply.setAttribute('data-wired', '1');
    cApply.addEventListener('click', function () {
      var raw = uiVal('c-hex', '').trim();
      if (raw !== '' && /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) raw = '#' + raw;
      if (raw !== '') {
        if (!isValidHexColor(raw)) {
          showBanner('Enter a hex color like #F7931A.');
          return;
        }
        applyColorToSelection(raw);
        return;
      }
      applyColorToSelection(uiVal('c-custom', '#e3c57c'));
    });
  }
  var cReset = document.getElementById('c-reset');
  if (cReset && !cReset.getAttribute('data-wired')) {
    cReset.setAttribute('data-wired', '1');
    cReset.addEventListener('click', function () { applyColorToSelection(null); });
  }
  var bclose = document.getElementById('banner-close');
  if (bclose && !bclose.getAttribute('data-wired')) {
    bclose.setAttribute('data-wired', '1');
    bclose.addEventListener('click', clearBanner);
  }
  var brandHome = document.getElementById('brand-home');
  if (brandHome && !brandHome.getAttribute('data-wired')) {
    brandHome.setAttribute('data-wired', '1');
    brandHome.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      navHome();
    });
  }
  var cok = document.getElementById('confirm-ok');
  if (cok && !cok.getAttribute('data-wired')) {
    cok.setAttribute('data-wired', '1');
    cok.addEventListener('click', function () {
      if (confirmSettle3) settleConfirm3('primary');
      else settleConfirm(true);
    });
  }
  var ccan = document.getElementById('confirm-cancel');
  if (ccan && !ccan.getAttribute('data-wired')) {
    ccan.setAttribute('data-wired', '1');
    ccan.addEventListener('click', function () {
      if (confirmSettle3) settleConfirm3('secondary');
      else settleConfirm(false);
    });
  }
  var cdlg = document.getElementById('confirm-dialog');
  if (cdlg && !cdlg.getAttribute('data-ev-wired')) {
    cdlg.setAttribute('data-ev-wired', '1');
    cdlg.addEventListener('cancel', function () { settleConfirm(false); settleConfirm3('dismiss'); });
    cdlg.addEventListener('close', function () { settleConfirm(false); settleConfirm3('dismiss'); });
  }
  var main = document.getElementById('tb-main');
  if (main && !main.getAttribute('data-wired')) {
    main.setAttribute('data-wired', '1');
    main.addEventListener('change', function (e) {
      var st = loadState();
      st.settings.mainCurrency = e.target.value;
      if (!saveStateGuarded(st)) return;
      clearBanner();
      livePrices = {}; // stale prices are in the old currency — clear before repaint
      render(); // instant paint, then historical pairs fill in + repaint
      refreshPrices(); // live valuation re-fetched in the new currency
    });
  }
  var methods = [['tb-avg', 'average'], ['tb-fifo', 'fifo']];
  methods.forEach(function (pair) {
    var b = document.getElementById(pair[0]);
    if (!b || b.getAttribute('data-wired')) return;
    b.setAttribute('data-wired', '1');
    b.addEventListener('click', function () {
      var st = loadState();
      st.settings.costMethod = pair[1];
      if (!saveStateGuarded(st)) return;
      render(); // no refetch: cost view needs no new prices
    });
  });
  var add = document.getElementById('tb-add');
  if (add && !add.getAttribute('data-wired')) {
    add.setAttribute('data-wired', '1');
    add.addEventListener('click', function () {
      var cur = loadState();
      if (!Array.isArray(cur.accounts) || cur.accounts.length === 0) {
        showBanner('Create your first account to enable Add record.');
        var host = document.getElementById('accounts');
        if (host && host.scrollIntoView) {
          try { host.scrollIntoView(); } catch (e) { /* ignore */ }
        }
        return;
      }
      // On an open account page the trade belongs to that account (locked);
      // on home the account stays selectable (defaults to the default).
      var rid = accountDetailId();
      var open = (typeof rid === 'string' && rid) ? accountById(cur, rid) : null;
      if (open) openPrefillTrade(open.id, true);
      else openPrefillTrade(null);
    });
  }
  var gear = document.getElementById('tb-settings');
  if (gear && !gear.getAttribute('data-wired')) {
    gear.setAttribute('data-wired', '1');
    gear.addEventListener('click', function () { showSettingsTab('overrides'); openDialog('settings-dialog'); });
  }
  var syncBtn = document.getElementById('tb-sync');
  if (syncBtn && !syncBtn.getAttribute('data-wired')) {
    syncBtn.setAttribute('data-wired', '1');
    syncBtn.addEventListener('click', function () { showSettingsTab('sync'); openDialog('settings-dialog'); });
  }
  var fab = document.getElementById('fab-trade');
  if (fab && !fab.getAttribute('data-wired')) {
    fab.setAttribute('data-wired', '1');
    fab.addEventListener('click', function () {
      var tb = document.getElementById('tb-add');
      if (tb) tb.click();
      else openPrefillTrade(null);
    });
  }
}

// --- Settings dialog ---
// Override editor, download/upload, clear-with-confirm. Main currency +
// cost method live in the sticky top bar (buildTopbar). A main-currency
// switch re-fetches live prices and refills historical display rates;
// stored trades (native amounts, entry locks) are never rewritten.

function showSettingsTab(name) {
  var host = document.getElementById('settings-dialog-body');
  if (!host) return;
  var want = 'overrides';
  Array.prototype.forEach.call(host.querySelectorAll('[data-settab]'), function (t) {
    if (t.getAttribute('data-settab') === name) want = name;
  });
  Array.prototype.forEach.call(host.querySelectorAll('[data-settab]'), function (t) {
    t.setAttribute('aria-selected', t.getAttribute('data-settab') === want ? 'true' : 'false');
  });
  Array.prototype.forEach.call(host.querySelectorAll('[data-setpanel]'), function (p) {
    p.hidden = p.getAttribute('data-setpanel') !== want;
  });
}

function buildSettings() {
  var host = document.getElementById('settings-dialog-body');
  if (!host || document.getElementById('o-add')) return;
  var wrap = document.createElement('div');
  wrap.className = 'set-layout';
  wrap.innerHTML =
    '<div class="set-tabs" role="tablist" aria-label="Settings sections">' +
    '<button type="button" role="tab" data-settab="overrides" aria-selected="true">Price overrides</button>' +
    '<button type="button" role="tab" data-settab="backup" aria-selected="false">Backup &amp; restore</button>' +
    '<button type="button" role="tab" data-settab="sync" aria-selected="false">Cloud Sync</button>' +
    '<button type="button" role="tab" data-settab="danger" aria-selected="false">Danger zone</button>' +
    '</div>' +
    '<div class="set-panels">' +
    '<section data-setpanel="overrides" role="tabpanel" aria-label="Price overrides">' +
    '<label for="o-symbol">Symbol</label>' +
    '<input id="o-symbol" autocomplete="off" spellcheck="false" placeholder="e.g. BTC">' +
    '<label for="o-price">Price (in current fiat)</label>' +
    '<input id="o-price" inputmode="decimal" placeholder="e.g. 67000">' +
    '<button id="o-add" type="button">Save override</button>' +
    '<ul id="o-list"></ul>' +
    '</section>' +
    '<section data-setpanel="backup" role="tabpanel" aria-label="Backup and restore" hidden>' +
    '<p class="muted set-blurb">Your data never leaves this browser. Download a backup file to move it to another device.</p>' +
    '<button id="s-download" type="button">Download backup</button>' +
    '<button id="s-csv-trades" type="button">Export trades CSV</button>' +
    '<button id="s-csv-lots" type="button">Export tax lots CSV (FIFO)</button>' +
    '<span id="s-upload-label">Restore from file</span>' +
    '<input id="s-upload" type="file" accept="application/json,.json">' +
    '</section>' +
    '<section data-setpanel="sync" role="tabpanel" aria-label="Encrypted sync" hidden>' +
    '<p class="muted set-blurb">Sync an <strong>encrypted</strong> copy of your data to a drive you choose. The drive only ever sees ciphertext — bring the passphrase to any device to restore.</p>' +
    '<label for="sy-provider">Provider</label>' +
    '<select id="sy-provider">' +
    '<option value="webdav">WebDAV / Nextcloud</option>' +
    '<option value="gdrive">Google Drive</option>' +
    '<option value="dropbox">Dropbox</option>' +
    '<option value="megas3">MEGA (S4 object storage)</option>' +
    '</select>' +
    '<p class="muted set-blurb" id="sy-hint"></p>' +
    '<div id="sy-g-webdav">' +
    '<label for="sy-url">Server URL</label>' +
    '<input id="sy-url" autocomplete="off" spellcheck="false" placeholder="https://cloud.example.com/remote.php/dav/files/USER/Plutus">' +
    '<label for="sy-user">Username</label>' +
    '<input id="sy-user" autocomplete="username" spellcheck="false">' +
    '<label for="sy-passwd">App password</label>' +
    '<input id="sy-passwd" type="password" autocomplete="current-password">' +
    '<label class="sync-check" for="sy-remember"><input id="sy-remember" type="checkbox"> Remember password in this browser</label>' +
    '<label for="sy-filename">File name</label>' +
    '<input id="sy-filename" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
    '<p class="muted set-blurb">The ending .enc.json is fixed — type just the name. Missing folders are created automatically.</p>' +
    '</div>' +
    '<div id="sy-g-oauth" hidden>' +
    '<p class="muted set-blurb" id="sy-oneclick-note"></p>' +
    '<label for="sy-filename2">File name</label>' +
    '<input id="sy-filename2" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
    '<p class="muted set-blurb">The ending .enc.json is fixed — type just the name.</p>' +
    '<label for="sy-folder2">Folder (optional)</label>' +
    '<input id="sy-folder2" autocomplete="off" spellcheck="false" placeholder="e.g. Plutus/Work">' +
    '<p class="muted set-blurb">Keep profiles apart with folders — a name already taken in the folder is refused, never overwritten. Leave empty for the top level; subfolders are created if missing.</p>' +
    '<details class="adv" id="sy-adv">' +
    '<summary>Bring your own OAuth app (advanced)</summary>' +
    '<label for="sy-client">OAuth client ID (your own app)</label>' +
    '<input id="sy-client" autocomplete="off" spellcheck="false">' +
    '<div id="sy-g-secret">' +
    '<label for="sy-secret">OAuth client secret (Google only)</label>' +
    '<input id="sy-secret" type="password" autocomplete="off">' +
    '</div>' +
    '<p class="muted set-blurb">Redirect URI to register in your OAuth app:</p>' +
    '<p class="mono-break" id="sy-redirect"></p>' +
    '</details>' +
    '</div>' +
    '<div id="sy-g-megas3" hidden>' +
    '<label for="sy-endpoint">Endpoint</label>' +
    '<input id="sy-endpoint" autocomplete="off" spellcheck="false" placeholder="https://s3.eu-amsterdam.megas4.com">' +
    '<label for="sy-region">Region</label>' +
    '<input id="sy-region" autocomplete="off" spellcheck="false">' +
    '<label for="sy-bucket">Bucket</label>' +
    '<input id="sy-bucket" autocomplete="off" spellcheck="false">' +
    '<label for="sy-key">Access key</label>' +
    '<input id="sy-key" autocomplete="off" spellcheck="false">' +
    '<label for="sy-skey">Secret key</label>' +
    '<input id="sy-skey" type="password" autocomplete="off">' +
    '<label class="sync-check" for="sy-remember2"><input id="sy-remember2" type="checkbox"> Remember secret key in this browser</label>' +
    '<label for="sy-object">File name</label>' +
    '<input id="sy-object" autocomplete="off" spellcheck="false" placeholder="plutus.inoculens.com">' +
    '<p class="muted set-blurb">The ending .enc.json is fixed — type just the name.</p>' +
    '<label for="sy-folder3">Folder prefix (optional)</label>' +
    '<input id="sy-folder3" autocomplete="off" spellcheck="false" placeholder="e.g. backups/work">' +
    '<p class="muted set-blurb">Keep profiles apart with prefixes — a name already taken is refused, never overwritten. Leave empty for the bucket top level.</p>' +
    '</div>' +
    '<label for="sy-pass">Sync passphrase</label>' +
    '<input id="sy-pass" type="password" autocomplete="new-password" placeholder="Required — only you know it">' +
    '<label class="sync-check" for="sy-remember-pass"><input id="sy-remember-pass" type="checkbox"> Remember passphrase in this browser</label>' +
    '<p class="muted set-blurb" id="sy-fp">Key fingerprint: —</p>' +
    '<label class="sync-check" for="sy-auto"><input id="sy-auto" type="checkbox"> Sync automatically on every change</label>' +
    '<p class="muted set-blurb" id="sy-status">Not connected.</p>' +
    '<div class="sync-btns">' +
    '<button id="sy-connect" type="button">Connect</button>' +
    '<button id="sy-disconnect" type="button">Disconnect</button>' +
    '<button id="sy-push" type="button">Sync now (upload)</button>' +
    '<button id="sy-pull" type="button">Restore from drive</button>' +
    '</div>' +
    '<span id="s-enc-label">Encrypted file — needs your passphrase above</span>' +
    '<button id="sy-enc-download" type="button">Download encrypted file</button>' +
    '<input id="sy-enc-upload" type="file" accept="application/json,.json">' +
    '</section>' +
    '<section data-setpanel="danger" role="tabpanel" aria-label="Danger zone" hidden>' +
    '<button id="s-clear" type="button">Clear all data</button>' +
    '</section>' +
    '</div>';
  host.appendChild(wrap);
  host.addEventListener('click', function (e) {
    var tab = e && e.target && e.target.closest ? e.target.closest('[data-settab]') : null;
    if (!tab) return;
    showSettingsTab(tab.getAttribute('data-settab'));
  });
  document.getElementById('o-add').addEventListener('click', function () {
    var sym = uiVal('o-symbol', '').trim().toUpperCase();
    var price = Number(uiVal('o-price', ''));
    if (!sym) { showBanner('Override needs a symbol (e.g. BTC).'); return; }
    if (!isFinite(price) || price <= 0) { showBanner('Override price must be > 0.'); return; }
    var st = loadState();
    st.priceOverrides = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
    st.priceOverrides[sym] = { price: price, vs: String(st.settings.mainCurrency).toUpperCase() };
    if (!saveStateGuarded(st)) return;
    uiSetVal('o-symbol', '');
    uiSetVal('o-price', '');
    clearBanner();
    refreshPrices(); // override wins over network; recompute + render
  });
  document.getElementById('o-list').addEventListener('click', function (e) {
    var btn = e && e.target && e.target.closest ? e.target.closest('[data-override-del]') : null;
    if (!btn) return;
    var st = loadState();
    if (st.priceOverrides && Object.prototype.hasOwnProperty.call(st.priceOverrides, btn.getAttribute('data-override-del'))) {
      delete st.priceOverrides[btn.getAttribute('data-override-del')];
      if (!saveStateGuarded(st)) return;
    }
    refreshPrices();
  });
  // Fiat tag for legacy bare-number overrides (saved before the entry fiat
  // was recorded): declaring it once converts the override everywhere
  // instead of reading it nominal in the display fiat.
  document.getElementById('o-list').addEventListener('change', function (e) {
    var sel = e && e.target && e.target.closest ? e.target.closest('[data-override-fiat]') : null;
    if (!sel || !sel.value) return;
    var sym = sel.getAttribute('data-override-fiat');
    var vs = String(sel.value).trim().toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(vs)) return;
    var st = loadState();
    if (!st.priceOverrides || typeof st.priceOverrides !== 'object') return;
    var cur = Object.prototype.hasOwnProperty.call(st.priceOverrides, sym)
      ? st.priceOverrides[sym] : null;
    var price = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? Number(cur.price) : Number(cur);
    if (!isFinite(price) || price <= 0) return;
    st.priceOverrides[sym] = { price: price, vs: vs };
    if (!saveStateGuarded(st)) return;
    clearBanner();
    refreshPrices(); // re-resolve + repaint with the declared fiat
  });
  document.getElementById('s-download').addEventListener('click', downloadBackup);
  var csvT = document.getElementById('s-csv-trades');
  if (csvT) csvT.addEventListener('click', downloadTradesCsv);
  var csvL = document.getElementById('s-csv-lots');
  if (csvL) csvL.addEventListener('click', downloadLotsCsv);
  document.getElementById('s-upload').addEventListener('change', function (e) {
    var input = e.target;
    var f = input && input.files && input.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result);
      // Encrypted backups (*.enc.json) are ours but unreadable here: point
      // at Cloud Sync instead of the cryptic 'unknown app' rejection.
      if (syncIsEncryptedBackup(text)) {
        showBanner('This backup is encrypted — restore it from the Cloud Sync tab.', 'error', {
          title: 'Encrypted backup',
          lines: [
            'This file holds an encrypted copy of your data. The normal restore cannot open it.',
            'Next step: open the Cloud Sync tab, type your sync passphrase, then upload the file with "Encrypted file" there.'
          ]
        });
        try { showSettingsTab('sync'); } catch (e2) { /* stay where we are */ }
        input.value = '';
        return;
      }
      try {
        importState(text);
      } catch (err) {
        showBanner('Import failed — your data was left untouched.', 'error', {
          title: 'Import error',
          lines: [String((err && err.message) || err)]
        });
        input.value = '';
        return;
      }
      input.value = '';
      clearBanner();
      refreshPrices();
      closeDialog('settings-dialog');
    };
    reader.onerror = function () {
      showBanner('Import failed — could not read the file.', 'error', {
        title: 'Import error',
        lines: ['The file could not be read. Pick a Plutus backup (.json) and retry.']
      });
      input.value = '';
    };
    reader.readAsText(f);
  });
  document.getElementById('s-clear').addEventListener('click', clearAllData);
  buildSyncSettings();
}

function syncTopbar(st) {
  var main = document.getElementById('tb-main');
  if (main) main.value = st.settings.mainCurrency;
  var avg = document.getElementById('tb-avg');
  var fifo = document.getElementById('tb-fifo');
  var isFifo = st.settings.costMethod === 'fifo';
  if (avg) avg.setAttribute('aria-pressed', isFifo ? 'false' : 'true');
  if (fifo) fifo.setAttribute('aria-pressed', isFifo ? 'true' : 'false');
  var list = document.getElementById('o-list');
  if (list) {
    list.innerHTML = '';
    var ov = (st.priceOverrides && typeof st.priceOverrides === 'object') ? st.priceOverrides : {};
    Object.keys(ov).sort().forEach(function (sym) {
      var li = document.createElement('li');
      var label = document.createElement('span');
      var oe = null;
      try { oe = priceOverrideEntry(sym); } catch (e) { oe = null; }
      var op = (oe && isFinite(Number(oe.price))) ? Number(oe.price) : Number(ov[sym]);
      var oc = (oe && oe.vs) ? oe.vs : st.settings.mainCurrency;
      label.textContent = sym + ' — ' + fmtMoney(op, oc) + ' ';
      li.appendChild(label);
      // Untagged legacy entries get a one-time fiat declaration so they
      // convert instead of reading nominal; tagged ones show their fiat.
      var fiatSel = document.createElement('select');
      fiatSel.setAttribute('data-override-fiat', sym);
      fiatSel.setAttribute('aria-label', 'Fiat for ' + sym + ' override');
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = (oe && oe.vs) ? oe.vs : 'fiat…';
      fiatSel.appendChild(ph);
      MAIN_CURRENCIES.forEach(function (code) {
        if (oe && oe.vs === code) return; // already shown as the current label
        var o = document.createElement('option');
        o.value = code;
        o.textContent = code;
        fiatSel.appendChild(o);
      });
      li.appendChild(fiatSel);
      li.appendChild(document.createTextNode(' '));
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'Remove';
      rm.setAttribute('data-override-del', sym);
      rm.setAttribute('aria-label', 'Remove override for ' + sym);
      li.appendChild(rm);
      list.appendChild(li);
    });
  }
  try { syncRefreshHeaderIcon(st); } catch (e) { /* never let sync break render */ }
}

function backupStamp() {
  var n = new Date();
  function p(x) { return (x < 10 ? '0' : '') + x; }
  return n.getFullYear() + p(n.getMonth() + 1) + p(n.getDate());
}

function downloadBackup() {
  var json = exportState(loadState());
  var blob = new Blob([json], { type: 'application/json' });
  var name = 'plutus.inoculens.com-' + backupStamp() + '.json';
  var urls = window.URL || window.webkitURL;
  var url = urls.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    try { urls.revokeObjectURL(url); } catch (e) { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1000);
}

function csvEsc(v) {
  var s = String(v === null || v === undefined ? '' : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Free-text cells (notes, account names, labels): a leading = + - @ would
// run as a spreadsheet formula on open (payloads can arrive via an imported
// backup). The single-quote prefix renders invisibly in Excel/Sheets and
// keeps numeric columns untouched.
function csvSafeText(v) {
  var s = String(v === null || v === undefined ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return csvEsc(s);
}

function downloadTextFile(name, text, mime) {
  var blob = new Blob([text], { type: mime || 'text/csv' });
  var urls = window.URL || window.webkitURL;
  var url = urls.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    try { urls.revokeObjectURL(url); } catch (e) { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 1000);
}

function downloadTradesCsv() {
  var st = loadState();
  var accName = {};
  (st.accounts || []).forEach(function (a) { accName[a.id] = a.name; });
  var rows = [['id', 'date', 'type', 'symbol', 'qty', 'total', 'currency', 'fee', 'feeCurrency', 'networkFee', 'account', 'toAccount', 'note', 'txid', 'fxRate', 'fxSource']];
  ledgerSortByDate(st.trades || []).forEach(function (t) {
    rows.push([
      t.id || '', t.date || '', t.type || '', String(t.symbol || '').toUpperCase(),
      t.qty !== undefined && t.qty !== null ? t.qty : '',
      t.total !== undefined && t.total !== null ? t.total : '',
      t.currency || '', t.fee !== undefined && t.fee !== null ? t.fee : '',
      t.feeCurrency || '', t.networkFee !== undefined && t.networkFee !== null ? t.networkFee : '',
      { text: accName[t.accountId] || t.accountId || '' },
      { text: (t.toAccountId ? (accName[t.toAccountId] || t.toAccountId) : '') },
      { text: t.note || '' },
      { text: t.txid || '' },
      (t.fxLock && t.fxLock.rate) || '',
      (t.fxLock && t.fxLock.source) || ''
    ]);
  });
  downloadTextFile('plutus.inoculens.com-trades-' + backupStamp() + '.csv', rows.map(function (r) {
    return r.map(function (c) {
      // Free-text cells are wrapped ({text}) so formula triggers get
      // neutralized; numeric and validated-code cells stay spreadsheet-clean.
      return (c && typeof c === 'object') ? csvSafeText(c.text) : csvEsc(c);
    }).join(',');
  }).join('\n'), 'text/csv');
}

function downloadLotsCsv() {
  var st = loadState();
  var main = st.settings.mainCurrency;
  var dtrades = convertTrades(st.trades, main);
  var fifo = computeFifo(dtrades);
  var accName = {};
  (st.accounts || []).forEach(function (a) { accName[a.id] = a.name; });
  var rows = [['symbol', 'openDate', 'closeDate', 'qty', 'proceeds_' + main, 'cost_' + main, 'gain_' + main, 'holdingDays', 'accountId']];
  // Lots are per-symbol globally; attribute account where possible via close trade? FIFO lots don't carry account, but joint lots do.
  // Use joint portfolio lots (with accountId) for accuracy.
  try {
    var pf = computePortfolio(dtrades, {}, 'fifo');
    Object.keys(pf.states || {}).forEach(function (accId) {
      var syms = pf.states[accId];
      Object.keys(syms).forEach(function (sym) {
        (syms[sym].lots || []).forEach(function (l) {
          rows.push([sym, l.openDate || '', l.closeDate || '', l.qty, Math.round(l.proceeds * 100) / 100, Math.round(l.cost * 100) / 100, Math.round(l.gain * 100) / 100, l.holdingDays, { text: accName[accId] || accId }]);
        });
      });
    });
  } catch (e) {
    fifo.forEach(function (v, sym) {
      (v.lots || []).forEach(function (l) {
        rows.push([sym, l.openDate || '', l.closeDate || '', l.qty, Math.round(l.proceeds * 100) / 100, Math.round(l.cost * 100) / 100, Math.round(l.gain * 100) / 100, l.holdingDays, '']);
      });
    });
  }
  downloadTextFile('plutus.inoculens.com-tax-lots-' + backupStamp() + '.csv', rows.map(function (r) {
    return r.map(function (c) { return (c && typeof c === 'object') ? csvSafeText(c.text) : csvEsc(c); }).join(',');
  }).join('\n'), 'text/csv');
}

// --- Hero allocation (compact ring inside the Total balance panel; home stays one calm panel) ---

function allocationData(st, dtrades, visibleIds) {
  var method = st.settings.costMethod;
  var pf = null;
  try { pf = computePortfolio(dtrades, livePrices, method); } catch (e) { pf = null; }
  var bySym = {};
  if (pf && pf.byAccount) {
    Object.keys(pf.byAccount).forEach(function (accId) {
      if (visibleIds && visibleIds.indexOf(accId) === -1) return; // honor the asset filter
      pf.byAccount[accId].forEach(function (p, sym) {
        var key = p.symbol;
        if (p.marketValue === null) {
          // unknown price: count cost as fallback so allocation still shows something?
          return;
        }
        bySym[key] = (bySym[key] || 0) + p.marketValue;
      });
    });
  }
  var total = 0;
  Object.keys(bySym).forEach(function (k) { total += bySym[k]; });
  var arr = Object.keys(bySym).map(function (k) { return { symbol: k, value: bySym[k], pct: total > 0 ? (bySym[k] / total) * 100 : 0 }; });
  arr.sort(function (a, b) { return b.value - a.value; });
  return { items: arr, total: total };
}

function renderHeroAlloc(st) {
  var host = document.getElementById('hero-alloc');
  if (!host) return;
  var main = st.settings.mainCurrency;
  if (!st.accounts.length || !(st.trades || []).length) { host.hidden = true; host.innerHTML = ''; return; }
  var dtrades = convertTrades(st.trades, main);
  var vf = selectedTickers(st);
  var vIds = vf === null ? null : (st.accounts || [])
    .filter(function (a) { return vf.indexOf(String(a.ticker).toUpperCase()) !== -1; })
    .map(function (a) { return a.id; });
  var al = allocationData(st, dtrades, vIds);
  if (!al.items.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = '';
  // Text first, ring last: legend sits left, circle pins to the very right.
  var palette = ['#e3c57c', '#7dd3fc', '#34d399', '#f472b6', '#a78bfa', '#fbbf24'];
  var leg = document.createElement('ul');
  leg.className = 'hero-alloc-legend';
  al.items.forEach(function (it, i) {
    var li = document.createElement('li');
    var dot = document.createElement('span');
    dot.className = 'hero-alloc-dot';
    dot.style.background = palette[i % palette.length];
    li.appendChild(dot);
    var tx = document.createElement('span');
    tx.textContent = it.symbol + ' · ' + fmtPct(it.pct) + ' · ' + fmtMoney(it.value, main);
    li.appendChild(tx);
    leg.appendChild(li);
  });
  host.appendChild(leg);
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('class', 'donut-sm');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Allocation by asset');
  var cx = 60, cy = 60, r = 46, circ = 2 * Math.PI * r;
  var off = 0;
  al.items.forEach(function (it, i) {
    var frac = it.pct / 100;
    var c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', palette[i % palette.length]);
    c.setAttribute('stroke-width', '14');
    c.setAttribute('stroke-dasharray', (frac * circ) + ' ' + circ);
    c.setAttribute('stroke-dashoffset', String(-off * circ));
    c.setAttribute('stroke-linecap', 'butt');
    c.setAttribute('transform', 'rotate(-90 60 60)');
    svg.appendChild(c);
    off += frac;
  });
  // Total distinct visible assets in the hole (same count as the header).
  var holeTickers = accountTickers(vIds === null
    ? (st.accounts || [])
    : (st.accounts || []).filter(function (a) { return vIds.indexOf(a.id) !== -1; }));
  var nAssets = holeTickers.length;
  svg.setAttribute('aria-label', 'Allocation: ' + nAssets + (nAssets === 1 ? ' asset' : ' assets'));
  var num = document.createElementNS(svgNS, 'text');
  num.setAttribute('x', cx);
  num.setAttribute('y', '60');
  num.setAttribute('text-anchor', 'middle');
  num.setAttribute('class', 'donut-num');
  num.textContent = String(nAssets);
  svg.appendChild(num);
  var lab = document.createElementNS(svgNS, 'text');
  lab.setAttribute('x', cx);
  lab.setAttribute('y', '79');
  lab.setAttribute('text-anchor', 'middle');
  lab.setAttribute('class', 'donut-lab');
  lab.textContent = nAssets === 1 ? 'ASSET' : 'ASSETS';
  svg.appendChild(lab);
  host.appendChild(svg);
  syncHeroAllocHeight();
}

// The legend never stretches its box: capped at six rows (the 7th asset
// scrolls) and never taller than the left amount block, so the hero cannot
// expand no matter how many assets exist. Re-synced on render + viewport
// and font changes because the amount scales with the viewport.
function syncHeroAllocHeight() {
  try {
    var host = document.getElementById('hero-alloc');
    if (!host || host.hidden) return;
    var hero = document.getElementById('hero');
    var main = hero ? hero.querySelector('.hero-main') : null;
    var leg = host.querySelector('.hero-alloc-legend');
    if (!main || !leg) return;
    var h = main.clientHeight;
    if (!(h > 0)) return;
    var cap = h;
    try {
      var root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var sixRows = 6 * (0.85 * 1.55 * root) + 5 * (0.35 * root);
      if (sixRows > 0 && sixRows < cap) cap = sixRows;
    } catch (e2) { /* fall back to the measured block height */ }
    leg.style.maxHeight = cap + 'px';
    // Pin the ring to exact pixels as well: percentage heights resolve
    // against sibling-influenced layout and drift per content — pixels
    // cannot. Cleared on narrow screens where the stylesheet size applies.
    try {
      var wide = true;
      try {
        if (typeof window !== 'undefined' && window.matchMedia) {
          wide = window.matchMedia('(min-width: 721px)').matches;
        }
      } catch (e3) {}
      var ring = host.querySelector('.donut-sm');
      if (ring && ring.style) {
        if (wide && h > 0) {
          ring.style.width = h + 'px';
          ring.style.height = h + 'px';
        } else {
          ring.style.width = '';
          ring.style.height = '';
        }
      }
    } catch (e4) { /* ring keeps its stylesheet size */ }
  } catch (e) { /* ignore */ }
}

function clearAllData() {
  confirmAction('Clear everything', 'Delete all accounts, trades, overrides and settings? This cannot be undone.', 'Delete everything', true).then(function (ok) {
    if (!ok) return;
    livePrices = {};
    if (!saveStateGuarded(defaultState())) return;
    clearBanner();
    render();
  });
}

// --- Render loop ---

// Generation guard: rapid fiat switches (or a slow first paint racing init's
// fetch) can leave two refreshes in flight; without a guard the STALE one may
// resolve last and paint live values in the wrong fiat (e.g. EUR numbers
// labeled RON against a correctly converted cost → a phantom ~200 RON loss
// on a 50 EUR trade). Only the latest request for the CURRENT main may write
// livePrices, banner, or repaint — anything older is quietly discarded.
var priceReqGen = 0;

function refreshPrices() {
  var st = loadState();
  var mainNow = st.settings.mainCurrency;
  var syms = uniqueSymbols(st.trades);
  var kinds = {};
  (st.accounts || []).forEach(function (a) {
    if (a && a.ticker) {
      var t = String(a.ticker).toUpperCase();
      if (syms.indexOf(t) === -1) syms.push(t); // unique: trades may already list it
      if (a.kind) kinds[t] = a.kind;
    }
  });
  // Trade symbols inherit their account's kind (stock accounts fetch via Stooq).
  (st.trades || []).forEach(function (tr) {
    if (!tr || !tr.symbol || !tr.accountId) return;
    var s = String(tr.symbol).toUpperCase();
    if (kinds[s]) return;
    var a = accountById(st, tr.accountId);
    if (a && a.kind) kinds[s] = a.kind;
  });
  if (!syms.length) {
    render();
    return Promise.resolve({});
  }
  var gen = ++priceReqGen;
  function isCurrent() {
    if (gen !== priceReqGen) return false; // superseded by a newer refresh
    try { return loadState().settings.mainCurrency === mainNow; }
    catch (e) { return false; }
  }
  return refreshAllPrices(syms, mainNow, kinds).then(function (out) {
    if (!isCurrent()) return out; // stale: newer refresh owns livePrices + paint
    Object.keys(out).forEach(function (k) {
      var v = out[k];
      if (isFinite(Number(v)) && Number(v) > 0) livePrices[k] = Number(v);
    });
    var missing = syms.filter(function (s) { return !(isFinite(Number(livePrices[s])) && Number(livePrices[s]) > 0); });
    if (!missing.length) {
      clearPriceBanner();
      render();
      return out;
    }
    // One gentle retry for transient failures (e.g. CoinGecko 429) before
    // telling the user anything — most hiccups heal within seconds.
    return new Promise(function (res) { setTimeout(res, 2500); }).then(function () {
      if (!isCurrent()) return out; // main moved on during the wait: stay quiet
      return refreshAllPrices(missing, mainNow, kinds);
    }).then(function (out2) {
      if (!isCurrent()) return out; // stale retry: discard, no paint, no banner
      Object.keys(out2).forEach(function (k) {
        var v = out2[k];
        if (isFinite(Number(v)) && Number(v) > 0) livePrices[k] = Number(v);
      });
      var stillMissing = syms.filter(function (s) { return !(isFinite(Number(livePrices[s])) && Number(livePrices[s]) > 0); });
      if (stillMissing.length) {
        var detailLines = stillMissing.map(function (s) {
          return s + ' — ' + (lastPriceErrors[s] || 'price unavailable');
        });
        showBanner('Live prices are unreachable right now — your data is safe and numbers will fill in automatically.', 'info', {
          title: 'Price errors',
          lines: detailLines
        });
      } else {
        clearPriceBanner();
      }
      render();
      return out;
    });
  });
}

function render() {
  var st;
  try {
    st = loadState();
  } catch (e) {
    st = defaultState();
  }
  if (!st || !st.settings) st = defaultState();
  renderAccounts(st);
  try { renderHeroAlloc(st); } catch (e) { /* best-effort */ }
  syncTopbar(st);
  var ver = document.getElementById('app-ver');
  if (ver) ver.textContent = APP_VERSION;
  route(); // show home or the routed account page
  refreshDisplayRates(st); // fill missing historical pairs, then repaint once
  try { syncInfoDots(); } catch (e) { /* hide decorative ⓘ where nothing overflows */ }
}

// Fire-and-forget: fetch historical FX pairs AND historical execution prices
// the current paint still lacks, then repaint a single time. Never rejects;
// offline keeps the current paint (Exec rows show "—" until history lands).
function refreshDisplayRates(st) {
  if (!st || !st.settings) return;
  var main = st.settings.mainCurrency;
  var trades = st.trades;
  var kinds = {};
  try {
    (st.accounts || []).forEach(function (a) {
      if (a && a.ticker) kinds[String(a.ticker).toUpperCase()] = a.kind;
    });
    (trades || []).forEach(function (tr) {
      if (!tr || !tr.symbol || !tr.accountId) return;
      var s = String(tr.symbol).toUpperCase();
      if (kinds[s]) return;
      var a = accountById(st, tr.accountId);
      if (a && a.kind) kinds[s] = a.kind;
    });
  } catch (e) { kinds = {}; }
  try {
    Promise.all([
      ensureDisplayRates(trades, main).catch(function () { return false; }),
      ensureHistoricalExec(trades, main, kinds).catch(function () { return false; })
    ]).then(function (flags) {
      if (!flags[0] && !flags[1]) return;
      var s2;
      try {
        s2 = loadState();
      } catch (e) { return; }
      if (!s2 || !s2.settings) return;
      renderAccounts(s2);
      try { renderHeroAlloc(s2); } catch (e) { /* ignore */ }
      syncTopbar(s2);
      route();
      try { syncInfoDots(); } catch (e) { /* ignore */ }
    }, function () { /* offline: keep current paint */ });
  } catch (e) { /* ignore */ }
}

var hashWired = false;
var heroResizeWired = false;

function init() {
  if (uiBooted) {
    render();
    return;
  }
  try { repairBakedExecLocksOnce(); } catch (e) { /* repair never breaks boot */ }
  if (!document.getElementById('accounts')) return;
  buildTopbar();
  buildAccounts();
  buildTradeForm();
  buildSettings();
  buildAccountDialog();
  wireMenuOutside();
  if (!hashWired && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    hashWired = true;
    window.addEventListener('hashchange', route); // hash mode (file://, legacy links)
    window.addEventListener('popstate', route); // history mode (clean URLs)
  }
  if (!heroResizeWired && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    heroResizeWired = true;
    var heroRt = null;
    window.addEventListener('resize', function () {
      if (heroRt) { try { clearTimeout(heroRt); } catch (e) { /* ignore */ } }
      heroRt = setTimeout(function () { fitHeroValue(); syncHeroAllocHeight(); try { syncInfoDots(); } catch (e) { /* ignore */ } }, 150);
    });
    try {
      if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
        document.fonts.ready.then(function () { syncHeroAllocHeight(); });
      }
    } catch (e) { /* ignore */ }
  }
  var back = document.getElementById('acct-back');
  if (back && !back.getAttribute('data-wired')) {
    back.setAttribute('data-wired', '1');
    back.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      navHome();
    });
  }
  var d = document.getElementById('t-date');
  if (d && !d.value) d.value = todayStr();
  uiBooted = true;
  render();
  refreshPrices();
}


// Runs the baked-quote repair once per page load (see dropBakedExecLocks).
// Later init() calls (tests re-render constantly) must not re-save.
var execRepairDone = false;
function repairBakedExecLocksOnce() {
  if (execRepairDone) return false;
  execRepairDone = true;
  var st = null;
  try { st = loadState(); } catch (e) { return false; }
  var changed = false;
  try { changed = dropBakedExecLocks(st.trades, st.priceOverrides); } catch (e) { changed = false; }
  if (!changed) return false;
  try { saveStateGuarded(st); } catch (e) { return false; }
  return true;
}

// Expose Ui on window.Inoculens for tests.html; init/render are also bare
// globals (classic script top-level functions) for the DOM checklist.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.init = init;
  window.Inoculens.render = render;
  window.Inoculens.refreshPrices = refreshPrices;
  window.Inoculens.getLivePrices = function () { return livePrices; };
  window.Inoculens.fxBadgeText = fxBadgeText;
  window.Inoculens.TRADE_CCY_OPTIONS = TRADE_CCY_OPTIONS;
  window.Inoculens.saveStateGuarded = saveStateGuarded;
  window.Inoculens.isValidImportTrade = isValidImportTrade;
  window.Inoculens.isValidTxid = isValidTxid;
  window.Inoculens.txExplorerUrl = txExplorerUrl;
  window.Inoculens.shortTxid = shortTxid;
  window.Inoculens.renderAccounts = renderAccounts;
  window.Inoculens.openAccountDialog = openAccountDialog;
  window.Inoculens.createAccount = createAccount;
  window.Inoculens.renameAccount = renameAccount;
  window.Inoculens.deleteAccount = deleteAccount;
  window.Inoculens.accountTrades = accountTrades;
  window.Inoculens.heldQtyFor = heldQtyFor;
  window.Inoculens.openPrefillTrade = openPrefillTrade;
  window.Inoculens.openEditTrade = openEditTrade;
  window.Inoculens.startInlineLabelEdit = startInlineLabelEdit;
  window.Inoculens.openNoteDialog = openNoteDialog;
  window.Inoculens.openErrorDialog = openErrorDialog;
  window.Inoculens.applyColorToSelection = applyColorToSelection;
  window.Inoculens.resetTradeForm = resetTradeForm;
  window.Inoculens.syncTradeButtons = syncTradeButtons;
  window.Inoculens.syncLockedSymbol = syncLockedSymbol;
  window.Inoculens.syncTradeTypeUI = syncTradeTypeUI;
  window.Inoculens.syncInfoDots = syncInfoDots;
  window.Inoculens.transferFeeFrom = transferFeeFrom;
  window.Inoculens.syncTransferFeePreview = syncTransferFeePreview;
  window.Inoculens.route = route;
  window.Inoculens.renderAccountDetail = renderAccountDetail;
  window.Inoculens.accountDetailId = accountDetailId;
  window.Inoculens.currentRouteId = currentRouteId;
  window.Inoculens.navTo = navTo;
  window.Inoculens.navHome = navHome;
  window.Inoculens.renderHeroAlloc = renderHeroAlloc;
  window.Inoculens.syncHeroAllocHeight = syncHeroAllocHeight;
  window.Inoculens.fitHeroValue = fitHeroValue;
  window.Inoculens.downloadTradesCsv = downloadTradesCsv;
  window.Inoculens.downloadLotsCsv = downloadLotsCsv;
  window.Inoculens.csvSafeText = csvSafeText;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', init);
  }
  // Surface unexpected errors visibly so users can report them with the version above.
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('error', function (e) {
      try {
        showBanner('App error — please report this text plus your app version (bottom of page).', 'error', {
          title: 'App error',
          lines: [String((e && e.message) || 'unknown error'), 'Version ' + APP_VERSION]
        });
      } catch (err) { /* ignore */ }
    });
  }
}

// === Sync ===
// E2E encrypted sync to a drive of the user's choice. There is no Plutus
// server: the plaintext is always the exact exportState() JSON, it is
// encrypted in this browser with WebCrypto (PBKDF2-SHA256 -> AES-GCM-256),
// and only the ciphertext envelope below ever leaves the device:
//
//   {"app":"plutus.inoculens.com","v":1,"iter":N,"salt":b64,"iv":b64,
//    "ciphertext":b64}
//
// The passphrase lives only in the form (and, only if the user ticks
// Remember, in this browser's local storage — never on any server). To sync
// from another computer the user only needs the drive login plus the
// passphrase. A wrong passphrase fails closed (AES-GCM auth) and local data
// is never touched until a downloaded backup fully validates via importState().
// Providers: WebDAV/Nextcloud (Basic), Google Drive / Dropbox
// (OAuth one-click or PKCE with the user's own app), MEGA S4 (S3-compatible
// SigV4 with the user's own access keys).

var SYNC_APP = 'plutus.inoculens.com';
// Files written by the first release carry the old id; still accepted on
// read so early backups keep working. New files always use SYNC_APP.
var SYNC_APP_LEGACY = 'inoculens-plutus-sync';
var SYNC_VERSION = 1;
var SYNC_STORAGE_KEY = 'inoculens.sync.v1';
var SYNC_OAUTH_KEY = 'inoculens.oauth.v1';
var SYNC_DEFAULT_BASENAME = 'plutus.inoculens.com';
var SYNC_DEFAULT_FILENAME = 'plutus.inoculens.com.enc.json';
// Trust stamp for "this device synced this destination before". Bumped
// whenever the gate rules change so markers written by older app versions
// never count — the next push re-verifies instead of blindly overwriting.
var SYNC_LOC_V = 2;
var SYNC_PBKDF2_ITER = 600000;
var SYNC_PROVIDERS = [
  { id: 'webdav', label: 'WebDAV / Nextcloud', kind: 'basic' },
  { id: 'gdrive', label: 'Google Drive', kind: 'oauth' },
  { id: 'dropbox', label: 'Dropbox', kind: 'oauth' },
  { id: 'megas3', label: 'MEGA (S4 object storage)', kind: 's3' }
];
var SYNC_HINTS = {
  webdav: 'Nextcloud or any WebDAV host. Create a folder (e.g. Plutus), paste its URL, and sign in with an app password. Only ciphertext is uploaded.',
  gdrive: 'One-click Google sign-in when enabled below — otherwise expand the advanced box and use your own OAuth app (Web application, Drive API enabled). The app only sees files it created.',
  dropbox: 'One-click Dropbox sign-in when enabled below — otherwise your own Dropbox app (Scoped access, App folder) plus its app key in the advanced box. Files stay in the private app folder.',
  megas3: 'MEGA S4 object storage (needs a MEGA account with S4). Create a bucket and access keys under Object Storage, then fill endpoint, region, bucket and keys. Only ciphertext is stored.'
};

// Built-in OAuth app IDs for one-click sign-in (public by design, exactly
// like rclone/Joplin ship theirs — the ID only names the app to the
// provider; tokens and ciphertext still flow directly browser<->provider
// with no Plutus server anywhere). Empty until the app owner registers
// them; while empty, users fall back to their own OAuth app below.
var SYNC_SHARED_APPS = { gdrive: '593485863383-tcl6m894iqoqa2cqan3ui80ihau93fq9.apps.googleusercontent.com', dropbox: 'rractvt806na5rn' };

function syncSharedId(providerId) {
  var v = SYNC_SHARED_APPS[providerId];
  return (typeof v === 'string' && v.trim() !== '') ? v.trim() : '';
}

// Effective client ID: the built-in one-click app wins when configured,
// otherwise the user's own app from the advanced box.
function syncEffectiveClientId(cfg) {
  var shared = syncSharedId(cfg.provider);
  if (shared) return shared;
  return (typeof cfg.clientId === 'string') ? cfg.clientId : '';
}

var syncBusy = false;
var syncMemSecrets = { password: '', secretKey: '' };

// --- Small pure codecs (no atob/TextEncoder dependency) ---

var SYNC_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function syncB64encode(bytes) {
  var s = '';
  var i, a, b, c;
  for (i = 0; i < bytes.length; i += 3) {
    a = bytes[i] & 255;
    b = (i + 1 < bytes.length) ? (bytes[i + 1] & 255) : 0;
    c = (i + 2 < bytes.length) ? (bytes[i + 2] & 255) : 0;
    s += SYNC_B64.charAt(a >> 2);
    s += SYNC_B64.charAt(((a & 3) << 4) | (b >> 4));
    s += (i + 1 < bytes.length) ? SYNC_B64.charAt(((b & 15) << 2) | (c >> 6)) : '=';
    s += (i + 2 < bytes.length) ? SYNC_B64.charAt(c & 63) : '=';
  }
  return s;
}

function syncB64decode(str) {
  var clean = String(str).replace(/\s+/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0) throw new Error('sync failed: bad base64 length.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('sync failed: bad base64 data.');
  var padAt = clean.indexOf('=');
  if (padAt !== -1 && padAt < clean.length - 2) throw new Error('sync failed: bad base64 padding.');
  var out = [];
  var i, e1, e2, e3, e4, triple;
  var c3, c4;
  for (i = 0; i < clean.length; i += 4) {
    e1 = SYNC_B64.indexOf(clean.charAt(i));
    e2 = SYNC_B64.indexOf(clean.charAt(i + 1));
    c3 = clean.charAt(i + 2);
    c4 = clean.charAt(i + 3);
    e3 = (c3 === '=') ? -1 : SYNC_B64.indexOf(c3);
    e4 = (c4 === '=') ? -1 : SYNC_B64.indexOf(c4);
    if (e1 < 0 || e2 < 0 || (c3 !== '=' && e3 < 0) || (c4 !== '=' && e4 < 0)) {
      throw new Error('sync failed: bad base64 data.');
    }
    triple = (e1 << 18) | (e2 << 12) | ((e3 < 0 ? 0 : e3) << 6) | (e4 < 0 ? 0 : e4);
    out.push((triple >> 16) & 255);
    if (e3 >= 0) out.push((triple >> 8) & 255);
    if (e4 >= 0) out.push(triple & 255);
  }
  return new Uint8Array(out);
}

function syncB64UrlEncode(bytes) {
  return syncB64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function syncHex(bytes) {
  var s = '';
  var i;
  for (i = 0; i < bytes.length; i++) {
    s += (bytes[i] < 16 ? '0' : '') + (bytes[i] & 255).toString(16);
  }
  return s;
}

function syncUtf8Encode(str) {
  var s = String(str);
  var out = [];
  var i, c, lo, cp;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      lo = s.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        cp = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
        continue;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

function syncUtf8Decode(bytes) {
  var s = '';
  var i = 0;
  var b1, b2, b3, b4, cp;
  while (i < bytes.length) {
    b1 = bytes[i++] & 255;
    if (b1 < 0x80) {
      s += String.fromCharCode(b1);
    } else if ((b1 & 0xE0) === 0xC0) {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      s += String.fromCharCode(((b1 & 31) << 6) | (b2 & 63));
    } else if ((b1 & 0xF0) === 0xE0) {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b3 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      s += String.fromCharCode(((b1 & 15) << 12) | ((b2 & 63) << 6) | (b3 & 63));
    } else {
      b2 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b3 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      b4 = (i < bytes.length) ? (bytes[i++] & 255) : 0;
      cp = (((b1 & 7) << 18) | ((b2 & 63) << 12) | ((b3 & 63) << 6) | (b4 & 63)) - 0x10000;
      s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
    }
  }
  return s;
}

// --- Envelope + pure helpers (covered by tests.html) ---

function syncEnvelopeWrap(ctB64, saltB64, ivB64, iter) {
  return JSON.stringify({ app: SYNC_APP, v: SYNC_VERSION, iter: iter, salt: saltB64, iv: ivB64, ciphertext: ctB64 });
}

function syncEnvelopeParse(text) {
  var data;
  try {
    data = JSON.parse(String(text));
  } catch (e) {
    throw new Error('sync failed: file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('sync failed: bad envelope.');
  if (data.app !== SYNC_APP && data.app !== SYNC_APP_LEGACY) throw new Error('sync failed: not a Plutus sync file.');
  if (data.v !== SYNC_VERSION) throw new Error('sync failed: unsupported sync version.');
  var iter = Number(data.iter);
  if (!isFinite(iter) || Math.floor(iter) !== iter || iter < 1000 || iter > 5000000) {
    throw new Error('sync failed: bad envelope parameters.');
  }
  if (typeof data.salt !== 'string' || typeof data.iv !== 'string' || typeof data.ciphertext !== 'string') {
    throw new Error('sync failed: bad envelope parameters.');
  }
  var salt, iv, ct;
  try {
    salt = syncB64decode(data.salt);
    iv = syncB64decode(data.iv);
    ct = syncB64decode(data.ciphertext);
  } catch (e) {
    throw new Error('sync failed: bad envelope encoding.');
  }
  if (salt.length !== 16) throw new Error('sync failed: bad envelope salt.');
  if (iv.length !== 12) throw new Error('sync failed: bad envelope nonce.');
  if (ct.length < 16) throw new Error('sync failed: ciphertext too short.');
  return { iter: iter, salt: salt, iv: iv, ciphertext: ct };
}

// True when the text is one of our encrypted envelopes (a sync file or an
// encrypted download) rather than a plain backup. Pure and safe to probe
// with before importState(), whose 'unknown app' error would only confuse.
function syncIsEncryptedBackup(text) {
  try {
    syncEnvelopeParse(String(text));
    return true;
  } catch (e) {
    return false;
  }
}

// 'local-newer' | 'remote-newer' | 'equal' | 'unknown' (unparseable dates).
function syncCompareTimestamps(localIso, remoteIso) {
  var aOk = (typeof localIso === 'string') && isFinite(Date.parse(localIso));
  var bOk = (typeof remoteIso === 'string') && isFinite(Date.parse(remoteIso));
  if (!aOk || !bOk) return 'unknown';
  var ta = Date.parse(localIso);
  var tb = Date.parse(remoteIso);
  if (ta > tb) return 'local-newer';
  if (tb > ta) return 'remote-newer';
  return 'equal';
}

function syncIsProvider(id) {
  var i;
  for (i = 0; i < SYNC_PROVIDERS.length; i++) {
    if (SYNC_PROVIDERS[i].id === id) return true;
  }
  return false;
}

function syncProviderById(id) {
  var i;
  for (i = 0; i < SYNC_PROVIDERS.length; i++) {
    if (SYNC_PROVIDERS[i].id === id) return SYNC_PROVIDERS[i];
  }
  return null;
}

function syncProviderLabel(id) {
  var p = syncProviderById(id);
  return p ? p.label : String(id);
}

function syncJoinUrl(base, name) {
  var b = String(base || '').replace(/\s+$/g, '').replace(/\/+$/, '');
  return b + '/' + encodeURIComponent(String(name));
}

function syncSanitizeFilename(name) {
  // User-editable basename, fixed extension: strip any pasted extension,
  // unsafe characters and dot-segments, then lock '.enc.json' back on.
  // Idempotent: already-correct names pass through unchanged. Non-Latin1
  // characters become '_' so the name stays valid in HTTP headers too
  // (Dropbox carries the path in Dropbox-API-Arg, which must be Latin1).
  var s = String(name == null ? '' : name).trim();
  s = s.replace(/^[/\\.\s]+/, '');
  s = s.replace(/(\.enc\.json|\.json|\.enc)$/i, '');
  s = s.replace(/[/\\'"]/g, '');
  s = s.replace(/[^\x20-\xFF]/g, '_');
  s = s.replace(/[. ]+$/, '').slice(0, 100);
  if (!s) s = SYNC_DEFAULT_BASENAME;
  return s + '.enc.json';
}

function syncDisplayBasename(name) {
  return String(name == null ? '' : name).replace(/\.enc\.json$/i, '');
}

// Folder path inside the drive (Drive folder tree, Dropbox subfolder, S3
// key prefix). '' = drive root. Normalizes slashes, drops '.' and '..'
// segments so paths can never escape upward.
function syncNormalizeFolder(raw) {
  var f = String(raw == null ? '' : raw).replace(/\\/g, '/').trim();
  f = f.replace(/^\/+|\/+$/g, '');
  var parts = f.split('/');
  var out = [];
  var i;
  for (i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^\.+$/, '');
    if (p === '' || p === '.' || p === '..') continue;
    out.push(p.slice(0, 128));
  }
  return out.join('/').slice(0, 256);
}

// Full identity of a save destination: the duplicate gate refuses to
// overwrite a file at a destination this device has never synced.
function syncLocationKey(cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  if (cfg.provider === 'webdav') return 'webdav|' + syncJoinUrl(cfg.url, cfg.filename);
  if (cfg.provider === 'megas3') return 'megas3|' + syncS3Url(cfg);
  return cfg.provider + '|' + folder + '/' + cfg.filename;
}

// Whose credentials the destination belongs to: switching app identity
// (another OAuth app, another username/key) must re-verify, because e.g.
// Drive's app-scoped files are invisible across different client IDs.
function syncTrustIdentity(cfg) {
  if (cfg.provider === 'gdrive' || cfg.provider === 'dropbox') {
    return 'oauth:' + syncEffectiveClientId(cfg);
  }
  if (cfg.provider === 'webdav') return 'basic:' + String(cfg.username || '');
  if (cfg.provider === 'megas3') return 's3:' + String(cfg.accessKey || '');
  return '';
}

function syncIsTrustedLocation(cfg, locKey) {
  if (!cfg.lastLocation || cfg.lastLocation !== locKey) return false;
  if (cfg.locV !== SYNC_LOC_V) return false;
  var ident = syncTrustIdentity(cfg);
  if (!ident) return false;
  return (cfg.lastIdentity || '') === ident;
}

function syncDefaultConfig() {
  return {
    provider: 'webdav',
    filename: SYNC_DEFAULT_FILENAME,
    url: '',
    username: '',
    password: '',
    rememberPassword: false,
    passphrase: '',
    rememberPassphrase: false,
    clientId: '',
    clientSecret: '',
    tokens: null,
    endpoint: 'https://s3.eu-amsterdam.megas4.com',
    region: 'eu-amsterdam',
    bucket: '',
    accessKey: '',
    secretKey: '',
    rememberSecret: false,
    objectKey: SYNC_DEFAULT_FILENAME,
    folder: '',
    lastLocation: null,
    locV: null,
    lastIdentity: null,
    autoSync: false,
    lastSyncedHash: null,
    lastSyncAt: null,
    lastRemoteAt: null
  };
}

function syncSanitizeConfig(raw) {
  var d = syncDefaultConfig();
  var c = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  if (syncIsProvider(c.provider)) d.provider = c.provider;
  if (typeof c.filename === 'string' && c.filename.trim() !== '') d.filename = syncSanitizeFilename(c.filename);
  if (typeof c.url === 'string') d.url = c.url.trim().slice(0, 512);
  if (typeof c.username === 'string') d.username = c.username.slice(0, 256);
  if (typeof c.password === 'string') d.password = c.password.slice(0, 512);
  d.rememberPassword = (c.rememberPassword === true);
  if (!d.rememberPassword) d.password = '';
  // Sync passphrase: persisted only with explicit opt-in, exactly like the
  // drive passwords above. Needed for auto-sync across reloads.
  d.rememberPassphrase = (c.rememberPassphrase === true);
  if (d.rememberPassphrase && typeof c.passphrase === 'string') d.passphrase = c.passphrase.slice(0, 512);
  else d.passphrase = '';
  if (typeof c.clientId === 'string') d.clientId = c.clientId.trim().slice(0, 256);
  if (typeof c.clientSecret === 'string') d.clientSecret = c.clientSecret.slice(0, 512);
  if (c.tokens && typeof c.tokens === 'object' && typeof c.tokens.access === 'string' && c.tokens.access !== '') {
    d.tokens = {
      access: String(c.tokens.access).slice(0, 4096),
      refresh: (typeof c.tokens.refresh === 'string') ? String(c.tokens.refresh).slice(0, 4096) : '',
      expiry: (isFinite(Number(c.tokens.expiry))) ? Number(c.tokens.expiry) : 0
    };
  } else {
    d.tokens = null;
  }
  if (typeof c.endpoint === 'string' && c.endpoint.trim() !== '') d.endpoint = c.endpoint.trim().replace(/\/+$/, '').slice(0, 256);
  if (typeof c.region === 'string' && c.region.trim() !== '') d.region = c.region.trim().slice(0, 64);
  if (typeof c.bucket === 'string') d.bucket = c.bucket.trim().slice(0, 128);
  if (typeof c.accessKey === 'string') d.accessKey = c.accessKey.trim().slice(0, 256);
  // MEGA secret key is only persisted when the user explicitly opts in
  // (sy-remember2); otherwise it lives in memory for this session only.
  d.rememberSecret = (c.rememberSecret === true);
  if (d.rememberSecret && typeof c.secretKey === 'string') d.secretKey = c.secretKey.slice(0, 512);
  else d.secretKey = '';
  if (typeof c.objectKey === 'string' && c.objectKey.trim() !== '') d.objectKey = c.objectKey.trim().replace(/^\/+/, '').slice(0, 256) || SYNC_DEFAULT_FILENAME;
  // Migrate legacy full-path object keys (folder/file) into the split fields.
  var folderFromKey = '';
  if (d.provider === 'megas3' && d.objectKey.indexOf('/') !== -1) {
    var segs = d.objectKey.split('/');
    d.objectKey = segs.pop() || SYNC_DEFAULT_FILENAME;
    folderFromKey = syncNormalizeFolder(segs.join('/'));
  }
  d.objectKey = syncSanitizeFilename(d.objectKey);
  d.folder = syncNormalizeFolder(c.folder) || folderFromKey;
  if (typeof c.lastLocation === 'string' && c.lastLocation !== '') d.lastLocation = c.lastLocation.slice(0, 512);
  d.locV = (c.locV === SYNC_LOC_V) ? SYNC_LOC_V : null;
  if (d.locV === null) d.lastLocation = null;
  if (typeof c.lastIdentity === 'string' && c.lastIdentity !== '') d.lastIdentity = c.lastIdentity.slice(0, 512);
  if (d.locV === null) d.lastIdentity = null;
  d.autoSync = (c.autoSync === true);
  if (typeof c.lastSyncedHash === 'string' && c.lastSyncedHash !== '') d.lastSyncedHash = c.lastSyncedHash.slice(0, 64);
  if (typeof c.lastSyncAt === 'string' && isFinite(Date.parse(c.lastSyncAt))) d.lastSyncAt = c.lastSyncAt;
  if (typeof c.lastRemoteAt === 'string' && isFinite(Date.parse(c.lastRemoteAt))) d.lastRemoteAt = c.lastRemoteAt;
  return d;
}

function syncLoadConfig() {
  var raw = null;
  try {
    if (typeof localStorage === 'undefined') return syncDefaultConfig();
    var s = localStorage.getItem(SYNC_STORAGE_KEY);
    raw = s ? JSON.parse(s) : null;
  } catch (e) {
    raw = null;
  }
  return syncSanitizeConfig(raw);
}

function syncSaveConfig(cfg) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(syncSanitizeConfig(cfg)));
    return true;
  } catch (e) {
    return false;
  }
}

// Secrets the user chose NOT to remember live only in memory, never in storage.
function syncPassword(cfg) {
  if (cfg.password) return cfg.password;
  return syncMemSecrets.password || '';
}

function syncSecret(cfg) {
  if (cfg.secretKey) return cfg.secretKey;
  return syncMemSecrets.secretKey || '';
}

// --- WebCrypto layer (async; guarded) ---

function syncCryptoObj() {
  try {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) return window.crypto;
    if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) return self.crypto;
    if (typeof crypto !== 'undefined' && crypto.subtle) return crypto;
  } catch (e) { /* ignore */ }
  return null;
}

function syncCryptoAvailable() {
  var c = syncCryptoObj();
  return !!(c && c.subtle && typeof c.subtle.importKey === 'function' && typeof c.getRandomValues === 'function');
}

function syncRandomBytes(n) {
  var c = syncCryptoObj();
  var out = new Uint8Array(n);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  // Never fall back to Math.random for salts, IVs or OAuth verifiers:
  // predictable randomness would break the encryption. Callers already
  // gate on syncCryptoAvailable(); this is a fail-closed backstop.
  throw new Error('sync failed: no secure randomness available in this browser.');
}

function syncSha256(bytes) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: WebCrypto unavailable.'));
  return c.subtle.digest('SHA-256', bytes).then(function (d) { return new Uint8Array(d); });
}

function syncHmac(keyBytes, dataBytes) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: WebCrypto unavailable.'));
  return c.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']).then(function (k) {
    return c.subtle.sign('HMAC', k, dataBytes);
  }).then(function (sig) {
    return new Uint8Array(sig);
  });
}

function syncDeriveAesKey(passphrase, salt, iter) {
  var c = syncCryptoObj();
  if (!c) return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  var pwBytes = syncUtf8Encode(passphrase);
  return c.subtle.importKey('raw', pwBytes, { name: 'PBKDF2' }, false, ['deriveBits']).then(function (base) {
    return c.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' }, base, 256);
  }).then(function (bits) {
    return c.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  });
}

function syncEncryptEnvelope(plaintext, passphrase) {
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable). Use Download backup instead.'));
  }
  if (!passphrase) return Promise.reject(new Error('sync failed: enter a sync passphrase.'));
  var salt = syncRandomBytes(16);
  var iv = syncRandomBytes(12);
  var data = syncUtf8Encode(plaintext);
  return syncDeriveAesKey(passphrase, salt, SYNC_PBKDF2_ITER).then(function (key) {
    var c = syncCryptoObj();
    return c.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);
  }).then(function (ct) {
    return syncEnvelopeWrap(syncB64encode(new Uint8Array(ct)), syncB64encode(salt), syncB64encode(iv), SYNC_PBKDF2_ITER);
  });
}

function syncDecryptEnvelope(envelopeText, passphrase) {
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  }
  if (!passphrase) return Promise.reject(new Error('sync failed: enter the sync passphrase.'));
  var env;
  try {
    env = syncEnvelopeParse(envelopeText);
  } catch (e) {
    return Promise.reject(e);
  }
  return syncDeriveAesKey(passphrase, env.salt, env.iter).then(function (key) {
    var c = syncCryptoObj();
    return c.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, key, env.ciphertext);
  }).then(function (pt) {
    return syncUtf8Decode(new Uint8Array(pt));
  }, function () {
    throw new Error('sync failed: wrong passphrase or corrupted file.');
  });
}

// Short display fingerprint so two devices can check they typed the same
// passphrase. Display-only; it never leaves the browser.
function syncFingerprint(passphrase) {
  if (!passphrase) return Promise.resolve('');
  return syncSha256(syncUtf8Encode('plutus-sync:' + passphrase)).then(function (h) {
    var hex = syncHex(h).slice(0, 12);
    return hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12);
  }, function () {
    return '';
  });
}

// --- Network helpers ---

function syncNetErr(label) {
  return function () {
    throw new Error('sync failed: cannot reach ' + label + '. Check your connection.');
  };
}

// All sync traffic goes through here: a hung connection aborts after
// SYNC_TIMEOUT_MS so the UI can never wedge with its buttons disabled.
// Degrades to plain fetch where AbortController/timers are unavailable.
var SYNC_TIMEOUT_MS = 30000;

function syncFetch(url, opts, label) {
  var o = opts || {};
  try {
    if (typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined') {
      var ctrl = new AbortController();
      o.signal = ctrl.signal;
      var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, SYNC_TIMEOUT_MS);
      return fetch(url, o).then(function (res) {
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
        return res;
      }, function (err) {
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
        if (err && err.name === 'AbortError') {
          throw new Error('sync failed: timed out reaching ' + label + '. Check your connection.');
        }
        throw new Error('sync failed: cannot reach ' + label + '. Check your connection.');
      });
    }
  } catch (e) { /* fall through to plain fetch */ }
  return fetch(url, o).then(null, syncNetErr(label));
}

// User-configured hosts must use https (loopback excepted) so logins and
// tokens never travel in cleartext where anyone on the network can read them.
function syncRequireHttpsUrl(url, label) {
  var s = String(url || '');
  var m = s.match(/^(https?):\/\/([^\/]+)/i);
  if (!m) throw new Error('sync failed: enter the ' + label + ' URL starting with https://.');
  var hostport = m[2].toLowerCase();
  var host = hostport;
  if (host.charAt(0) === '[') {
    host = host.slice(1, host.indexOf(']'));
  } else {
    host = host.split(':')[0];
  }
  var local = (host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.indexOf('127.') === 0);
  if (m[1].toLowerCase() !== 'https' && !local) {
    throw new Error('sync failed: the ' + label + ' URL must use https:// (not http) so your login stays private.');
  }
  return s;
}

function syncPostForm(url, body) {
  return syncFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body
  }, 'the sign-in server').then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        var msg = (data && (data.error_description || data.error)) || ('HTTP ' + res.status);
        throw new Error('sync failed: sign-in refused (' + String(msg).slice(0, 160) + ').');
      }
      return data || {};
    }, function () {
      if (!res.ok) throw new Error('sync failed: sign-in refused (HTTP ' + res.status + ').');
      throw new Error('sync failed: bad sign-in response.');
    });
  });
}

// --- OAuth (PKCE, user's own app credentials; tokens stay in this browser) ---

function syncRedirectUri() {
  try {
    if (typeof window === 'undefined' || !window.location) return '';
    var loc = window.location;
    if (!loc.protocol || loc.protocol.indexOf('http') !== 0 || !loc.host) return '';
    return loc.protocol + '//' + loc.host + String(loc.pathname || '/');
  } catch (e) {
    return '';
  }
}

function syncPkcePair() {
  var verifier = syncB64UrlEncode(syncRandomBytes(64));
  return syncSha256(syncUtf8Encode(verifier)).then(function (h) {
    return { verifier: verifier, challenge: syncB64UrlEncode(h) };
  });
}

function syncOAuthAuthUrl(providerId, clientId, redirectUri, challenge, state) {
  var scope;
  if (providerId === 'gdrive') {
    scope = 'https://www.googleapis.com/auth/drive.file';
    return 'https://accounts.google.com/o/oauth2/v2/auth' +
      '?client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code' +
      '&scope=' + encodeURIComponent(scope) +
      '&code_challenge=' + encodeURIComponent(challenge) +
      '&code_challenge_method=S256' +
      '&access_type=offline&prompt=consent&include_granted_scopes=true' +
      '&state=' + encodeURIComponent(state);
  }
  if (providerId === 'dropbox') {
    return 'https://www.dropbox.com/oauth2/authorize' +
      '?client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&response_type=code' +
      '&code_challenge=' + encodeURIComponent(challenge) +
      '&code_challenge_method=S256' +
      '&token_access_type=offline' +
      '&state=' + encodeURIComponent(state);
  }
  return '';
}

function syncOAuthTokenExchange(providerId, cfg, code, verifier) {
  var redirect = syncRedirectUri();
  var cid = syncEffectiveClientId(cfg);
  var body;
  var url;
  if (providerId === 'gdrive') {
    url = 'https://oauth2.googleapis.com/token';
    body = 'grant_type=authorization_code' +
      '&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&client_id=' + encodeURIComponent(cid) +
      '&client_secret=' + encodeURIComponent(cfg.clientSecret || '') +
      '&code_verifier=' + encodeURIComponent(verifier);
  } else if (providerId === 'dropbox') {
    url = 'https://api.dropboxapi.com/oauth2/token';
    body = 'grant_type=authorization_code' +
      '&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(redirect) +
      '&client_id=' + encodeURIComponent(cid) +
      '&code_verifier=' + encodeURIComponent(verifier);
  } else {
    return Promise.reject(new Error('sync failed: unknown provider.'));
  }
  return syncPostForm(url, body).then(function (tok) {
    return syncNormalizeTokens(tok);
  });
}

function syncOAuthRefresh(providerId, cfg) {
  var t = cfg.tokens || {};
  if (!t.refresh) return Promise.reject(new Error('sync failed: connect your drive first.'));
  var cid = syncEffectiveClientId(cfg);
  var body;
  var url;
  if (providerId === 'gdrive') {
    url = 'https://oauth2.googleapis.com/token';
    body = 'grant_type=refresh_token' +
      '&refresh_token=' + encodeURIComponent(t.refresh) +
      '&client_id=' + encodeURIComponent(cid) +
      '&client_secret=' + encodeURIComponent(cfg.clientSecret || '');
  } else if (providerId === 'dropbox') {
    url = 'https://api.dropboxapi.com/oauth2/token';
    body = 'grant_type=refresh_token' +
      '&refresh_token=' + encodeURIComponent(t.refresh) +
      '&client_id=' + encodeURIComponent(cid);
  } else {
    return Promise.reject(new Error('sync failed: unknown provider.'));
  }
  return syncPostForm(url, body).then(function (tok) {
    var n = syncNormalizeTokens(tok);
    if (!n.refresh) n.refresh = t.refresh;
    return n;
  });
}

function syncNormalizeTokens(tok) {
  var out = { access: '', refresh: '', expiry: 0 };
  if (tok && typeof tok.access_token === 'string') out.access = tok.access_token;
  if (tok && typeof tok.refresh_token === 'string') out.refresh = tok.refresh_token;
  var exp = tok ? Number(tok.expires_in) : 0;
  out.expiry = (isFinite(exp) && exp > 0) ? (Date.now() + exp * 1000) : 0;
  if (!out.access) throw new Error('sync failed: sign-in gave no access token.');
  return out;
}

function syncEnsureAccessToken(cfg) {
  var t = cfg.tokens;
  if (!t || !t.access) return Promise.reject(new Error('sync failed: connect your drive first.'));
  if (t.expiry && (t.expiry - Date.now()) > 60000) return Promise.resolve(t.access);
  if (!t.refresh) {
    if (t.expiry && t.expiry <= Date.now()) {
      return Promise.reject(new Error('sync failed: session expired — connect again.'));
    }
    return Promise.resolve(t.access);
  }
  return syncOAuthRefresh(cfg.provider, cfg).then(function (n) {
    cfg.tokens = n;
    syncSaveConfig(cfg);
    return n.access;
  });
}

function syncParseQuery(q) {
  var out = {};
  var pairs = String(q || '').split('&');
  var i, kv, k, v;
  for (i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    kv = pairs[i].split('=');
    k = kv[0];
    v = kv.slice(1).join('=');
    try { k = decodeURIComponent(k); } catch (e) { /* keep raw */ }
    try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ }
    out[k] = v;
  }
  return out;
}

// Runs in the OAuth popup after the provider redirects back to this page:
// hands the code to the opener window and closes itself.
function syncHandleOAuthRedirect() {
  try {
    if (typeof window === 'undefined' || !window.location || !window.opener) return;
    var search = String(window.location.search || '');
    if (search.indexOf('code=') === -1 && search.indexOf('error=') === -1) return;
    var q = syncParseQuery(search.replace(/^\?/, ''));
    if (!q.state || q.state.indexOf('plutus-') !== 0) return;
    if (!q.code && !q.error) return;
    try {
      window.opener.postMessage({ type: 'plutus-oauth', code: q.code || null, error: q.error || null, state: q.state }, window.location.origin);
    } catch (e) { /* ignore */ }
    try {
      if (document && document.body) {
        document.body.innerHTML = '<p style="font-family:sans-serif;padding:2rem">Signed in — you can close this window.</p>';
      }
    } catch (e2) { /* ignore */ }
    try { window.close(); } catch (e3) { /* ignore */ }
  } catch (e) { /* ignore */ }
}

// --- Provider transports (ciphertext in, ciphertext out) ---

function syncWebdavAuth(cfg) {
  var pw = syncPassword(cfg);
  if (!cfg.url) throw new Error('sync failed: enter the WebDAV server URL.');
  if (!pw) throw new Error('sync failed: enter the WebDAV password.');
  syncRequireHttpsUrl(cfg.url, 'WebDAV server');
  return 'Basic ' + syncB64encode(syncUtf8Encode(cfg.username + ':' + pw));
}

// Creates the destination collection and a few missing parents (MKCOL,
// capped depth, existing collections answer 405). Used before a first
// upload and as a one-time retry when a PUT hits a missing folder.
function syncWebdavMkdirP(cfg) {
  var auth;
  try {
    auth = syncWebdavAuth(cfg);
  } catch (e) {
    return Promise.reject(e);
  }
  var base = String(cfg.url).replace(/\s+$/g, '').replace(/\/+$/, '');
  var folder = syncJoinUrl(cfg.url, cfg.filename);
  var slash = folder.lastIndexOf('/');
  folder = (slash > 8) ? folder.slice(0, slash) : base;
  var chain = [];
  var cur = folder;
  var guard = 0;
  while (cur && cur.length > base.length && guard < 6) {
    chain.unshift(cur);
    var cut = cur.lastIndexOf('/');
    if (cut <= 8) break;
    cur = cur.slice(0, cut);
    guard++;
  }
  var p = Promise.resolve(true);
  chain.forEach(function (u) {
    p = p.then(function () {
      return syncFetch(u, { method: 'MKCOL', headers: { 'Authorization': auth } }, 'the WebDAV server').then(function (res) {
        if (res.ok || res.status === 405 || res.status === 412 || res.status === 200 || res.status === 207) return true;
        if (res.status === 401 || res.status === 403) {
          throw new Error('sync failed: WebDAV refused (HTTP ' + res.status + ') — check the app password and folder permissions.');
        }
        throw new Error('sync failed: WebDAV folder cannot be created (HTTP ' + res.status + '). Check the server URL.');
      });
    });
  });
  return p;
}

function syncWebdavUpload(cfg, text) {
  var auth;
  try {
    auth = syncWebdavAuth(cfg);
  } catch (e) {
    return Promise.reject(e);
  }
  var target = syncJoinUrl(cfg.url, cfg.filename);
  function putOnce() {
    return syncFetch(target, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: text
    }, 'the WebDAV server').then(function (res) {
      if (res.ok) return { done: true };
      if (res.status === 401 || res.status === 403) {
        throw new Error('sync failed: WebDAV login refused. Check the username and app password.');
      }
      if (res.status === 404) {
        throw new Error('sync failed: WebDAV folder not found. Check the server URL.');
      }
      if (res.status === 409) return { retryFolder: true };
      throw new Error('sync failed: WebDAV upload refused (HTTP ' + res.status + ').');
    });
  }
  return putOnce().then(function (r) {
    if (r.done) return true;
    return syncWebdavMkdirP(cfg).then(putOnce).then(function (r2) {
      if (r2.done) return true;
      throw new Error('sync failed: WebDAV upload refused (HTTP 409). Check the server URL.');
    });
  });
}

function syncWebdavDownload(cfg) {
  var pw = syncPassword(cfg);
  if (!cfg.url) return Promise.reject(new Error('sync failed: enter the WebDAV server URL.'));
  if (!pw) return Promise.reject(new Error('sync failed: enter the WebDAV password.'));
  try {
    syncRequireHttpsUrl(cfg.url, 'WebDAV server');
  } catch (e) {
    return Promise.reject(e);
  }
  var auth = 'Basic ' + syncB64encode(syncUtf8Encode(cfg.username + ':' + pw));
  return syncFetch(syncJoinUrl(cfg.url, cfg.filename), {
    method: 'GET',
    headers: { 'Authorization': auth }
  }, 'the WebDAV server').then(function (res) {
    if (res.ok) return res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error('sync failed: WebDAV login refused. Check the username and app password.');
    }
    if (res.status === 404) throw new Error('sync failed: no backup found on the server yet.');
    throw new Error('sync failed: WebDAV download refused (HTTP ' + res.status + ').');
  });
}

function syncDriveList(access, q) {
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
    '&fields=' + encodeURIComponent('files(id,name,modifiedTime)') + '&spaces=drive';
  return syncFetch(url, { headers: { 'Authorization': 'Bearer ' + access } }, 'Google Drive').then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) throw new Error('sync failed: Drive lookup refused (HTTP ' + res.status + ').');
      return (data && data.files) || [];
    }, function () {
      throw new Error('sync failed: bad Drive response.');
    });
  });
}

function syncDriveFind(access, name, folderId) {
  var parent = String(folderId || 'root').replace(/'/g, '');
  var q = "name = '" + String(name).replace(/'/g, '') + "' and '" + parent + "' in parents and trashed = false";
  return syncDriveList(access, q).then(function (files) {
    return (files.length && files[0].id) ? files[0].id : null;
  });
}

// Walks/creates a 'a/b/c' folder tree under Drive root. With create=false it
// only resolves (missing segment -> null) so downloads never create folders.
function syncDriveFolderId(access, folder, create) {
  var segs = String(folder || '').split('/').filter(function (s) { return s !== ''; });
  var chain = Promise.resolve('root');
  segs.forEach(function (seg) {
    chain = chain.then(function (pid) { return syncDriveFolderStep(access, seg, pid, create); });
  });
  return chain;
}

function syncDriveFolderStep(access, name, parentId, create) {
  if (parentId === null) return Promise.resolve(null);
  var clean = String(name).replace(/'/g, '');
  var q = "mimeType = 'application/vnd.google-apps.folder' and name = '" + clean +
    "' and '" + String(parentId).replace(/'/g, '') + "' in parents and trashed = false";
  return syncDriveList(access, q).then(function (files) {
    if (files.length && files[0].id) return files[0].id;
    if (!create) return null;
    return syncFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: clean, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    }, 'Google Drive').then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || !data.id) {
          throw new Error('sync failed: Drive could not create the folder (HTTP ' + res.status + ').');
        }
        return data.id;
      }, function () {
        throw new Error('sync failed: bad Drive response.');
      });
    });
  });
}

function syncDrivePutMedia(access, id, text) {
  return syncFetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=media', {
    method: 'PATCH',
    headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
    body: text
  }, 'Google Drive').then(function (res) {
    if (res.ok) return true;
    throw new Error('sync failed: Drive upload refused (HTTP ' + res.status + ').');
  });
}

function syncDriveUpload(access, cfg, text) {
  var folder = syncNormalizeFolder(cfg.folder);
  return syncDriveFolderId(access, folder, true).then(function (fid) {
    return syncDriveFind(access, cfg.filename, fid).then(function (id) {
      if (id) return syncDrivePutMedia(access, id, text);
      return syncFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + access, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cfg.filename, mimeType: 'application/json', parents: [fid] })
      }, 'Google Drive').then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || !data || !data.id) {
            throw new Error('sync failed: Drive could not create the file (HTTP ' + res.status + ').');
          }
          return syncDrivePutMedia(access, data.id, text);
        }, function () {
          throw new Error('sync failed: bad Drive response.');
        });
      });
    });
  });
}

function syncDriveDownload(access, cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  return syncDriveFolderId(access, folder, false).then(function (fid) {
    if (!fid) throw new Error('sync failed: no backup found on the server yet.');
    return syncDriveFind(access, cfg.filename, fid).then(function (id) {
      if (!id) throw new Error('sync failed: no backup found on the server yet.');
      return syncFetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
        headers: { 'Authorization': 'Bearer ' + access }
      }, 'Google Drive').then(function (res) {
        if (res.ok) return res.text();
        throw new Error('sync failed: Drive download refused (HTTP ' + res.status + ').');
      });
    });
  });
}

// Full Dropbox path including the optional subfolder (uploads auto-create it).
function syncDropboxFullPath(cfg) {
  var folder = syncNormalizeFolder(cfg.folder);
  return '/' + (folder ? folder + '/' : '') + cfg.filename;
}

function syncDropboxUpload(access, cfg, text) {
  return syncFetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: syncDropboxFullPath(cfg), mode: 'overwrite', autorename: false, mute: true })
    },
    body: text
  }, 'Dropbox').then(function (res) {
    if (res.ok) return true;
    throw new Error('sync failed: Dropbox upload refused (HTTP ' + res.status + ').');
  });
}

function syncDropboxDownload(access, cfg) {
  var arg = JSON.stringify({ path: syncDropboxFullPath(cfg) });
  return syncFetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Dropbox-API-Arg': arg
    }
  }, 'Dropbox').then(function (res) {
    if (res.ok) return res.text();
    // 409 means the API refused the call: only treat path/not_found as
    // "no backup yet" — anything else is a real refusal, not a first sync.
    if (res.status === 409) {
      return res.text().then(function (body) {
        if (body && body.indexOf('not_found') !== -1) {
          throw new Error('sync failed: no backup found on the server yet.');
        }
        throw new Error('sync failed: Dropbox refused the request (HTTP 409).');
      }, function () {
        throw new Error('sync failed: Dropbox download refused (HTTP 409).');
      });
    }
    throw new Error('sync failed: Dropbox download refused (HTTP ' + res.status + ').');
  });
}

function syncDropboxExists(access, cfg) {
  return syncFetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + access,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: syncDropboxFullPath(cfg) })
  }, 'Dropbox').then(function (res) {
    if (res.ok) return true;
    if (res.status === 409) {
      return res.text().then(function (body) {
        if (body && body.indexOf('not_found') !== -1) return false;
        throw new Error('sync failed: Dropbox refused the request (HTTP 409).');
      }, function () {
        throw new Error('sync failed: Dropbox lookup refused (HTTP 409).');
      });
    }
    throw new Error('sync failed: Dropbox lookup refused (HTTP ' + res.status + ').');
  });
}

// --- MEGA S4 (S3-compatible SigV4; standard HMAC-SHA256, no custom crypto) ---

function syncSplitUrl(url) {
  var s = String(url || '');
  var m = s.match(/^https?:\/\/([^\/]+)(\/.*)?$/);
  var host = m ? m[1].toLowerCase() : '';
  var path = (m && m[2]) ? m[2] : '/';
  var q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  if (!path) path = '/';
  return { host: host, path: path };
}

// S3/SigV4 path encoding: encodeURIComponent leaves !'()* raw, but the
// canonical request requires them percent-encoded (uppercase hex), or AWS
// rejects the signature. Folders and keys share it; bucket names cannot
// contain those characters by S3 naming rules.
function syncS3EncodeSeg(seg) {
  return encodeURIComponent(String(seg)).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function syncS3Url(cfg) {
  var ep = String(cfg.endpoint || '').replace(/\/+$/, '');
  var folder = syncNormalizeFolder(cfg.folder);
  var key = String(cfg.objectKey || '').split('/').map(syncS3EncodeSeg).join('/');
  var full = (folder ? folder.split('/').map(syncS3EncodeSeg).join('/') + '/' : '') + key;
  return ep + '/' + encodeURIComponent(cfg.bucket) + '/' + full;
}

function syncS3CanonicalRequest(method, url, payloadHash, amzDate) {
  var parts = syncSplitUrl(url);
  var signed, heads;
  if (method === 'PUT') {
    signed = 'content-type;host;x-amz-content-sha256;x-amz-date';
    heads = 'content-type:application/json\nhost:' + parts.host +
      '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amzDate + '\n';
  } else {
    signed = 'host;x-amz-content-sha256;x-amz-date';
    heads = 'host:' + parts.host +
      '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amzDate + '\n';
  }
  return method + '\n' + parts.path + '\n\n' + heads + '\n' + signed + '\n' + payloadHash;
}

function syncAmzDate(d) {
  function p(x, n) {
    x = String(x);
    while (x.length < n) x = '0' + x;
    return x;
  }
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1, 2) + p(d.getUTCDate(), 2) + 'T' +
    p(d.getUTCHours(), 2) + p(d.getUTCMinutes(), 2) + p(d.getUTCSeconds(), 2) + 'Z';
}

function syncS3Sign(cfg, method, payloadText) {
  // Cheap configuration checks first (no crypto needed, better messages on
  // exotic browsers, and unit-testable without WebCrypto).
  var secret = syncSecret(cfg);
  if (!cfg.endpoint || syncSplitUrl(cfg.endpoint).host === '') {
    return Promise.reject(new Error('sync failed: enter the S3 endpoint URL.'));
  }
  try {
    syncRequireHttpsUrl(cfg.endpoint, 'S3 endpoint');
  } catch (e) {
    return Promise.reject(e);
  }
  if (!cfg.bucket) return Promise.reject(new Error('sync failed: enter the S3 bucket.'));
  if (!cfg.accessKey) return Promise.reject(new Error('sync failed: enter the S3 access key.'));
  if (!secret) return Promise.reject(new Error('sync failed: enter the S3 secret key.'));
  if (!cfg.region) return Promise.reject(new Error('sync failed: enter the S3 region.'));
  if (!syncCryptoAvailable()) {
    return Promise.reject(new Error('sync failed: this browser cannot do encrypted sync (WebCrypto unavailable).'));
  }
  var url = syncS3Url(cfg);
  var now = new Date();
  var amzDate = syncAmzDate(now);
  var dateStamp = amzDate.slice(0, 8);
  var payloadBytes = syncUtf8Encode(payloadText || '');
  return syncSha256(payloadBytes).then(function (phBytes) {
    var payloadHash = syncHex(phBytes);
    var canon = syncS3CanonicalRequest(method, url, payloadHash, amzDate);
    return syncSha256(syncUtf8Encode(canon)).then(function (chBytes) {
      var sts = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + dateStamp + '/' + cfg.region +
        '/s3/aws4_request\n' + syncHex(chBytes);
      return syncHmac(syncUtf8Encode('AWS4' + secret), syncUtf8Encode(dateStamp)).then(function (kDate) {
        return syncHmac(kDate, syncUtf8Encode(cfg.region));
      }).then(function (kRegion) {
        return syncHmac(kRegion, syncUtf8Encode('s3'));
      }).then(function (kService) {
        return syncHmac(kService, syncUtf8Encode('aws4_request'));
      }).then(function (kSigning) {
        return syncHmac(kSigning, syncUtf8Encode(sts));
      }).then(function (sigBytes) {
        var signedHeaders = (method === 'PUT')
          ? 'content-type;host;x-amz-content-sha256;x-amz-date'
          : 'host;x-amz-content-sha256;x-amz-date';
        var auth = 'AWS4-HMAC-SHA256 Credential=' + cfg.accessKey + '/' + dateStamp + '/' +
          cfg.region + '/s3/aws4_request, SignedHeaders=' + signedHeaders +
          ', Signature=' + syncHex(sigBytes);
        var headers = {
          'x-amz-date': amzDate,
          'x-amz-content-sha256': payloadHash,
          'Authorization': auth
        };
        if (method === 'PUT') headers['Content-Type'] = 'application/json';
        return { url: url, headers: headers };
      });
    });
  });
}

// Reads an S3 XML error body and maps it to a calm, specific message:
// clock skew vs wrong keys vs missing object are very different problems.
function syncS3ErrorBody(body, missingMsg) {
  if (body && body.indexOf('RequestTimeTooSkewed') !== -1) {
    return new Error('sync failed: the device clock looks wrong — S3 refused the time. Fix the date/time and retry.');
  }
  if (body && (body.indexOf('NoSuchBucket') !== -1 || body.indexOf('NoSuchKey') !== -1)) {
    return new Error(missingMsg);
  }
  return null;
}

function syncS3Put(cfg, text) {
  return syncS3Sign(cfg, 'PUT', text).then(function (s) {
    return syncFetch(s.url, { method: 'PUT', headers: s.headers, body: text }, 'the S3 endpoint').then(function (res) {
      if (res.ok) return true;
      if (res.status === 403 || res.status === 404) {
        return res.text().then(function (body) {
          throw syncS3ErrorBody(body, 'sync failed: S3 bucket not found. Check the endpoint and bucket name.') ||
            new Error('sync failed: S3 keys refused. Check the access key, secret, region and bucket policy.');
        }, function () {
          throw new Error('sync failed: S3 upload refused (HTTP ' + res.status + ').');
        });
      }
      throw new Error('sync failed: S3 upload refused (HTTP ' + res.status + ').');
    });
  });
}

function syncS3Get(cfg) {
  return syncS3Sign(cfg, 'GET', '').then(function (s) {
    return syncFetch(s.url, { method: 'GET', headers: s.headers }, 'the S3 endpoint').then(function (res) {
      if (res.ok) return res.text();
      if (res.status === 404 || res.status === 403) {
        return res.text().then(function (body) {
          throw syncS3ErrorBody(body, 'sync failed: no backup found on the server yet.') ||
            new Error('sync failed: S3 keys refused. Check the access key, secret, region and bucket policy.');
        }, function () {
          throw new Error('sync failed: S3 download refused (HTTP ' + res.status + ').');
        });
      }
      throw new Error('sync failed: S3 download refused (HTTP ' + res.status + ').');
    });
  });
}

function syncRemoteUpload(cfg, text) {
  if (cfg.provider === 'webdav') return syncWebdavUpload(cfg, text);
  if (cfg.provider === 'megas3') return syncS3Put(cfg, text);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') return syncDriveUpload(access, cfg, text);
    if (cfg.provider === 'dropbox') return syncDropboxUpload(access, cfg, text);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

function syncRemoteDownload(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavDownload(cfg);
  if (cfg.provider === 'megas3') return syncS3Get(cfg);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') return syncDriveDownload(access, cfg);
    if (cfg.provider === 'dropbox') return syncDropboxDownload(access, cfg);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

// True when a file already lives at this destination. Auth and transport
// failures reject (never misread as "free") so the duplicate gate below
// can only pass on proof of absence.
function syncRemoteExists(cfg) {
  if (cfg.provider === 'webdav') {
    return syncWebdavDownload(cfg).then(function () { return true; }, function (err) {
      if (err && err.message && err.message.indexOf('no backup found') !== -1) return false;
      throw err;
    });
  }
  if (cfg.provider === 'megas3') {
    return syncS3Get(cfg).then(function () { return true; }, function (err) {
      if (err && err.message && err.message.indexOf('no backup found') !== -1) return false;
      throw err;
    });
  }
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), false).then(function (fid) {
        if (!fid) return false;
        return syncDriveFind(access, cfg.filename, fid).then(function (id) { return !!id; });
      });
    }
    if (cfg.provider === 'dropbox') return syncDropboxExists(access, cfg);
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

// Idempotent folder preparation before an upload. WebDAV creates missing
// collections (MKCOL walking up at most a few levels); Drive walks and
// creates its folder tree; Dropbox and S3 need nothing (parents appear
// with the object itself).
function syncRemoteEnsureFolder(cfg) {
  if (cfg.provider === 'webdav') return syncWebdavMkdirP(cfg);
  if (cfg.provider === 'megas3') return Promise.resolve(true);
  return syncEnsureAccessToken(cfg).then(function (access) {
    if (cfg.provider === 'gdrive') {
      return syncDriveFolderId(access, syncNormalizeFolder(cfg.folder), true).then(function () { return true; });
    }
    if (cfg.provider === 'dropbox') return true;
    return Promise.reject(new Error('sync failed: unknown provider.'));
  });
}

// --- Push / pull orchestration (local data only replaced after full validation) ---

function syncSetStatus(text) {
  var el = (typeof document !== 'undefined') ? document.getElementById('sy-status') : null;
  if (el) el.textContent = String(text);
}

function syncSetBusy(on, note) {
  syncBusy = !!on;
  var ids = ['sy-connect', 'sy-disconnect', 'sy-push', 'sy-pull', 'sy-enc-download'];
  var i, el;
  for (i = 0; i < ids.length; i++) {
    el = (typeof document !== 'undefined') ? document.getElementById(ids[i]) : null;
    if (el) el.disabled = syncBusy;
  }
  if (on && note) syncSetStatus(note);
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
}

function syncLocalExportedAt(json) {
  try {
    var d = JSON.parse(json);
    if (d && typeof d.exportedAt === 'string') return d.exportedAt;
  } catch (e) { /* ignore */ }
  return '';
}

// Dirty tracking without crypto: a fast non-crypto hash (djb2 pair) over the
// stable backup projection (exportedAt excluded, or every push would look
// dirty). Used only to decide "same as last upload", never for security.
function syncStateHash(str) {
  var h1 = 5381;
  var h2 = 52711;
  var s = String(str);
  var i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    h1 = ((h1 * 33) ^ c) >>> 0;
    h2 = ((h2 * 33) ^ c) >>> 0;
  }
  return (h1 >>> 0).toString(16) + '-' + (h2 >>> 0).toString(16);
}

function syncHashOfExport(json) {
  try {
    var d = JSON.parse(String(json));
    return syncStateHash(JSON.stringify({
      settings: (d && d.settings) || {},
      accounts: (d && d.accounts) || [],
      trades: (d && d.trades) || [],
      priceOverrides: (d && d.priceOverrides) || {}
    }));
  } catch (e) {
    return '';
  }
}

function syncCurrentHash(st) {
  var s = st;
  try {
    if (!s) s = loadState();
    return syncHashOfExport(exportState(s));
  } catch (e) {
    return '';
  }
}

// "Connected" = enough filled in to attempt a sync right now (secrets may
// live only in the form for this session). The panel status and the header
// icon share this so they can never disagree.
function syncIsConnected(cfg) {
  if (!cfg) return false;
  if (cfg.provider === 'webdav') return !!(cfg.url && (cfg.password || syncMemSecrets.password));
  if (cfg.provider === 'megas3') {
    return !!(cfg.endpoint && cfg.bucket && cfg.accessKey && (cfg.secretKey || syncMemSecrets.secretKey));
  }
  return !!(cfg.tokens && cfg.tokens.access);
}

function syncSetSyncIcon(state, label) {
  var btn = (typeof document !== 'undefined') ? document.getElementById('tb-sync') : null;
  if (!btn) return;
  try { btn.setAttribute('data-sync', state); } catch (e) { /* ignore */ }
  try { btn.setAttribute('aria-label', label); } catch (e) { /* ignore */ }
  try { btn.title = label; } catch (e) { /* ignore */ }
  try {
    var img = document.getElementById('tb-sync-img');
    if (img) {
      img.src = state === 'busy' ? '/icons/sync-busy.png'
        : state === 'stale' ? '/icons/sync-stale.png'
        : '/icons/sync-ok.png';
    }
  } catch (e) { /* ignore */ }
}

function syncRefreshHeaderIcon(st) {
  var btn = (typeof document !== 'undefined') ? document.getElementById('tb-sync') : null;
  if (!btn) return;
  if (syncBusy) {
    btn.hidden = false;
    syncSetSyncIcon('busy', 'Sync: uploading…');
    return;
  }
  var cfg = syncLoadConfig();
  if (!syncIsConnected(cfg)) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  var cur = '';
  try { cur = syncCurrentHash(st); } catch (e) { cur = ''; }
  if (cur && cfg.lastSyncedHash && cur === cfg.lastSyncedHash) {
    syncSetSyncIcon('ok', 'Sync: up to date. Open sync settings.');
  } else {
    syncSetSyncIcon('stale', 'Sync: changes pending. Open sync settings to sync now.');
  }
}

// Auto-sync (opt-in checkbox in the Sync tab): every persisted change
// schedules one debounced encrypted push using the passphrase currently in
// the form. Silent by design — failures only touch the status line, and a
// newer drive copy never triggers a surprise overwrite prompt.
var SYNC_AUTO_DELAY_MS = 8000;
var syncAutoTimer = null;

function syncAutoDelay(ms) {
  if (ms !== undefined && isFinite(Number(ms)) && Number(ms) >= 0) SYNC_AUTO_DELAY_MS = Number(ms);
  return SYNC_AUTO_DELAY_MS;
}

function syncScheduleAuto() {
  try {
    if (typeof setTimeout === 'undefined') return;
    if (typeof confirmSettle !== 'undefined' && confirmSettle) return; // a confirm dialog owns the user right now
    var cfg = syncLoadConfig();
    if (!cfg.autoSync) return;
    if (syncBusy) return;
    if (syncAutoTimer) {
      try { clearTimeout(syncAutoTimer); } catch (e) { /* ignore */ }
      syncAutoTimer = null;
    }
    syncAutoTimer = setTimeout(function () {
      syncAutoTimer = null;
      try { syncAutoPush(); } catch (e) { /* ignore */ }
    }, SYNC_AUTO_DELAY_MS);
  } catch (e) { /* ignore */ }
}

function syncAutoPush() {
  if (syncBusy) return;
  var cfg;
  try {
    cfg = syncLoadConfig();
  } catch (e) {
    return;
  }
  if (!cfg.autoSync) return;
  // Same source as manual pushes: the typed value, falling back to the
  // remembered passphrase so auto-sync also works when Settings was never
  // opened this session. Without either, stay silent — the hourglass icon
  // already shows pending work, and Connect/Sync enforce the passphrase
  // when pressed.
  var pass = '';
  try {
    pass = syncReadForm().passphrase;
  } catch (e) {
    pass = '';
  }
  if (!pass) return;
  try {
    syncPushFlow({ auto: true });
  } catch (e) { /* ignore */ }
}

// Adopts an already-downloaded + decrypted drive backup (used by the
// taken-name prompt's "Download instead"). Validates fully before touching
// anything, like the pull flow; the confirm already happened, so no snapshot
// dance is needed. Keeps the settings dialog open with a status line.
function syncAdoptRemote(cfg, remotePlain) {
  var next;
  try {
    next = importState(remotePlain);
  } catch (e) {
    if (e && e.message === 'storage-unavailable') throw e;
    throw new Error('sync failed: the drive backup is invalid (' + String((e && e.message) || e).slice(0, 160) + ').');
  }
  if (!saveStateGuarded(next)) return 'failed';
  cfg.lastSyncAt = new Date().toISOString();
  try {
    var d = JSON.parse(remotePlain);
    if (d && typeof d.exportedAt === 'string') cfg.lastRemoteAt = d.exportedAt;
  } catch (e) { /* ignore */ }
  cfg.lastSyncedHash = syncHashOfExport(remotePlain);
  cfg.lastLocation = syncLocationKey(cfg);
  cfg.lastIdentity = syncTrustIdentity(cfg);
  cfg.locV = SYNC_LOC_V;
    syncSaveConfig(cfg);
  syncRefreshSyncPanel();
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  clearBanner();
  syncSetStatus('Restored from ' + syncProviderLabel(cfg.provider) + '.');
  refreshPrices();
  return 'pulled';
}

function syncPushFlow(opts) {  if (syncBusy) return;
  var auto = !!(opts && opts.auto);
  var rd = syncReadForm();
  var cfg = rd.cfg;
  var pass = rd.passphrase;
  if (!pass) {
    // Auto-sync without a passphrase stays silent (hourglass icon shows it);
    // manual attempts get the banner.
    if (auto) return;
    showBanner('Enter a sync passphrase first — it encrypts everything you upload.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['Type a passphrase in the Sync tab. It is never sent anywhere.']
    });
    return;
  }
  var st = loadState();
  if ((!st.accounts || !st.accounts.length) && (!st.trades || !st.trades.length)) {
    if (auto) {
      try { syncSetStatus('Nothing to sync yet.'); } catch (e) { /* ignore */ }
      return;
    }
    showBanner('Nothing to sync yet — add an account first.', 'error', {
      title: 'Sync',
      lines: ['Uploading an empty wallet could overwrite a good drive copy. Add data first.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  syncSetBusy(true, 'Encrypting…');
  var plain = exportState(st);
  var localAt = syncLocalExportedAt(plain);
  var curHash = syncHashOfExport(plain);
  // Already uploaded this exact content: skip all network, manual or auto.
  if (curHash && cfg.lastSyncedHash && curHash === cfg.lastSyncedHash) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    syncSetStatus('Already up to date.');
    return;
  }
  syncEncryptEnvelope(plain, pass).then(function (env) {
    syncSetStatus('Uploading to ' + syncProviderLabel(cfg.provider) + '…');
    var locKey = syncLocationKey(cfg);
    // First save to a destination this device has never synced (or under
    // changed credentials): never clobber a stranger's file (e.g. another
    // profile's backup sharing the same drive). Trusted destinations
    // upload freely.
    if (!syncIsTrustedLocation(cfg, locKey)) {
      return syncRemoteExists(cfg).then(function (taken) {
        if (!taken) {
          return syncRemoteEnsureFolder(cfg).then(function () {
            return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
          });
        }
        return syncRemoteDownload(cfg).then(function (remoteText) {
          return syncDecryptEnvelope(remoteText, pass).then(function (remotePlain) {
            if (curHash && syncHashOfExport(remotePlain) === curHash) {
              // Same content (e.g. reconnect with nothing changed): adopt
              // silently — no prompt, no pointless re-upload.
              cfg.lastLocation = locKey;
              cfg.lastIdentity = syncTrustIdentity(cfg);
              cfg.locV = SYNC_LOC_V;
              cfg.lastRemoteAt = syncLocalExportedAt(remotePlain);
              cfg.lastSyncedHash = curHash;
              syncSaveConfig(cfg);
              syncSetBusy(false);
              syncRefreshSyncPanel();
              try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
              syncSetStatus('Already up to date.');
              return 'adopted';
            }
            // Different content under our name: both directions, explicit.
            // (Auto-sync never prompts either: it stands down for the user.)
            syncSetBusy(false);
            if (auto) {
              syncRefreshSyncPanel();
              try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
              syncSetStatus('Drive holds a different copy — open Sync to resolve.');
              return 'conflict-remote';
            }
            return confirmAction3(
              'Name already taken',
              'A different backup named "' + cfg.filename + '" already exists in this folder. Download it (replaces this device) or upload yours (overwrites the drive file)?',
              'Download instead',
              'Upload mine'
            ).then(function (choice) {
              if (choice === 'primary') return syncAdoptRemote(cfg, remotePlain);
              if (choice === 'secondary') {
                syncSetBusy(true, 'Uploading to ' + syncProviderLabel(cfg.provider) + '…');
                return syncRemoteEnsureFolder(cfg).then(function () {
                  return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
                });
              }
              syncSetStatus('Kept the drive file. Change the name or folder to sync here.');
              return 'cancelled';
            });
          }, function () {
            throw new Error('sync failed: "' + cfg.filename + '" already exists in this folder, under a different passphrase. Choose a different name or folder — or delete that file on the drive if it is yours.');
          });
        });
      });
    }
    // Conflict check: if the drive holds a NEWER backup, ask before overwriting.
    return syncRemoteDownload(cfg).then(function (remoteText) {
      return syncDecryptEnvelope(remoteText, pass).then(function (remotePlain) {
        var cmp = syncCompareTimestamps(localAt, syncLocalExportedAt(remotePlain));
        if (cmp === 'remote-newer') {
          syncSetBusy(false);
          if (auto) {
            // Auto-sync never ambushes with a prompt: leave the drive copy
            // alone and let the user resolve it in the Sync tab.
            syncRefreshSyncPanel();
            try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
            syncSetStatus('Drive holds a newer copy — open Sync to resolve.');
            return 'conflict-remote';
          }
          return confirmAction(
            'Drive copy is newer',
            'The drive backup is newer than this device. Upload anyway and overwrite it, or restore the drive copy here instead?',
            'Upload anyway',
            false
          ).then(function (uploadAnyway) {
            if (!uploadAnyway) {
              syncSetStatus('Upload cancelled — drive copy kept.');
              return 'cancelled';
            }
            syncSetBusy(true, 'Uploading to ' + syncProviderLabel(cfg.provider) + '…');
            return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
          });
        }
        return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
      }, function (decErr) {
        // Drive file exists but this passphrase cannot open it: stop, do not overwrite blindly.
        throw new Error('sync failed: the drive file uses a different passphrase. Enter that passphrase, or clear the drive file first.');
      });
    }, function (dlErr) {
      // Known destination but nothing there (deleted remotely?): recreate it.
      if (dlErr && dlErr.message && dlErr.message.indexOf('no backup found') !== -1) {
        return syncRemoteEnsureFolder(cfg).then(function () {
          return syncRemoteUpload(cfg, env).then(function () { return 'pushed'; });
        });
      }
      throw dlErr;
    });
  }).then(function (outcome) {
    syncSetBusy(false);
    if (outcome === 'cancelled' || outcome === 'conflict-remote' || outcome === 'adopted' || outcome === 'pulled') {
      // Dismissals and already-handled outcomes: re-lock the buttons to the
      // connection state but keep the specific status line that was set.
      syncRefreshSyncPanel({ keepStatus: true });
      try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
      return;
    }
    var now = new Date().toISOString();
    cfg.lastSyncAt = now;
    cfg.lastRemoteAt = localAt;
    cfg.lastSyncedHash = curHash;
    cfg.lastLocation = syncLocationKey(cfg);
    cfg.lastIdentity = syncTrustIdentity(cfg);
    cfg.locV = SYNC_LOC_V;
        syncSaveConfig(cfg);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    clearBanner();
    syncSetStatus('Synced ' + now.slice(0, 19).replace('T', ' ') + ' UTC.');
  }, function (err) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    // Auto-sync fails quietly into the status line (it retries on the next
    // change); only manual attempts raise the banner.
    if (auto) {
      syncSetStatus('Auto-sync will retry on the next change.');
      return;
    }
    showBanner('Sync failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((err && err.message) || err)]
    });
  });
}

function syncPullFlow() {
  if (syncBusy) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  var pass = rd.passphrase;
  if (!pass) {
    showBanner('Enter the sync passphrase to restore.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['The drive copy is encrypted — the passphrase never leaves this browser.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  syncSetBusy(true, 'Downloading from ' + syncProviderLabel(cfg.provider) + '…');
  // Snapshot first: importState() persists immediately, so a cancelled
  // restore must put the previous state back — the confirm is real.
  var beforeJson = null;
  try {
    beforeJson = exportState(loadState());
  } catch (e) {
    beforeJson = null;
  }
  var beforeAt = syncLocalExportedAt(beforeJson || '');
  syncRemoteDownload(cfg).then(function (remoteText) {
    return syncDecryptEnvelope(remoteText, pass);
  }).then(function (plain) {
    var next;
    try {
      next = importState(plain);
    } catch (e) {
      if (e && e.message === 'storage-unavailable') throw e;
      throw new Error('sync failed: the drive backup is invalid (' + String((e && e.message) || e).slice(0, 160) + ').');
    }
    syncSetBusy(false);
    // Stale-drive warning: restoring an older backup over newer local data
    // is usually a mistake (or a rollback) — say so explicitly.
    var stale = (syncCompareTimestamps(beforeAt, syncLocalExportedAt(plain)) === 'local-newer');
    return confirmAction(
      stale ? 'Drive copy is older' : 'Replace this device?',
      stale
        ? 'The drive backup is older than this device. Restore it anyway? This replaces all accounts, trades and settings on this device with the older copy.'
        : 'Restore the drive backup here? This replaces all accounts, trades and settings on this device.',
      stale ? 'Restore older copy' : 'Restore backup',
      true
    ).then(function (ok) {
      if (!ok) {
        if (beforeJson) {
          try {
            saveStateGuarded(JSON.parse(beforeJson));
          } catch (e2) { /* banner already shown by the guard on storage failure */ }
        }
        syncSetStatus('Restore cancelled.');
        syncRefreshSyncPanel({ keepStatus: true });
        try { syncRefreshHeaderIcon(); } catch (e3) { /* ignore */ }
        return 'cancelled';
      }
      if (!saveStateGuarded(next)) {
        syncRefreshSyncPanel({ keepStatus: true });
        try { syncRefreshHeaderIcon(); } catch (e4) { /* ignore */ }
        return 'failed';
      }
      cfg.lastSyncAt = new Date().toISOString();
      try {
        var d = JSON.parse(plain);
        if (d && typeof d.exportedAt === 'string') cfg.lastRemoteAt = d.exportedAt;
      } catch (e) { /* ignore */ }
      cfg.lastSyncedHash = syncHashOfExport(plain);
      cfg.lastLocation = syncLocationKey(cfg); // adopt: future pushes update this file
      cfg.locV = SYNC_LOC_V;
      cfg.lastIdentity = syncTrustIdentity(cfg);
            syncSaveConfig(cfg);
      syncRefreshSyncPanel();
      try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
      clearBanner();
      syncSetStatus('Restored from ' + syncProviderLabel(cfg.provider) + '.');
      refreshPrices();
      closeDialog('settings-dialog');
      return 'pulled';
    });
  }, function (err) {
    syncSetBusy(false);
    syncRefreshSyncPanel();
    showBanner('Restore failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((err && err.message) || err)]
    });
  });
}

function syncDownloadEncrypted() {
  if (syncBusy) return;
  var pass = uiVal('sy-pass', '');
  if (!pass) {
    showBanner('Enter a sync passphrase first — it encrypts the file.', 'error', {
      title: 'Encrypted file',
      lines: ['Type a passphrase in the Sync tab. It is never sent anywhere.']
    });
    return;
  }
  syncSetBusy(true, 'Encrypting…');
  syncEncryptEnvelope(exportState(loadState()), pass).then(function (env) {
    syncSetBusy(false);
    downloadTextFile('plutus.inoculens.com-' + backupStamp() + '.enc.json', env, 'application/json');
    clearBanner();
    syncSetStatus('Encrypted file downloaded. Keep it or upload it anywhere.');
  }, function (err) {
    syncSetBusy(false);
    showBanner('Encrypt failed.', 'error', {
      title: 'Encrypted file',
      lines: [String((err && err.message) || err)]
    });
  });
}

function syncRestoreEncryptedFile(file) {
  var pass = uiVal('sy-pass', '');
  if (!file) return;
  if (!pass) {
    showBanner('Enter the sync passphrase to open the file.', 'error', {
      title: 'Encrypted file',
      lines: ['The file is encrypted — the passphrase never leaves this browser.']
    });
    return;
  }
  var reader = new FileReader();
  reader.onload = function () {
    var beforeJson = null;
    try {
      beforeJson = exportState(loadState());
    } catch (e) {
      beforeJson = null;
    }
    syncDecryptEnvelope(String(reader.result), pass).then(function (plain) {
      var next;
      try {
        next = importState(plain);
      } catch (e) {
        if (e && e.message === 'storage-unavailable') {
          showBanner('Storage unavailable — change was not saved.', 'error', {
            title: 'Storage error',
            lines: ['Your data was left untouched. Free space or leave private mode, then retry.']
          });
          return;
        }
        showBanner('Import failed — your data was left untouched.', 'error', {
          title: 'Import error',
          lines: [String((e && e.message) || e)]
        });
        return;
      }
      confirmAction(
        'Replace this device?',
        'Restore this file here? This replaces all accounts, trades and settings on this device.',
        'Restore file',
        true
      ).then(function (ok) {
        if (!ok) {
          if (beforeJson) {
            try {
              saveStateGuarded(JSON.parse(beforeJson));
            } catch (e2) { /* banner already shown by the guard on storage failure */ }
          }
          syncSetStatus('Restore cancelled.');
          return;
        }
        if (!saveStateGuarded(next)) return;
        clearBanner();
        syncSetStatus('Restored from encrypted file.');
        refreshPrices();
        closeDialog('settings-dialog');
      });
    }, function (err) {
      showBanner('Import failed — your data was left untouched.', 'error', {
        title: 'Import error',
        lines: [String((err && err.message) || err)]
      });
    });
  };
  reader.onerror = function () {
    showBanner('Import failed — could not read the file.', 'error', {
      title: 'Import error',
      lines: ['Pick a Plutus encrypted backup (.enc.json) and retry.']
    });
  };
  reader.readAsText(file);
}

// --- Settings UI ---

function syncReadForm() {
  var cfg = syncLoadConfig();
  function val(id, fb) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    return el ? el.value : fb;
  }
  function checked(id, fb) {
    var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
    if (!el) return !!fb;
    return !!el.checked;
  }
  var prov = val('sy-provider', cfg.provider);
  if (syncIsProvider(prov)) cfg.provider = prov;
  if (cfg.provider === 'webdav') {
    cfg.url = val('sy-url', cfg.url);
    cfg.username = val('sy-user', cfg.username);
    cfg.filename = syncSanitizeFilename(val('sy-filename', cfg.filename));
    var pwField = val('sy-passwd', '');
    cfg.rememberPassword = checked('sy-remember', cfg.rememberPassword);
    if (cfg.rememberPassword) {
      if (pwField !== '') cfg.password = pwField;
    } else {
      cfg.password = '';
      if (pwField !== '') syncMemSecrets.password = pwField;
    }
  } else if (cfg.provider === 'megas3') {
    cfg.endpoint = val('sy-endpoint', cfg.endpoint);
    cfg.region = val('sy-region', cfg.region);
    cfg.bucket = val('sy-bucket', cfg.bucket);
    cfg.accessKey = val('sy-key', cfg.accessKey);
    cfg.objectKey = syncSanitizeFilename(val('sy-object', cfg.objectKey));
    cfg.folder = val('sy-folder3', cfg.folder);
    var skField = val('sy-skey', '');
    var rememberSk = checked('sy-remember2', cfg.rememberSecret);
    cfg.rememberSecret = rememberSk;
    if (rememberSk) {
      if (skField !== '') cfg.secretKey = skField;
    } else {
      cfg.secretKey = '';
      if (skField !== '') syncMemSecrets.secretKey = skField;
    }
  } else {
    cfg.clientId = val('sy-client', cfg.clientId);
    cfg.clientSecret = val('sy-secret', cfg.clientSecret);
    var fn = val('sy-filename2', cfg.filename);
    cfg.filename = syncSanitizeFilename(fn);
    cfg.folder = val('sy-folder2', cfg.folder);
  }
  var out = syncSanitizeConfig(cfg);
  out.autoSync = !!checked('sy-auto', cfg.autoSync);
  var formPass = val('sy-pass', '');
  var rememberPass = checked('sy-remember-pass', cfg.rememberPassphrase);
  out.rememberPassphrase = rememberPass;
  if (rememberPass) {
    if (formPass !== '') out.passphrase = formPass;
  } else {
    out.passphrase = '';
  }
  var passphrase = formPass || out.passphrase;
  return { cfg: out, passphrase: passphrase };
}

function syncPersistFormSecrets(cfg) {
  var el, memPw, memSk;
  if (typeof document === 'undefined') return;
  if (cfg.provider === 'webdav') {
    el = document.getElementById('sy-passwd');
    memPw = el ? el.value : '';
    if (cfg.rememberPassword) {
      if (memPw !== '') cfg.password = memPw;
      syncMemSecrets.password = '';
    } else {
      cfg.password = '';
      if (memPw !== '') syncMemSecrets.password = memPw;
    }
  }
  if (cfg.provider === 'megas3') {
    el = document.getElementById('sy-skey');
    memSk = el ? el.value : '';
    if (cfg.rememberSecret) {
      if (memSk !== '') cfg.secretKey = memSk;
      syncMemSecrets.secretKey = '';
    } else {
      cfg.secretKey = '';
      if (memSk !== '') syncMemSecrets.secretKey = memSk;
    }
  }
  syncSaveConfig(cfg);
}

function syncSetVal(id, v) {
  var el = (typeof document !== 'undefined') ? document.getElementById(id) : null;
  if (el) el.value = v;
}

function syncRefreshSyncPanel(opts) {
  if (typeof document === 'undefined') return;
  if (!document.getElementById('sy-provider')) return;
  var cfg = syncLoadConfig();
  syncSetVal('sy-provider', cfg.provider);
  var groups = { webdav: 'sy-g-webdav', gdrive: 'sy-g-oauth', dropbox: 'sy-g-oauth', megas3: 'sy-g-megas3' };
  var i, g;
  var ids = ['sy-g-webdav', 'sy-g-oauth', 'sy-g-megas3'];
  for (i = 0; i < ids.length; i++) {
    g = document.getElementById(ids[i]);
    if (g) g.hidden = (groups[cfg.provider] !== ids[i]);
  }
  var hint = document.getElementById('sy-hint');
  if (hint) hint.textContent = SYNC_HINTS[cfg.provider] || '';
  var sec = document.getElementById('sy-g-secret');
  if (sec) sec.hidden = (cfg.provider !== 'gdrive');
  var redir = document.getElementById('sy-redirect');
  if (redir) {
    var ru = syncRedirectUri();
    redir.textContent = (cfg.provider === 'webdav' || cfg.provider === 'megas3')
      ? ''
      : (ru || 'Open the hosted https:// page — OAuth cannot start from file://.');
  }
  var sharedNow = syncSharedId(cfg.provider);
  var note = document.getElementById('sy-oneclick-note');
  if (note) {
    note.textContent = sharedNow
      ? ('One-click sign-in is ready — just press Connect.' + (cfg.provider === 'gdrive' ? ' Google sessions last about an hour; reconnect when asked.' : ''))
      : 'One-click is not set up for this provider yet — expand the advanced box below to use your own OAuth app.';
  }
  var adv = document.getElementById('sy-adv');
  if (adv) {
    try { adv.open = !sharedNow; } catch (e) { /* ignore */ }
  }
  if (cfg.provider === 'webdav') {
    syncSetVal('sy-url', cfg.url);
    syncSetVal('sy-user', cfg.username);
    if (cfg.password) syncSetVal('sy-passwd', cfg.password);
    syncSetVal('sy-filename', syncDisplayBasename(cfg.filename));
    var rem = document.getElementById('sy-remember');
    if (rem) rem.checked = cfg.rememberPassword;
  } else if (cfg.provider === 'megas3') {
    syncSetVal('sy-endpoint', cfg.endpoint);
    syncSetVal('sy-region', cfg.region);
    syncSetVal('sy-bucket', cfg.bucket);
    syncSetVal('sy-key', cfg.accessKey);
    if (cfg.secretKey) syncSetVal('sy-skey', cfg.secretKey);
    syncSetVal('sy-object', syncDisplayBasename(cfg.objectKey));
    syncSetVal('sy-folder3', cfg.folder);
    var rem2 = document.getElementById('sy-remember2');
    if (rem2) rem2.checked = !!cfg.rememberSecret;
  } else {
    syncSetVal('sy-client', cfg.clientId);
    if (cfg.clientSecret) syncSetVal('sy-secret', cfg.clientSecret);
    syncSetVal('sy-filename2', syncDisplayBasename(cfg.filename));
    syncSetVal('sy-folder2', cfg.folder);
  }
  var connected = syncIsConnected(cfg);
  var autoBox = document.getElementById('sy-auto');
  if (autoBox) autoBox.checked = !!cfg.autoSync;
  if (cfg.passphrase) syncSetVal('sy-pass', cfg.passphrase);
  var rememberPassBox = document.getElementById('sy-remember-pass');
  if (rememberPassBox) rememberPassBox.checked = !!cfg.rememberPassphrase;
  var last = cfg.lastSyncAt ? (' Last sync ' + String(cfg.lastSyncAt).slice(0, 19).replace('T', ' ') + ' UTC.') : '';
  // keepStatus: early exits (cancel/dismiss/conflict) already set a specific
  // status line — refresh buttons + indicator but leave their message alone.
  var keepStatus = !!(opts && opts.keepStatus);
  if (!syncBusy && !keepStatus) syncSetStatus((connected ? ('Connected to ' + syncProviderLabel(cfg.provider) + '.') : 'Not connected.') + last);
  // Connection state is unmistakable on every visit: Connect locks once
  // established, Disconnect unlocks, and the status line turns green.
  // (While busy, syncSetBusy owns the disabled flags — don't fight it.)
  if (!syncBusy) {
    var connectBtn = document.getElementById('sy-connect');
    if (connectBtn) connectBtn.disabled = connected;
    var disconnectBtn = document.getElementById('sy-disconnect');
    if (disconnectBtn) disconnectBtn.disabled = !connected;
  }
  var statusEl = document.getElementById('sy-status');
  if (statusEl && statusEl.classList) {
    try {
      if (connected) statusEl.classList.add('sync-live');
      else statusEl.classList.remove('sync-live');
    } catch (e) { /* ignore */ }
  }
  var fp = document.getElementById('sy-fp');
  var passEl = document.getElementById('sy-pass');
  if (fp && passEl && passEl.value) {
    var v0 = passEl.value;
    syncFingerprint(v0).then(function (f) {
      var cur = document.getElementById('sy-pass');
      if (cur && cur.value === v0) {
        var fel = document.getElementById('sy-fp');
        if (fel) fel.textContent = 'Key fingerprint: ' + (f || '—') + ' (same on all devices = same passphrase)';
      }
    });
  } else if (fp) {
    fp.textContent = 'Key fingerprint: —';
  }
  try { syncToggleEncButtons(); } catch (e) { /* ignore */ }
}

function syncClearOAuthAttempt() {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SYNC_OAUTH_KEY);
  } catch (e) { /* ignore */ }
}

function syncPassphraseOrBanner() {
  var pass = '';
  try {
    var el = (typeof document !== 'undefined') ? document.getElementById('sy-pass') : null;
    pass = el ? el.value : '';
    if (!pass) {
      var cfg = syncLoadConfig();
      if (cfg.rememberPassphrase && cfg.passphrase) pass = cfg.passphrase;
    }
  } catch (e) { pass = ''; }
  if (!pass) {
    showBanner('Enter a sync passphrase first — sync only works encrypted.', 'error', {
      title: 'Sync needs a passphrase',
      lines: ['Type a passphrase in the Sync tab. It encrypts everything you upload and is never sent anywhere.']
    });
    return null;
  }
  return pass;
}

function syncStartOAuth() {
  if (syncBusy) return;
  if (!syncPassphraseOrBanner()) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  // WebDAV / MEGA have no OAuth dance: Connect simply tests the login.
  if (cfg.provider !== 'gdrive' && cfg.provider !== 'dropbox') {
    syncTestConnection();
    return;
  }
  if (!syncCryptoAvailable()) {
    showBanner('This browser cannot do encrypted sync (WebCrypto unavailable).', 'error', {
      title: 'Sync unavailable',
      lines: ['Use Download backup in the Backup & restore tab instead.']
    });
    return;
  }
  var shared = syncSharedId(cfg.provider);
  var clientId = shared || cfg.clientId;
  if (!clientId) {
    showBanner('One-click sign-in is not set up for ' + syncProviderLabel(cfg.provider) + ' yet.', 'error', {
      title: 'Connect',
      lines: ['Expand "Bring your own OAuth app" below, create an app with the provider, register the redirect URI shown, then paste its client ID.']
    });
    return;
  }
  if (cfg.provider === 'gdrive' && !shared && !cfg.clientSecret) {
    showBanner('Enter the OAuth client secret too (Google needs it for your own app).', 'error', {
      title: 'Connect',
      lines: ['Google Web-application clients always have a secret — paste it alongside the client ID.']
    });
    return;
  }
  // Google one-click uses Google's own sign-in library (loaded only now,
  // never on page load): no secret, no redirect URI, just your login.
  if (cfg.provider === 'gdrive' && shared) {
    syncPersistFormSecrets(cfg);
    syncSetBusy(true, 'Waiting for ' + syncProviderLabel(cfg.provider) + '…');
    syncGoogleOneClick(cfg).then(function (tok) {
      cfg.tokens = tok;
      syncSaveConfig(cfg);
      syncSetBusy(false);
      syncConnectThenSync();
    }, function (err) {
      syncSetBusy(false);
      syncRefreshSyncPanel();
      showBanner('Sign-in failed — your data was left untouched.', 'error', {
        title: 'Connect',
        lines: [String((err && err.message) || err)]
      });
    });
    return;
  }
  var redirect = syncRedirectUri();
  if (!redirect) {
    showBanner('OAuth needs the hosted https:// page.', 'error', {
      title: 'Connect',
      lines: ['Sign-in cannot start from a file:// window. Open your deployed site URL, then connect.']
    });
    return;
  }
  syncPersistFormSecrets(cfg);
  syncClearOAuthAttempt();
  syncSetBusy(true, 'Waiting for ' + syncProviderLabel(cfg.provider) + '…');
  syncPkcePair().then(function (pair) {
    var state = 'plutus-' + cfg.provider + '-' + syncB64UrlEncode(syncRandomBytes(12));
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SYNC_OAUTH_KEY, JSON.stringify({ state: state, verifier: pair.verifier, provider: cfg.provider }));
      }
    } catch (e) { /* ignore */ }
    var url = syncOAuthAuthUrl(cfg.provider, clientId, redirect, pair.challenge, state);
    var popup = null;
    try {
      popup = window.open(url, 'plutus-oauth', 'width=540,height=680');
    } catch (e) {
      popup = null;
    }
    if (!popup) {
      syncSetBusy(false);
      showBanner('Popup blocked — allow popups for this page, then try Connect again.', 'error', {
        title: 'Connect',
        lines: ['The drive sign-in opens in a popup window.']
      });
      return;
    }
    var done = false;
    var timer = null;
    function onMsg(e) {
      var d = e && e.data;
      if (!d || d.type !== 'plutus-oauth') return;
      try {
        if (e.origin !== window.location.origin) return;
      } catch (e2) { /* ignore */ }
      if (!d.state || d.state !== state) return;
      if (done) return;
      done = true;
      syncClearOAuthAttempt();
      try { window.removeEventListener('message', onMsg); } catch (e3) { /* ignore */ }
      try { if (timer) clearInterval(timer); } catch (e4) { /* ignore */ }
      if (d.error) {
        syncSetBusy(false);
        showBanner('Sign-in refused by the provider.', 'error', {
          title: 'Connect',
          lines: [String(d.error).slice(0, 200)]
        });
        return;
      }
      syncOAuthTokenExchange(cfg.provider, cfg, d.code, pair.verifier).then(function (tok) {
        cfg.tokens = tok;
        syncSaveConfig(cfg);
        syncSetBusy(false);
        syncConnectThenSync();
      }, function (err) {
        syncSetBusy(false);
        showBanner('Sign-in failed — your data was left untouched.', 'error', {
          title: 'Connect',
          lines: [String((err && err.message) || err)]
        });
      });
    }
    try { window.addEventListener('message', onMsg); } catch (e5) { /* ignore */ }
    timer = setInterval(function () {
      var closed = false;
      try { closed = !popup || popup.closed; } catch (e6) { closed = true; }
      if (closed) {
        try { clearInterval(timer); } catch (e7) { /* ignore */ }
        try { window.removeEventListener('message', onMsg); } catch (e8) { /* ignore */ }
        if (!done) {
          done = true;
          syncSetBusy(false);
          syncRefreshSyncPanel();
        }
      }
    }, 500);
  }, function () {
    syncSetBusy(false);
    showBanner('Could not start sign-in (WebCrypto unavailable).', 'error', {
      title: 'Connect',
      lines: ['Use Download backup in the Backup & restore tab instead.']
    });
  });
}

function syncDisconnect() {
  var cfg = syncLoadConfig();
  // Forget the whole connection: tokens, remembered passwords/keys and
  // session secrets — plus the location trust, so the next push treats the
  // destination as unknown and refuses to blindly overwrite it.
  // Boring config (provider, urls, names) stays.
  cfg.tokens = null;
  cfg.password = '';
  cfg.rememberPassword = false;
  cfg.secretKey = '';
  cfg.rememberSecret = false;
  cfg.passphrase = '';
  cfg.rememberPassphrase = false;
  cfg.lastLocation = null;
  cfg.locV = null;
  cfg.lastIdentity = null;
  cfg.lastSyncedHash = null;
  cfg.lastRemoteAt = null;
  cfg.lastSyncAt = null;
    syncMemSecrets.password = '';
  syncMemSecrets.secretKey = '';
  syncSaveConfig(cfg);
  syncClearOAuthAttempt();
  syncSetVal('sy-passwd', '');
  syncSetVal('sy-skey', '');
  syncSetVal('sy-pass', '');
  var rememberPassBox = (typeof document !== 'undefined') ? document.getElementById('sy-remember-pass') : null;
  if (rememberPassBox) rememberPassBox.checked = false;
  syncRefreshSyncPanel();
  try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  clearBanner();
}

// Google one-click sign-in via Google's own sign-in library. The script is
// loaded lazily on first Connect — never on page load — and only needs the
// public client ID: you just log in with Google, no app to register.
var syncGisLoading = null;

function syncLoadGis() {
  try {
    if (typeof window !== 'undefined' && window.google && window.google.accounts && window.google.accounts.oauth2) {
      return Promise.resolve(window.google.accounts.oauth2);
    }
  } catch (e) { /* ignore */ }
  if (syncGisLoading) return syncGisLoading;
  syncGisLoading = new Promise(function (resolve, reject) {
    try {
      if (typeof document === 'undefined') throw new Error('sync failed: cannot load Google sign-in here.');
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = function () {
        try {
          resolve(window.google.accounts.oauth2);
        } catch (e) {
          syncGisLoading = null;
          reject(new Error('sync failed: could not start Google sign-in.'));
        }
      };
      s.onerror = function () {
        syncGisLoading = null;
        reject(new Error('sync failed: could not load Google sign-in. Check your connection.'));
      };
      document.head.appendChild(s);
    } catch (e) {
      syncGisLoading = null;
      reject(e);
    }
  });
  return syncGisLoading;
}

function syncGoogleOneClick(cfg) {
  return syncLoadGis().then(function (oauth2) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = null;
      try {
        if (typeof setTimeout !== 'undefined') {
          timer = setTimeout(function () {
            if (done) return;
            done = true;
            reject(new Error('sync cancelled — the Google window was closed.'));
          }, 180000);
        }
      } catch (e) { /* ignore */ }
      function settle(fn, arg) {
        if (done) return;
        done = true;
        try { if (timer) clearTimeout(timer); } catch (e2) { /* ignore */ }
        fn(arg);
      }
      try {
        var client = oauth2.initTokenClient({
          client_id: syncSharedId('gdrive'),
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: function (resp) {
            if (resp && resp.access_token) settle(resolve, resp);
            else settle(reject, new Error('sync failed: Google sign-in gave no token.'));
          }
        });
        client.requestAccessToken({ prompt: 'consent' });
      } catch (e) {
        settle(reject, new Error('sync failed: could not start Google sign-in.'));
      }
    });
  }).then(function (resp) {
    var exp = Number(resp.expires_in);
    if (!isFinite(exp) || exp <= 0) exp = 3600;
    return { access: resp.access_token, refresh: '', expiry: Date.now() + exp * 1000 };
  });
}

// WebDAV / MEGA have no OAuth: Connect simply proves the login works.
// Both "backup found" and "no backup yet" mean the login is good.
// Connect only proves the login; the first real sync happens right here so
// users never stare at an empty drive wondering why nothing uploaded.
function syncConnectThenSync() {
  var st = null;
  try {
    st = loadState();
  } catch (e) {
    st = null;
  }
  if (!st || ((!st.accounts || !st.accounts.length) && (!st.trades || !st.trades.length))) {
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
    clearBanner();
    syncSetStatus('Connected — this wallet is empty. Restore from drive or add data, then sync.');
    return;
  }
  try {
    syncPushFlow();
  } catch (e) {
    showBanner('Sync failed — your data was left untouched.', 'error', {
      title: 'Sync error',
      lines: [String((e && e.message) || e)]
    });
  }
}

function syncTestConnection() {
  if (syncBusy) return;
  if (!syncPassphraseOrBanner()) return;
  var rd = syncReadForm();
  var cfg = rd.cfg;
  syncPersistFormSecrets(cfg);
  syncSetBusy(true, 'Checking connection…');
  return syncRemoteDownload(cfg).then(function () {
    syncSetBusy(false);
    syncSaveConfig(cfg);
    syncConnectThenSync();
  }, function (err) {
    syncSetBusy(false);
    var m = String((err && err.message) || err);
    if (m.indexOf('no backup found') !== -1) {
      syncSaveConfig(cfg);
      syncConnectThenSync();
      return;
    }
    syncRefreshSyncPanel();
    showBanner('Connection failed — your data was left untouched.', 'error', {
      title: 'Connect',
      lines: [m]
    });
  });
}

// The encrypted-file buttons need a passphrase to do anything, so they
// stay visibly disabled until one is typed (the flows keep their own
// guards as backstop).
function syncToggleEncButtons() {
  if (typeof document === 'undefined') return;
  var passEl = document.getElementById('sy-pass');
  var has = !!(passEl && passEl.value);
  var up = document.getElementById('sy-enc-upload');
  if (up) up.disabled = !has;
  var down = document.getElementById('sy-enc-download');
  if (down) down.disabled = !has;
}

function buildSyncSettings() {
  if (typeof document === 'undefined') return;
  var prov = document.getElementById('sy-provider');
  if (!prov || prov.getAttribute('data-wired')) return;
  prov.setAttribute('data-wired', '1');
  if (!syncCryptoAvailable()) {
    var st0 = document.getElementById('sy-status');
    if (st0) st0.textContent = 'Encrypted sync needs WebCrypto — this browser cannot do it. Use Download backup instead.';
  }
  prov.addEventListener('change', function () {
    var cfg = syncReadForm().cfg;
    syncSaveConfig(cfg);
    syncRefreshSyncPanel();
    try { syncRefreshHeaderIcon(); } catch (e) { /* ignore */ }
  });
  var autoBox = document.getElementById('sy-auto');
  if (autoBox && !autoBox.getAttribute('data-wired')) {
    autoBox.setAttribute('data-wired', '1');
    autoBox.addEventListener('change', function () {
      var cfg = syncReadForm().cfg;
      syncSaveConfig(cfg);
      syncRefreshSyncPanel();
      if (autoBox.checked) {
        syncSetStatus('Auto-sync on — changes upload a few seconds after you make them.');
      }
      try { syncScheduleAuto(); } catch (e) { /* ignore */ }
    });
  }
  var passEl = document.getElementById('sy-pass');
  if (passEl) {
    passEl.addEventListener('input', function () {
      var v = passEl.value || '';
      var fp = document.getElementById('sy-fp');
      if (!v) {
        if (fp) fp.textContent = 'Key fingerprint: —';
      } else {
        syncFingerprint(v).then(function (f) {
          var cur = document.getElementById('sy-pass');
          if (cur && cur.value === v) {
            var fel = document.getElementById('sy-fp');
            if (fel) fel.textContent = 'Key fingerprint: ' + (f || '—') + ' (same on all devices = same passphrase)';
          }
        });
      }
      try { syncToggleEncButtons(); } catch (e) { /* ignore */ }
    });
  }
  function wireBtn(id, fn) {
    var b = document.getElementById(id);
    if (b && !b.getAttribute('data-wired')) {
      b.setAttribute('data-wired', '1');
      b.addEventListener('click', fn);
    }
  }
  wireBtn('sy-connect', syncStartOAuth);
  wireBtn('sy-disconnect', syncDisconnect);
  wireBtn('sy-push', syncPushFlow);
  wireBtn('sy-pull', syncPullFlow);
  wireBtn('sy-enc-download', syncDownloadEncrypted);
  var up = document.getElementById('sy-enc-upload');
  if (up && !up.getAttribute('data-wired')) {
    up.setAttribute('data-wired', '1');
    up.addEventListener('change', function (e) {
      var input = e.target;
      var f = input && input.files && input.files[0];
      if (!f) return;
      syncRestoreEncryptedFile(f);
      try { input.value = ''; } catch (e2) { /* ignore */ }
    });
  }
  syncRefreshSyncPanel();
}

// Expose Sync on window.Inoculens for tests.html.
if (typeof window !== 'undefined') {
  window.Inoculens = window.Inoculens || {};
  window.Inoculens.SYNC_PROVIDERS = SYNC_PROVIDERS;
  window.Inoculens.SYNC_SHARED_APPS = SYNC_SHARED_APPS;
  window.Inoculens.syncB64encode = syncB64encode;
  window.Inoculens.syncB64decode = syncB64decode;
  window.Inoculens.syncB64UrlEncode = syncB64UrlEncode;
  window.Inoculens.syncUtf8Encode = syncUtf8Encode;
  window.Inoculens.syncUtf8Decode = syncUtf8Decode;
  window.Inoculens.syncEnvelopeWrap = syncEnvelopeWrap;
  window.Inoculens.syncEnvelopeParse = syncEnvelopeParse;
  window.Inoculens.syncIsEncryptedBackup = syncIsEncryptedBackup;
  window.Inoculens.syncCompareTimestamps = syncCompareTimestamps;
  window.Inoculens.syncProviderById = syncProviderById;
  window.Inoculens.syncIsProvider = syncIsProvider;
  window.Inoculens.syncJoinUrl = syncJoinUrl;
  window.Inoculens.syncSanitizeFilename = syncSanitizeFilename;
  window.Inoculens.syncDisplayBasename = syncDisplayBasename;
  window.Inoculens.syncNormalizeFolder = syncNormalizeFolder;
  window.Inoculens.syncLocationKey = syncLocationKey;
  window.Inoculens.syncTrustIdentity = syncTrustIdentity;
  window.Inoculens.syncIsTrustedLocation = syncIsTrustedLocation;
  window.Inoculens.syncConnectThenSync = syncConnectThenSync;
  window.Inoculens.syncRemoteExists = syncRemoteExists;
  window.Inoculens.syncRemoteEnsureFolder = syncRemoteEnsureFolder;
  window.Inoculens.syncDropboxFullPath = syncDropboxFullPath;
  window.Inoculens.syncWebdavMkdirP = syncWebdavMkdirP;
  window.Inoculens.syncDefaultConfig = syncDefaultConfig;
  window.Inoculens.syncSanitizeConfig = syncSanitizeConfig;
  window.Inoculens.syncCryptoAvailable = syncCryptoAvailable;
  window.Inoculens.syncEncryptEnvelope = syncEncryptEnvelope;
  window.Inoculens.syncDecryptEnvelope = syncDecryptEnvelope;
  window.Inoculens.syncFingerprint = syncFingerprint;
  window.Inoculens.syncSha256 = syncSha256;
  window.Inoculens.syncHmac = syncHmac;
  window.Inoculens.syncOAuthAuthUrl = syncOAuthAuthUrl;
  window.Inoculens.syncParseQuery = syncParseQuery;
  window.Inoculens.syncS3CanonicalRequest = syncS3CanonicalRequest;
  window.Inoculens.syncAmzDate = syncAmzDate;
  window.Inoculens.syncSplitUrl = syncSplitUrl;
  window.Inoculens.syncS3Url = syncS3Url;
  window.Inoculens.syncRequireHttpsUrl = syncRequireHttpsUrl;
  window.Inoculens.syncS3ErrorBody = syncS3ErrorBody;
  window.Inoculens.syncFetch = syncFetch;
  window.Inoculens.syncStateHash = syncStateHash;
  window.Inoculens.syncHashOfExport = syncHashOfExport;
  window.Inoculens.syncCurrentHash = syncCurrentHash;
  window.Inoculens.syncIsConnected = syncIsConnected;
  window.Inoculens.syncRefreshHeaderIcon = syncRefreshHeaderIcon;
  window.Inoculens.syncAutoPush = syncAutoPush;
  window.Inoculens.syncAutoDelay = syncAutoDelay;
  window.Inoculens.syncRefreshSyncPanel = syncRefreshSyncPanel;
  window.Inoculens.syncSharedId = syncSharedId;
  window.Inoculens.syncEffectiveClientId = syncEffectiveClientId;
  window.Inoculens.syncTestConnection = syncTestConnection;
  window.Inoculens.updateModalLock = updateModalLock;
  window.Inoculens.syncPostForm = syncPostForm;
  window.Inoculens.syncEnsureAccessToken = syncEnsureAccessToken;
  window.Inoculens.syncOAuthRefresh = syncOAuthRefresh;
  window.Inoculens.syncWebdavUpload = syncWebdavUpload;
  window.Inoculens.syncWebdavDownload = syncWebdavDownload;
  window.Inoculens.syncDriveUpload = syncDriveUpload;
  window.Inoculens.syncDriveDownload = syncDriveDownload;
  window.Inoculens.syncDriveFind = syncDriveFind;
  window.Inoculens.syncDropboxUpload = syncDropboxUpload;
  window.Inoculens.syncDropboxDownload = syncDropboxDownload;
  window.Inoculens.syncS3Put = syncS3Put;
  window.Inoculens.syncS3Get = syncS3Get;
  window.Inoculens.syncRemoteUpload = syncRemoteUpload;
  window.Inoculens.syncRemoteDownload = syncRemoteDownload;
  window.Inoculens.syncLoadConfig = syncLoadConfig;
  window.Inoculens.syncSaveConfig = syncSaveConfig;
  window.Inoculens.syncReadForm = syncReadForm;
  window.Inoculens.syncPushFlow = syncPushFlow;
  window.Inoculens.syncPullFlow = syncPullFlow;
  window.Inoculens.confirmAction3 = confirmAction3;
  window.Inoculens.syncDisconnect = syncDisconnect;
  window.Inoculens.showBanner = showBanner;
  window.Inoculens.clearBanner = clearBanner;
  window.Inoculens.openDialog = openDialog;
  window.Inoculens.closeDialog = closeDialog;
  window.Inoculens.flushSettingsAlertToBanner = flushSettingsAlertToBanner;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', syncHandleOAuthRedirect);
  }
}
