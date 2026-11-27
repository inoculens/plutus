'use strict';
// Records (trades): types, field validators, import validation and the
// normalized stored shape. Price override values are validated here too.

var TRADE_TYPES = ['buy', 'sell', 'transfer', 'income', 'expense'];
// UI-only type list: swaps are stored as two linked buy/sell legs, but the
// record list and its filter must present them as one Swap type.
var TRADE_UI_TYPES = TRADE_TYPES.concat(['swap']);

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

function numGte0(v, allowEmpty) {
  if (v === undefined || v === null || String(v).trim() === '') return allowEmpty ? null : false;
  if (typeof v !== 'number' && typeof v !== 'string') return false;
  var n = Number(v);
  if (!isFinite(n) || n < 0) return false;
  return n;
}

// Swap fiat value, auto-calculated: the sent quantity at the historical
// price of the sent asset on the swap date (the received side is the
// fallback), in the swap currency. Resolves to a positive number, or null
// when no historical price is known — callers then ask for a manual value;
// a guessed or zero value is never stored.
function swapAutoFiatValue(fromSym, fromQty, fromKind, toSym, toQty, toKind, date, ccy) {
  function side(sym, qty, kind) {
    return fetchHistoricalPrice(sym, date, ccy, kind).then(function (r) {
      var price = (r && typeof r === 'object') ? r.price : r;
      var v = Number(qty) * Number(price);
      return (isFinite(v) && v > 0) ? v : null;
    }, function () { return null; });
  }
  return side(fromSym, fromQty, fromKind).then(function (v) {
    if (v !== null) return v;
    return side(toSym, toQty, toKind);
  }).then(function (v) {
    if (v === null) return null;
    var r2 = Math.round(v * 100) / 100;
    return r2 > 0 ? r2 : Number(v.toPrecision(4));
  });
}

// Transaction IDs are user-provided reference metadata, not validated hashes.
// Accept any string (including short IDs, punctuation, spaces and exchange
// references). BTC records may offer a mempool.space link; other assets only
// expose the copy action. Missing values remain valid.
function isValidTxid(v) {
  if (v === undefined || v === null) return true;
  return typeof v === 'string' || typeof v === 'number';
}

