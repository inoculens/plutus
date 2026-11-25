'use strict';
// Number, money, quantity and percentage formatting for display.

function contrastText(hex) {
  var h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var r = parseInt(h.slice(0, 2), 16);
  var g = parseInt(h.slice(2, 4), 16);
  var b = parseInt(h.slice(4, 6), 16);
  if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return '#09090a';
  return ((r * 299 + g * 587 + b * 114) / 1000) >= 128 ? '#09090a' : '#ffffff';
}
var moneyFmtCache = dict();

function fmtEcbInText(s) {
  if (typeof s !== 'string') return s;
  var out = s.replace(/ECB-(\d{4})-(\d{2})-(\d{2})/g, function (_, y, m, d) { return 'ECB-' + fmtDateDmy(y + '-' + m + '-' + d); });
  out = out.replace(/Stooq-(\d{4})(\d{2})(\d{2})/g, function (_, y, m, d) { return 'Stooq-' + fmtDateDmy(y + '-' + m + '-' + d); });
  return out;
}

// Short human record code, derived deterministically from the stored trade
// id (djb2 pair, hex, first 6) — stable across reloads and synced devices,
// no migration, no renumbering on delete. Legacy trades without an id fall
// back to stable content so they still get a (shared-looking) code.
function tradeDisplayId(t) {
  var id = (typeof t === 'string') ? t : (t && t.id);
  var src;
  if (typeof id === 'string' && id.length > 0) {
    src = id;
  } else {
    src = [t && t.date, t && t.type, t && t.symbol, t && t.qty, t && t.total, t && t.accountId].join('|');
  }
  var h = '';
  try {
    h = syncStateHash(src).replace(/-/g, '').toUpperCase();
  } catch (e) { h = ''; }
  while (h.length < 6) h += '0';
  return '#' + h.slice(0, 6);
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

// Stablecoins (USDC/USDT/DAI) and any other non-ISO code are not currencies
// Intl can symbolise: USDC throws, and moneyFmt's catch would silently fall
// back to a EUR formatter, printing the right number under the wrong symbol.
// Those amounts show as "233.05 USDC" (same shape as the Fee row) so the
// record always names the unit it was actually paid in.
var codeAmtFmt = null;

function isCodeSuffixed(code) {
  if (!code) return false;
  return stableToUsd(code) || !/^[A-Z]{3}$/.test(code);
}

function fmtMoney(n, currency) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  var code = String(currency || '').toUpperCase();
  if (isCodeSuffixed(code)) {
    try {
      if (!codeAmtFmt) codeAmtFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return codeAmtFmt.format(v) + ' ' + code;
    } catch (e) {
      return (Math.round(v * 100) / 100).toFixed(2) + ' ' + code;
    }
  }
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

var btcQtyFmt = null;
var xmrQtyFmt = null;

function fmtQty(n, symbol) {
  var s = String(symbol || '').trim().toUpperCase();
  // EVM-standard assets (18 decimals, wei units): quantities print the exact
  // digits from the exact core over the stored string/number — never a float
  // pass — with the 18-dec ZERO PADDING trimmed, so rows keep every
  // significant digit but stop stretching the facts strip out of line with
  // its fiat neighbours (Fee etc.). Anything still too long cuts with the
  // ellipsis and the overflow popup hands over the full exact string.
  if (s !== '' && typeof SYMBOL_MAP === 'object' && SYMBOL_MAP && SYMBOL_MAP[s] && s !== 'BTC' && s !== 'XMR') {
    var scStr = (typeof n === 'number') ? exactScaledOf(String(n), 18) : exactScaledOf(n, 18);
    if (scStr !== null) return exactToStringTrim(scStr, 18);
  }
  var v = Number(n);
  if (!isFinite(v)) return '—';
  // BTC always shows all 8 decimals (satoshis): 0.1 -> 0.10000000,
  // 1 -> 1.00000000. XMR always shows all 12 decimals (piconero):
  // 0.1 -> 0.100000000000. Other assets keep trimmed display.
  if (s === 'BTC') {
    try {
      if (!btcQtyFmt) btcQtyFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 8, maximumFractionDigits: 8 });
      return btcQtyFmt.format(v);
    } catch (e) {
      return v.toFixed(8);
    }
  }
  if (s === 'XMR') {
    try {
      if (!xmrQtyFmt) xmrQtyFmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 12, maximumFractionDigits: 12 });
      return xmrQtyFmt.format(v);
    } catch (e) {
      return v.toFixed(12);
    }
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(v);
}

function fmtPct(n) {
  var v = Number(n);
  if (!isFinite(v)) return '—';
  return (Math.round(v * 100) / 100) + '%';
}
