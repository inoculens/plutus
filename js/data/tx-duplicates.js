'use strict';
// Duplicate transaction IDs. One on-chain transaction normally lives in ONE
// record: an internal transfer is a single record that shows under every
// account it touches (sources and destinations), and a swap's two legs carry
// different assets. So a tx ID that sits on two records of the same asset is
// most likely the same transaction entered twice.
//
// Scope: per asset (symbol), across every account. Cash (fiat) accounts are
// skipped: bank references are short and not unique. A swap's own legs count
// as one record.
//
// Real splits exist (a reward withdrawal booked as income + transfer in one
// tx, a batched payout to two of your wallets, an order filled in parts).
// The owner confirms those: `txidDupOk: true` on every record of the group
// silences the warning; removing it from the group brings the warning back.

// Comparable form of a tx ID: trimmed; hex hashes (Bitcoin-family, 0x… EVM)
// are case-insensitive, any other format (base58, exchange ids) keeps case.
function txidDupNorm(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  var s = String(v).trim();
  if (s === '') return '';
  if (/^(0x)?[0-9a-f]+$/i.test(s)) return s.toLowerCase();
  return s;
}

function txidDupKindMap(st) {
  var out = {};
  var list = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (a && typeof a.id === 'string') out[a.id] = a.kind;
  }
  return out;
}

// Group key of a record ('' when it takes no part in the check).
function txidDupKey(symbol, txid, accountId, kindById) {
  var id = txidDupNorm(txid);
  if (id === '') return '';
  var sym = String(symbol === undefined || symbol === null ? '' : symbol).trim().toUpperCase();
  if (sym === '') return '';
  if (kindById && isCashKind(kindById[accountId])) return '';
  return sym + '\n' + id;
}

function txidDupKeyOfTrade(t, kindById) {
  if (!t || typeof t !== 'object') return '';
  return txidDupKey(t.symbol, t.txid, t.accountId, kindById);
}

// Records count once per swap: both legs of one swap are one record.
function txidDupUnit(t) {
  return (typeof t.swapId === 'string' && t.swapId !== '') ? 's:' + t.swapId : 'r:' + t.id;
}

// Index of every duplicate group in a state: byKey[key] = [trade, ...] and
// byId[tradeId] = key, only for keys held by two or more records. Linear in
// the record count; memoized on the (immutable, shared) peekState arrays.
var txidDupMemo = { trades: null, accounts: null, idx: null };
function txidDupIndex(st) {
  var trades = (st && Array.isArray(st.trades)) ? st.trades : [];
  var accounts = (st && Array.isArray(st.accounts)) ? st.accounts : [];
  if (txidDupMemo.idx && txidDupMemo.trades === trades && txidDupMemo.accounts === accounts) return txidDupMemo.idx;
  var kinds = txidDupKindMap(st);
  var all = {};
  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    var k = txidDupKeyOfTrade(t, kinds);
    if (!k) continue;
    if (!all[k]) all[k] = [];
    all[k].push(t);
  }
  var idx = { byKey: {}, byId: {} };
  Object.keys(all).forEach(function (k) {
    var list = all[k];
    if (list.length < 2) return;
    var units = {};
    var n = 0;
    list.forEach(function (t) { var u = txidDupUnit(t); if (!units[u]) { units[u] = true; n++; } });
    if (n < 2) return;
    idx.byKey[k] = list;
    list.forEach(function (t) { idx.byId[t.id] = k; });
  });
  txidDupMemo = { trades: trades, accounts: accounts, idx: idx };
  return idx;
}

// A group warns until every record in it carries the owner's confirmation.
function txidDupGroupOpen(list) {
  for (var i = 0; i < (list || []).length; i++) if (!list[i] || list[i].txidDupOk !== true) return true;
  return false;
}

// Duplicate status of one saved record: null when it is in no group, else
// { key, open, records } (records = the whole group, this one included).
function txidDupStatus(st, tradeId) {
  var idx = txidDupIndex(st);
  var k = idx.byId[tradeId];
  if (!k) return null;
  var list = idx.byKey[k];
  return { key: k, open: txidDupGroupOpen(list), records: list.slice() };
}

// Save-time check. drafts: [{ symbol, txid, accountId, prevId? }] — prevId is
// the stored record the draft replaces (edits). Drafts whose key did not
// change on an edit are not checked again (their status shows on the card).
// excludeIds: records being replaced by this save (never matched).
// Returns [{ key, symbol, matches: [trade, ...], draft }] for drafts that
// collide (draft: the form's own record, shown as "this record").
function txidDupMatches(st, drafts, excludeIds) {
  var kinds = txidDupKindMap(st);
  var trades = (st && Array.isArray(st.trades)) ? st.trades : [];
  var skip = {};
  (excludeIds || []).forEach(function (id) { if (id) skip[id] = true; });
  var byId = {};
  trades.forEach(function (t) { if (t && t.id) byId[t.id] = t; });
  var out = [];
  var seen = {};
  (drafts || []).forEach(function (d) {
    if (!d) return;
    var k = txidDupKey(d.symbol, d.txid, d.accountId, kinds);
    if (!k || seen[k]) return;
    var prev = d.prevId ? byId[d.prevId] : null;
    if (prev && txidDupKeyOfTrade(prev, kinds) === k) return;
    var matches = trades.filter(function (t) { return t && !skip[t.id] && txidDupKeyOfTrade(t, kinds) === k; });
    if (!matches.length) return;
    seen[k] = true;
    out.push({ key: k, symbol: String(d.symbol).trim().toUpperCase(), matches: matches, draft: d });
  });
  return out;
}

// Stable identity of a save-time warning: the same collision confirmed once
// passes on the resubmit, a different one asks again.
function txidDupSignature(hits) {
  return (hits || []).map(function (h) {
    return h.key + '=' + h.matches.map(function (t) { return t.id; }).sort().join(',');
  }).sort().join('|');
}

// Applies the confirmation to a state about to be saved. saved: the records
// this save writes (already in st.trades). ackKeys: keys the owner confirmed
// with Save anyway — every record of those groups is marked. prevById: the
// stored records the save replaces; an edit that keeps its key keeps its
// mark, any other record starts unmarked.
function txidDupStamp(st, saved, ackKeys, prevById) {
  var kinds = txidDupKindMap(st);
  var acks = ackKeys || {};
  var prevs = prevById || {};
  (saved || []).forEach(function (r) {
    if (!r) return;
    var k = txidDupKeyOfTrade(r, kinds);
    var prev = prevs[r.id];
    if (k && acks[k]) r.txidDupOk = true;
    else if (k && prev && prev.txidDupOk === true && txidDupKeyOfTrade(prev, kinds) === k) r.txidDupOk = true;
    else { try { delete r.txidDupOk; } catch (e) { r.txidDupOk = undefined; } }
  });
  Object.keys(acks).forEach(function (k) {
    if (!acks[k]) return;
    (st.trades || []).forEach(function (t) { if (t && txidDupKeyOfTrade(t, kinds) === k) t.txidDupOk = true; });
  });
}

// Ignore (on = true) or bring back (on = false) the warning of a group.
// Returns the number of records changed.
function txidDupSetIgnored(st, key, on) {
  var kinds = txidDupKindMap(st);
  var n = 0;
  (st.trades || []).forEach(function (t) {
    if (!t || txidDupKeyOfTrade(t, kinds) !== key) return;
    if (on) { if (t.txidDupOk !== true) { t.txidDupOk = true; n++; } }
    else if (t.txidDupOk !== undefined) { try { delete t.txidDupOk; } catch (e) { t.txidDupOk = undefined; } n++; }
  });
  return n;
}