function isValidImportTrade(t, accountIds, accounts) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  if (TRADE_TYPES.indexOf(t.type) === -1) return false;
  if (!isValidSymbolCode(t.symbol)) return false;
  if (!isValidDateStr(t.date)) return false;
  if (isFutureEverywhereDateStr(t.date)) return false;
  // fee (fiat) is always optional >= 0 when present
  var feeChk = numGte0(t.fee, true);
  if (feeChk === false) return false;
  if (t.feeCurrency !== undefined && t.feeCurrency !== null && String(t.feeCurrency).trim() !== '') {
    if (!isValidCurrencyCode(t.feeCurrency)) return false;
  }
  // txid is optional reference metadata; any string/number is accepted.
  if (!isValidTxid(t.txid)) return false;
  // attachment (invoice/receipt) is optional metadata; plain trades without
  // it must keep validating — when present it must be well-formed
  if (t.attachment !== undefined && t.attachment !== null && !isValidAttachment(t.attachment)) return false;
  // ledger code + label are optional bookkeeping metadata (cash records);
  // when present they must be well-formed, on every trade type
  if (!isValidLedgerCode(t.ledger)) return false;
  if (!isValidLedgerLabel(t.ledgerLabel)) return false;
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
    if (transferSourcesStructuralError(t, accountIds, accounts)) return false;
    var sourceIds = transferSourceIdsOfRaw(t);
    var sourceOverlapAllowed = Array.isArray(t.sources) && t.sources.length > 1;
    if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
      var tt = Number(t.total);
      if (!isFinite(tt) || tt < 0) return false;
    }
    if (t.currency !== undefined && t.currency !== null && String(t.currency).trim() !== '') {
      if (!isValidCurrencyCode(t.currency)) return false;
    }
    // Recipients: either the legacy single destination below, or `outputs`
    // (one entry per recipient of the same tx). Both at once are rejected
    // so stored records always have a single source of truth. Without either
    // the transfer is an on-chain move inside the same account (e.g.
    // sweeping to a fresh address), where only the network fee is lost.
    var hasOutputs = Array.isArray(t.outputs) && t.outputs.length > 0;
    if (hasOutputs) {
      if (t.outputs.length > TRANSFER_MAX_OUTPUTS) return false;
      var hasToBoth = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
      if (hasToBoth) return false;
      if (t.toQty !== undefined && t.toQty !== null && String(t.toQty).trim() !== '') return false;
      if (t.toSymbol !== undefined && t.toSymbol !== null && String(t.toSymbol).trim() !== '') return false;
      for (var oi = 0; oi < t.outputs.length; oi++) {
        if (!isValidTransferOutput(t.outputs[oi], t.symbol, sourceOverlapAllowed ? null : t.accountId, accountIds, sourceOverlapAllowed ? null : sourceIds)) return false;
      }
      var selfQ = 0;
      if (t.selfQty !== undefined && t.selfQty !== null && String(t.selfQty).trim() !== '') {
        if (typeof t.selfQty !== 'number' && typeof t.selfQty !== 'string') return false;
        selfQ = Number(t.selfQty);
        if (!isFinite(selfQ) || selfQ < 0) return false;
      }
      var sums = transferOutputsSum(t.outputs);
      if (Math.abs(sums.qty + selfQ + tnf - tq) > 1e-8) return false; // sent = recipients + received back + fee
      if (sums.fee - tnf > 1e-12) return false; // attributed row fees ride inside the tx fee
    } else {
    // Cross-fiat cash moves carry the received amount (toQty) plus the
    // destination fiat (toSymbol); same-fiat moves derive it from the fee.
    if (t.toQty !== undefined && t.toQty !== null && String(t.toQty).trim() !== '') {
      if (typeof t.toQty !== 'number' && typeof t.toQty !== 'string') return false;
      var tto = Number(t.toQty);
      if (!isFinite(tto) || tto <= 0) return false;
    }
    if (t.toSymbol !== undefined && t.toSymbol !== null && String(t.toSymbol).trim() !== '') {
      if (!isValidSymbolCode(t.toSymbol)) return false;
    }
    // A cross-fiat arrival names its destination fiat: the converted amount
    // is then required (a missing toQty would credit zero silently).
    var hasToSym = t.toSymbol !== undefined && t.toSymbol !== null && String(t.toSymbol).trim() !== '';
    if (hasToSym && String(t.toSymbol).trim().toUpperCase() !== String(t.symbol).trim().toUpperCase()) {
      if (t.toQty === undefined || t.toQty === null || String(t.toQty).trim() === '') return false;
    }
    var hasTo = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
    if (accountIds !== undefined) {
      if (!Array.isArray(accountIds)) return false;
      if (typeof t.accountId !== 'string' || t.accountId.length === 0) return false;
      if (hasTo && typeof t.toAccountId !== 'string') return false;
      if (accountIds.indexOf(t.accountId) === -1) return false;
      if (hasTo) {
        if (t.accountId === t.toAccountId) return false;
        if (accountIds.indexOf(t.toAccountId) === -1) return false;
        if (sourceIds.indexOf(String(t.toAccountId).trim()) !== -1) return false;
      }
    } else {
      if (typeof t.accountId !== 'string' || !t.accountId) return false;
      if (hasTo && typeof t.toAccountId !== 'string') return false;
      if (hasTo && t.accountId === t.toAccountId) return false;
      if (hasTo && sourceIds.indexOf(String(t.toAccountId).trim()) !== -1) return false;
    }
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
  // buy / sell (legacy strict path)
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
  for (var k in t) {
    if (!Object.prototype.hasOwnProperty.call(t, k)) continue;
    // A "__proto__" key from a file is plain data (JSON.parse keeps it as an
    // own key): plain assignment would make it the record's prototype and the
    // record would inherit its fields (e.g. a swapId).
    if (k === '__proto__') Object.defineProperty(c, k, { value: t[k], writable: true, enumerable: true, configurable: true });
    else c[k] = t[k];
  }
  if (typeof c.symbol === 'string') c.symbol = c.symbol.trim().toUpperCase();
  if (typeof c.ledger === 'string' && c.ledger.trim() !== '') c.ledger = c.ledger.trim();
  if (typeof c.ledgerLabel === 'string' && c.ledgerLabel.trim() !== '') c.ledgerLabel = c.ledgerLabel.trim();
  if (typeof c.toSymbol === 'string' && c.toSymbol.trim() !== '') c.toSymbol = c.toSymbol.trim().toUpperCase();
  if (typeof c.currency === 'string' && c.currency.trim() !== '') c.currency = c.currency.trim().toUpperCase();
  if (typeof c.feeCurrency === 'string' && c.feeCurrency.trim() !== '') c.feeCurrency = c.feeCurrency.trim().toUpperCase();
  if (typeof c.txid === 'string' && c.txid.trim() !== '') c.txid = c.txid.trim();
  // Duplicate-tx confirmation (js/data/tx-duplicates.js): only `true` means
  // anything; any other value is dropped so the warning stays on.
  if (c.txidDupOk !== undefined && c.txidDupOk !== true) { try { delete c.txidDupOk; } catch (e) { c.txidDupOk = undefined; } }
  // Normalize only exact valid source lists. Malformed explicit lists remain
  // explicit so accounting functions fail closed rather than falling back.
  if(c.sources!==undefined&&c.sources!==null){
    if(c.type==='transfer'){
      var __validSources=transferSourcesOf(c);
      if(__validSources&&__validSources.length>1){
        c.sources=__validSources.map(function(s){var n={accountId:s.accountId,qty:s.qtyRaw};if(s.fee>0)n.fee=s.feeRaw;return n;});
        if(Array.isArray(c.sourceFeeAuto)&&c.sourceFeeAuto.length===__validSources.length&&c.sourceFeeAuto.every(function(v){return typeof v==='boolean';}))c.sourceFeeAuto=c.sourceFeeAuto.slice();
        else{try{delete c.sourceFeeAuto;}catch(e){c.sourceFeeAuto=undefined;}}
      }else if(__validSources&&__validSources.length===1){try{delete c.sources;}catch(e){c.sources=undefined;}try{delete c.sourceFeeAuto;}catch(e){c.sourceFeeAuto=undefined;}}
      else{try{delete c.sourceFeeAuto;}catch(e){c.sourceFeeAuto=undefined;}}
    }else{try{delete c.sources;}catch(e){c.sources=undefined;}try{delete c.sourceFeeAuto;}catch(e){c.sourceFeeAuto=undefined;}}
  }
  // Multi-recipient transfers: normalize rows (trim labels, uppercase the
  // arrival fiat); an empty list degrades to the legacy shape. Legacy
  // single-dest fields never coexist with outputs (single source of truth).
  if (c.outputs !== undefined && c.outputs !== null) {
    if (Array.isArray(c.outputs)) {
      var __outs = [];
      c.outputs.forEach(function (o) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) return;
        var n = {};
        if (typeof o.toAccountId === 'string' && o.toAccountId.trim() !== '') n.toAccountId = o.toAccountId.trim();
        if (typeof o.label === 'string' && o.label.trim() !== '') n.label = o.label.trim().slice(0, TRANSFER_LABEL_MAX);
        n.qty = o.qty;
        if (o.fee !== undefined && o.fee !== null && String(o.fee).trim() !== '') n.fee = o.fee;
        if (o.spend === false) n.spend = false;
        if (typeof o.toSymbol === 'string' && o.toSymbol.trim() !== '') n.toSymbol = o.toSymbol.trim().toUpperCase();
        if (o.toQty !== undefined && o.toQty !== null && String(o.toQty).trim() !== '') n.toQty = o.toQty;
        __outs.push(n);
      });
      if (__outs.length) {
        c.outputs = __outs;
        try { delete c.toAccountId; } catch (e) { c.toAccountId = undefined; }
        try { delete c.toQty; } catch (e) { c.toQty = undefined; }
        try { delete c.toSymbol; } catch (e) { c.toSymbol = undefined; }
      } else {
        try { delete c.outputs; } catch (e) { c.outputs = undefined; }
      }
    } else {
      try { delete c.outputs; } catch (e) { c.outputs = undefined; }
    }
  }
  // selfQty belongs to multi-output transfers only; legacy records keep their
  // derived sent - fee shape and never gain the field.
  if (Array.isArray(c.outputs) && c.outputs.length) {
    // selfQty keeps its exact digits (number when it round-trips, digit
    // string otherwise) — a float pass-through could corrupt the last wei.
    var __self = (c.selfQty === undefined || c.selfQty === null || String(c.selfQty).trim() === '') ? NaN : exactQtyValue(c.selfQty, c.symbol);
    if (isFinite(Number(__self)) && Number(__self) > 0) c.selfQty = __self;
    else { try { delete c.selfQty; } catch (e2) { c.selfQty = undefined; } }
  } else {
    try { delete c.selfQty; } catch (e3) { c.selfQty = undefined; }
  }
  if (c.attachment !== undefined && c.attachment !== null && isValidAttachment(c.attachment)) {
    c.attachment = { name: String(c.attachment.name).trim(), mime: String(c.attachment.mime), size: Number(c.attachment.size), hash: String(c.attachment.hash).toLowerCase() };
  } else if (c.attachment !== undefined && (c.attachment === null || !isValidAttachment(c.attachment))) {
    try { delete c.attachment; } catch (e) { c.attachment = undefined; }
  }
  // Record color (bulk recolor of trade cards): valid hex only, uppercase.
  // Invalid values are dropped so a bad import can never paint a card.
  if (c.color !== undefined && c.color !== null) {
    if (isValidHexColor(c.color)) c.color = String(c.color).trim().toUpperCase();
    else { try { delete c.color; } catch (e) { c.color = undefined; } }
  }
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
