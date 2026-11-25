'use strict';
// Price identity: which price key a ticker uses. A ticker held under one asset
// kind keeps its bare key; a ticker held under several kinds (e.g. a stock and a
// crypto both called "W") is priced as KIND:SYM. Also native quantity decimals.

// Coins on their own chain (not EVM tokens) keep their real on-chain
// precision; every other SYMBOL_MAP ticker is an EVM-style 18-decimal asset.
var QTY_NATIVE_DECIMALS = {
  BTC: 8, XMR: 12, SOL: 9, LTC: 8, BCH: 8, DOGE: 8, XRP: 6, ADA: 6, DOT: 10,
  ATOM: 6, XLM: 7, TRX: 6, NEAR: 24, TON: 9, ICP: 8, HBAR: 8, KAS: 8, ZEC: 8,
  DASH: 8, XTZ: 6, EOS: 4, KSM: 12, ALGO: 6, KAVA: 6, FLOW: 8, HNT: 8, SUI: 9,
  APT: 8, SEI: 6, TIA: 6, STX: 6, RUNE: 8, TAO: 9, JUP: 6, PYTH: 6, WIF: 6,
  BONK: 5, RAY: 6, ORCA: 6, AR: 12
};
// Tickers held in stock/commodity accounts (W, OP, AR, ...) must never pick
// up a same-named crypto's precision. Rebuilt whenever accounts load/save.
var QTY_NON_CRYPTO = {};

// --- Price identity ---
// A ticker alone is not a unique asset: the same symbol can be a coin in one
// account and a stock in another (W, OP, AR, ...). Prices are keyed by the
// bare ticker (SYM) -- unless the portfolio holds that ticker under more than
// one asset kind, in which case every price for it is keyed KIND:SYM
// (e.g. STOCK:W, CRYPTO:W) so the two can never share or overwrite a price.
// Rebuilt whenever accounts load/save (noteSymbolKinds).
var PRICE_KIND_BY_ACCOUNT = dict(); // accountId -> normalized kind
var PRICE_KINDS_BY_SYMBOL = {}; // SYM -> { kind: true } for every held kind
var PRICE_COLLISIONS = {};      // SYM -> true when held under 2+ kinds
var PRICE_KIND_NAMES = ['CRYPTO', 'STOCK', 'COMMODITY', 'CASH', 'CUSTOM'];

function normPriceKind(kind) {
  var k = String(kind === undefined || kind === null ? '' : kind).trim().toLowerCase();
  return (k === 'stock' || k === 'commodity' || k === 'cash' || k === 'custom') ? k : 'crypto';
}

// Price key for a symbol held under `kind`: bare SYM unless the ticker is
// shared by several kinds.
function priceKeyOf(sym, kind) {
  var up = String(sym === undefined || sym === null ? '' : sym).trim().toUpperCase();
  if (!up) return up;
  return PRICE_COLLISIONS[up] ? normPriceKind(kind).toUpperCase() + ':' + up : up;
}

function priceKeyForAccount(sym, accountId) {
  return priceKeyOf(sym, PRICE_KIND_BY_ACCOUNT[accountId]);
}

// "STOCK:W" -> {sym:'W', kind:'stock'}; anything else (plain ticker) -> null.
function splitPriceKey(key) {
  var m = /^([A-Z]+):([A-Z0-9._-]+)$/.exec(String(key === undefined || key === null ? '' : key));
  if (!m || PRICE_KIND_NAMES.indexOf(m[1]) === -1) return null;
  return { sym: m[2], kind: m[1].toLowerCase() };
}

// Live price for `sym` as held in `accountId`. A shared ticker only ever
// reads its own kind-qualified entry -- never the bare ticker, which could be
// another asset's price -- so an unresolved price stays unknown (null).
function livePriceFor(live, sym, accountId) {
  if (!live) return undefined;
  var up = String(sym === undefined || sym === null ? '' : sym).trim().toUpperCase();
  if (up && PRICE_COLLISIONS[up]) return live[priceKeyForAccount(up, accountId)];
  return live[sym] !== undefined ? live[sym] : live[up];
}

function noteSymbolKinds(accounts, trades) {
  symbolKindsSource = null;
  var next = {};
  var crypto = {};
  var kindByAccount = dict();
  var kindsBySym = {};
  function noteKind(sym, kind) {
    var up = String(sym === undefined || sym === null ? '' : sym).trim().toUpperCase();
    if (!up) return;
    if (!kindsBySym[up]) kindsBySym[up] = {};
    kindsBySym[up][normPriceKind(kind)] = true;
  }
  (Array.isArray(accounts) ? accounts : []).forEach(function (a) {
    if (!a) return;
    if (a.id !== undefined && a.id !== null) kindByAccount[a.id] = normPriceKind(a.kind);
    if (a.ticker === undefined || a.ticker === null) return;
    var t = String(a.ticker).trim().toUpperCase();
    var k = String(a.kind || '').trim().toLowerCase();
    if (k === 'stock' || k === 'commodity') next[t] = true;
    else if (k === 'crypto') crypto[t] = true;
    noteKind(t, a.kind);
  });
  // Liability-only assets participate in kind-qualified price identity too.
  (Array.isArray(accounts) ? accounts : []).forEach(function (account) {
    if (!account) return;
    accountDebtPositions(account).forEach(function (position) {
      var debtTicker = String(position.assetTicker || account.ticker || '').trim().toUpperCase();
      var debtKind = String(position.assetKind || account.kind || 'crypto').trim().toLowerCase();
      if (!debtTicker) return;
      if (debtKind === 'stock' || debtKind === 'commodity') next[debtTicker] = true;
      else if (debtKind === 'crypto') crypto[debtTicker] = true;
      noteKind(debtTicker, debtKind);
    });
  });
  Object.keys(crypto).forEach(function (t) { delete next[t]; });
  QTY_NON_CRYPTO = next;
  // Trade symbols inherit their account's kind.
  (Array.isArray(trades) ? trades : []).forEach(function (tr) {
    if (!tr || !tr.symbol || tr.accountId === undefined || tr.accountId === null) return;
    if (!Object.prototype.hasOwnProperty.call(kindByAccount, tr.accountId)) return;
    noteKind(tr.symbol, kindByAccount[tr.accountId]);
  });
  var collisions = {};
  Object.keys(kindsBySym).forEach(function (sym) {
    if (Object.keys(kindsBySym[sym]).length > 1) collisions[sym] = true;
  });
  PRICE_KIND_BY_ACCOUNT = kindByAccount;
  PRICE_KINDS_BY_SYMBOL = kindsBySym;
  PRICE_COLLISIONS = collisions;
}
