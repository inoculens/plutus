'use strict';
// Account and record actions: create, rename, delete, group / ungroup,
// sub-accounts, record delete. The UI and the tests reference every one of
// these: never remove them.

function accountTrades(st, accountId) {
  // Single-arg form accountTrades(accountId) reads live state (test helper).
  if (typeof st === 'string' && accountId === undefined) {
    return accountTrades(loadState(), st);
  }
  return ((st && st.trades) || []).filter(function (t) {
    return transferInvolvesAccount(t, accountId);
  });
}

function fxBadgeText(t) {
  var lock = t ? t.fxLock : null;
  if (!lock) return 'legacy rate';
  var r = Number(lock.rate);
  var bits = fmtEcbInText(String(lock.source || 'rate'));
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
  if (kd !== 'crypto' && kd !== 'stock' && kd !== 'commodity' && kd !== 'custom' && kd !== 'cash') kd = 'crypto';
  var acc = { id: uid(), name: nm, ticker: tk, kind: kd, createdAt: new Date().toISOString() };
  if (extra && typeof extra === 'object') {
    if (typeof extra.address === 'string' && extra.address.trim() !== '') acc.address = extra.address.trim().slice(0, ACCOUNT_LABEL_MAX);
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

// Transfers that touch a doomed account AND an account that survives.
// Deleting the account removes these records from the surviving accounts
// too (a shared transfer cannot exist half-way), so the confirm dialogs
// say so. Pure: st + array of account ids.
function sharedTransfersOutside(st, doomedIds) {
  var doomed = {};
  (doomedIds || []).forEach(function (id) { doomed[id] = true; });
  var n = 0;
  (st.trades || []).forEach(function (t) {
    if (!t || t.type !== 'transfer') return;
    var ids = [];
    try {
      ids = transferSourceIds(t).concat(transferDestIds(t));
      if (typeof t.accountId === 'string' && t.accountId) ids.push(t.accountId);
    } catch (e) { return; }
    var hitsDoomed = false, hitsOther = false;
    ids.forEach(function (id) { if (doomed[id]) hitsDoomed = true; else if (accountById(st, id)) hitsOther = true; });
    if (hitsDoomed && hitsOther) n++;
  });
  return n;
}

function sharedTransfersNote(n) {
  return n ? ' ' + n + ' transfer' + (n === 1 ? ' is' : 's are') + ' shared with other accounts and will be removed from them too.' : '';
}

function deleteAccount(id) {
  if (!id) return;
  var st = loadState();
  var acc = accountById(st, id);
  if (!acc) return; // unknown id: no write, no dialog
  var n = accountTrades(st, id).length;
  var doomedSubs = groupMembers(st, id);
  var debtBlock = debtAccountDeleteBlock(st, expandDeleteIds(st, [id]));
  if (debtBlock) { showBanner(debtBlock); return; }
  var msg = 'Delete account "' + acc.name + '" (' + acc.ticker + ')' +
    (n ? ' and its ' + n + ' trade' + (n === 1 ? '' : 's') : '') +
    (doomedSubs.length ? ' and delete ' + doomedSubs.length + ' sub-account' + (doomedSubs.length === 1 ? '' : 's') + ' with all their trades' : '') +
    '?' + sharedTransfersNote(sharedTransfersOutside(st, expandDeleteIds(st, [id]))) + ' This cannot be undone.';
  confirmAction('Delete account', msg, 'Delete', true).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    if (!accountById(s2, id)) return;
    var inSet = {};
    expandDeleteIds(s2, [id]).forEach(function (x) { inSet[x] = true; });
    var debtBlockNow = debtAccountDeleteBlock(s2, Object.keys(inSet));
    if (debtBlockNow) { showBanner(debtBlockNow); return; }
    s2.trades = (s2.trades || []).filter(function (t) {
      if (!t) return true;
      return !Object.keys(inSet).some(function (accountId) { return transferInvolvesAccount(t, accountId); });
    });
    s2.accounts = (s2.accounts || []).filter(function (a) { return !a || !inSet[a.id]; });
    if (!saveStateGuarded(s2)) return;
    try {
      Object.keys(inSet).forEach(function (x) { delete tradePageByAccount[x]; clearTradeTypeFilterState(x); });
    } catch (e) { /* ignore */ }
    clearBanner();
    render();
  });
}

function ungroupMain(mainId) {
  if (!mainId) return;
  var st = loadState();
  var acc = accountById(st, mainId);
  if (!acc) return;
  var n = groupMembers(st, mainId).length;
  if (!n) return;
  confirmAction('Ungroup', 'Release ' + n + ' sub-account' + (n === 1 ? '' : 's') + ' from "' + acc.name + '"? Records stay where they are.', 'Ungroup', false).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    if (!accountById(s2, mainId)) return;
    ungroupAll(s2, mainId);
    if (!saveStateGuarded(s2)) return;
    clearBanner();
    render();
  });
}

// Direct sub-accounts, no home roundtrip: grouping target is this account
// (or its main when already grouped). A standalone account holding records
// moves them into sub-<name> and becomes the main; otherwise the sub starts
// empty with the same kind/ticker. Transfers pointing at the old account
// keep arriving there.
function createSubAccount(currentId) {
  if (!currentId) return;
  var st = loadState();
  var acc = accountById(st, currentId);
  if (!acc) return;
  if (groupMainOf(st, currentId)) { showBanner('Sub-accounts cannot have their own sub-accounts — create it in the main account instead.'); return; }
  var mainOf = groupMainOf(st, currentId);
  var parentMainId = mainOf ? mainOf.id : currentId;
  var nm = uniqueSubName(st, acc.name);
  var sub = { id: uid(), name: nm, ticker: acc.ticker, kind: acc.kind, createdAt: new Date().toISOString() };
  st.accounts.push(sub);
  sub.groupId = parentMainId;
  if (!mainOf && accountTrades(st, currentId).length > 0) {
    (st.trades || []).forEach(function (t) {
      if (!t) return;
      var wasPrimary = t.accountId === currentId;
      if (wasPrimary) t.accountId = sub.id;
      if (t.type === 'transfer' && Array.isArray(t.sources)) {
        t.sources.forEach(function (source) { if (source && source.accountId === currentId) source.accountId = sub.id; });
        if (wasPrimary && t.sources.length) t.sources[0].accountId = sub.id;
      }
    });
  }
  ensureGroupCurrency(st, parentMainId);
  if (!saveStateGuarded(st)) return;
  try { delete tradePageByAccount[currentId]; delete tradePageByAccount[sub.id]; clearTradeTypeFilterState(currentId); } catch (e) { /* ignore */ }
  clearBanner();
  navTo(parentMainId);
  render();
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
    String(doomed.symbol || '') + ' (' + (doomed.date ? fmtDateDmy(doomed.date) : 'no date') + ')';
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
