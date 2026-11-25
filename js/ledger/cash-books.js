'use strict';
// Cash bookkeeping engine and ledger codes (pure, no DOM).
// Cash accounts are balance ledgers, not positions: balance = signed flows
// in the account fiat, converted per-flow at the frozen fxLock rate.
// income/buy credit, expense/sell debit; transfers debit the source and
// credit the destination (same-fiat: sent − fee; cross-fiat: stored toQty).
function cashReceivedOf(t, accountId) {
  // Per-destination form cashReceivedOf(t, accountId) credits one internal
  // recipient of a (possibly multi-output) transfer, 0 otherwise.
  if (accountId !== undefined && accountId !== null) return transferArrivalFor(t, accountId);
  if (!t || t.type !== 'transfer') return 0;
  var dest = (t.toSymbol === undefined || t.toSymbol === null || String(t.toSymbol).trim() === '')
    ? String(t.symbol || '').toUpperCase()
    : String(t.toSymbol).trim().toUpperCase();
  if (dest !== String(t.symbol || '').toUpperCase()) {
    var cross = (t.toQty === undefined || t.toQty === null || String(t.toQty).trim() === '') ? NaN : Number(t.toQty);
    return (isFinite(cross) && cross > 0) ? cross : 0;
  }
  var sent = Number(t.qty);
  var nfRaw = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
  var nf = (isFinite(nfRaw) && nfRaw >= 0) ? nfRaw : 0;
  if (!isFinite(sent) || sent <= 0) return 0;
  var recv = sent - nf;
  return (isFinite(recv) && recv > 0) ? recv : 0;
}

function cashSignedNative(t, accountId) {
  if (!t || (t.accountId !== accountId && t.type !== 'transfer')) {
    return transferArrivalFor(t, accountId);
  }
  var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
  if (t.type === 'income' || t.type === 'buy') return (isFinite(q) && q > 0) ? q : 0;
  if (t.type === 'expense') {
    if (isFinite(q) && q > 0) return -q;
    // Legacy qty-less expense: only the same-fiat total is a balance move.
    var tot = Number(t.total);
    if (isFinite(tot) && tot > 0 && String(t.currency || '').toUpperCase() === String(t.symbol || '').toUpperCase()) return -tot;
    return 0;
  }
  if (t.type === 'sell') return (isFinite(q) && q > 0) ? -q : 0;
  if (t.type === 'transfer') {
    return transferArrivalFor(t, accountId) - transferSourceQtyFor(t, accountId);
  }
  return 0;
}

function cashBalance(allTrades, accountId, main, floatIncome) {
  var doFloat = floatIncome !== false;
  var native = 0;
  var inMain = 0;
  var ticker = '';
  var mainU = String(main || '').toUpperCase();
  // Realization map: consumed income locks at spend rates, remainder floats.
  // Built once per balance so the total is remainder x current by construction.
  var realMap = null;
  if (doFloat) {
    try {
      realMap = buildCashRealization(allTrades, main, function (id) { return id === accountId; });
    } catch (e) { realMap = null; }
  }
  function legRate(t, isDest, accountId) {
    if (isDest) {
      // Destination leg is denominated in the arrival fiat: its own lock
      // wins; a main-fiat arrival is 1 by definition. Multi-output rows may
      // carry their own toSymbol, so look up this account's row first.
      var toSym = (t.toSymbol === undefined || t.toSymbol === null || String(t.toSymbol).trim() === '')
        ? String(t.symbol || '').toUpperCase()
        : String(t.toSymbol).trim().toUpperCase();
      try {
        var outsR = transferOutputsOf(t);
        for (var oiR = 0; oiR < outsR.length; oiR++) {
          var oR = outsR[oiR];
          if (!isTransferOutputInternal(oR) || String(oR.toAccountId).trim() !== accountId) continue;
          if (oR.toSymbol !== undefined && oR.toSymbol !== null && String(oR.toSymbol).trim() !== '') {
            toSym = String(oR.toSymbol).trim().toUpperCase();
          }
          break;
        }
      } catch (e) { /* keep the legacy symbol */ }
      if (toSym === mainU) return 1;
      if (t.toFxLock) return ledgerFxRate(t.toFxLock);
    } else if (t.fromFxLock) {
      // Source leg of a cash transfer: transfers zero their own currency,
      // so the frozen source-fiat rate rides separately (else a non-main
      // source would convert 1:1 by mistake).
      return ledgerFxRate(t.fromFxLock);
    }
    return ledgerFxRate(t.fxLock);
  }
  (allTrades || []).forEach(function (t) {
    if (!t) return;
    var isSrc = (t.type === 'transfer') ? (transferSourceIds(t).indexOf(accountId) !== -1) : (t.accountId === accountId);
    var isDest = transferArrivalFor(t, accountId) > 0;
    if (!isSrc && !isDest) return;
    if (isSrc && !ticker && t.symbol) ticker = String(t.symbol).toUpperCase();
    var signed = isSrc && isDest ? cashSignedNative(t, accountId) : (isDest ? cashReceivedOf(t, accountId) : cashSignedNative(t, accountId));
    // Legacy same-account sweeps have no output row, so add back the net
    // remainder that stayed in the source account.
    if (isSrc && t.type === 'transfer') {
      var selfBack = transferSelfArrivalFor(t, accountId);
      if (isFinite(selfBack) && selfBack > 0) signed += selfBack;
    }
    if (!isFinite(signed) || signed === 0) return;
    native += signed;
    // Realization: holdings float, spending locks. A consumed income's value
    // is remainder x today + consumed x spend-day (already in realMap), so a
    // fully spent account nets to exactly zero. Every other leg — expenses,
    // transfers, sells — stays on its frozen lock.
    if (doFloat && !isDest && t.type === 'income' && realMap && realMap.has(t)) {
      var rv = realMap.get(t);
      if (isFinite(Number(rv))) { inMain += Number(rv); return; }
    }
    var leg = legRate(t, isDest && !isSrc, accountId);
    if (doFloat && !isDest && t.type === 'income' && !(realMap && realMap.has(t))) {
      try { leg = cashIncomeRate(t, main); } catch (e) { /* keep frozen leg */ }
    }
    inMain += signed * leg;
  });
  // Tidy binary dust; keep the sign of tiny remainders at exactly 0.
  function tidy(v) { return (Math.abs(v) < 1e-9) ? 0 : Math.round(v * 100) / 100; }
  return { native: tidy(native), main: tidy(inMain), ticker: ticker };
}

// Ledger tree: income/expense (and legacy ledger-carrying buy/sell) trades
// aggregate by code (signed main amounts), then roll up into parents. Parent = longest
// other known code that is a strict leading prefix, or — for numeric
// Twinfield-style schemes — the digit-level parent (1110 → 1100 → 1000).
// Trades without a code land in the unassigned bucket. Labels resolve
// trade label first, then the chart map, then the bare code.
function ledgerParentOf(code, known) {
  var c = String(code);
  var set = dict();
  (known || []).forEach(function (k) { set[String(k)] = true; });
  delete set[c];
  var best = null;
  function consider(k) {
    if (!set[k] || k === '') return;
    if (best === null || k.length > best.length) best = k;
  }
  Object.keys(set).forEach(function (k) {
    if (c.indexOf(k) === 0) consider(k);
  });
  if (/^[0-9]+$/.test(c)) {
    var core = c.replace(/0+$/, '');
    while (core.length > 1) {
      core = core.slice(0, -1);
      consider(core + new Array(c.length - core.length + 1).join('0'));
    }
  }
  return best;
}

// Every code nested under `target` via the same parent rules as the tree
// (prefix + numeric Twinfield parents). Used by ledger delete so removing a
// top ledger cascades to the whole subtree, including posted-only codes.
function ledgerDescendantsOf(target, allCodes) {
  var t = (target === undefined || target === null) ? '' : String(target).trim();
  if (!t) return [];
  var keys = [];
  (allCodes || []).forEach(function (k) {
    var ck = String(k);
    if (ck !== t && keys.indexOf(ck) === -1) keys.push(ck);
  });
  var full = keys.concat([t]);
  var out = [];
  keys.forEach(function (c) {
    var cur = c;
    var seen = dict();
    while (cur && !seen[cur]) {
      seen[cur] = true;
      var p = ledgerParentOf(cur, full);
      if (!p) break;
      if (p === t) { out.push(c); break; }
      cur = p;
    }
  });
  return out;
}

// Full ledger scope for an account: itself, or the whole group (main
// first) when grouped. Ledger reads/writes across the scope share the
// main's chart; records keep their own account.
function ledgerScopeOf(st, accountId) {
  if (!st || !accountId) return [accountId];
  var mainOf = groupMainOf(st, accountId);
  var mainId = mainOf ? mainOf.id : accountId;
  var ids = [mainId];
  groupMembers(st, mainId).forEach(function (a) { ids.push(a.id); });
  return ids;
}

// Extra display fiats beyond the header main: every group currency in play,
// so their historical pairs get prefetched exactly like header pairs.
// Without this, group figures in a foreign fiat sit on fallback locks.
function groupFillFiats(st) {
  var out = [];
  var seen = {};
  var m = '';
  try { m = String(st.settings.mainCurrency || '').toUpperCase(); } catch (e) { m = ''; }
  ((st && st.accounts) || []).forEach(function (a) {
    if (!a || !a.id) return;
    var isMain = false;
    try { isMain = isGroupMain(st, a.id); } catch (e) { isMain = false; }
    if (!isMain) return;
    var g = '';
    try { g = groupLedgerCurrency(st, a); } catch (e) { g = ''; }
    if (!g || g === m || seen[g]) return;
    seen[g] = true;
    out.push(g);
  });
  return out;
}

// Every ledger code known to an account: chart keys plus codes posted on
// its records (posted-only codes nest like charted ones).
function ledgerAccountCodes(st, accountId) {
  var set = dict();
  try {
    var eff = ledgerChartFor(st, accountId);
    Object.keys(eff).forEach(function (k) { var ck = String(k).trim(); if (ck) set[ck] = true; });
  } catch (e) { /* ignore */ }
  ((st && st.trades) || []).forEach(function (t) {
    if (!t) return;
    if (t.accountId !== accountId && transferSourceIds(t).indexOf(accountId) === -1) return;
    var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (c) set[c] = true;
  });
  return Object.keys(set);
}

function ledgerPostedOn(st, accountId, code, excludeId, excludeCode) {
  var n = 0;
  ((st && st.trades) || []).forEach(function (t) {
    if (!t) return;
    if (t.accountId !== accountId && transferSourceIds(t).indexOf(accountId) === -1) return;
    if (excludeId && t.id === excludeId) return;
    var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (excludeCode && c === excludeCode) return;
    if (c === code) n++;
  });
  return n;
}

// Parent-overview rule: a ledger with sub-ledgers is a pure roll-up and
// can't hold its own records. Returns null when posting `code` is clean,
// else {kind:'parent',code,kids} (code already has children) or
// {kind:'orphans',code,parents} (posting here would strand records on a
// new parent). excludeId skips one record (trade edits), excludeCode skips
// records carrying that code (ledger renames move them away). scopeIds
// widens charts + postings to the whole group (main first); omitted means
// the single account.
function ledgerRecordConflict(st, accountId, code, excludeId, excludeCode, scopeIds) {
  code = (code === undefined || code === null) ? '' : String(code).trim();
  if (!code) return null;
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [accountId];
  var chartAcc = scope[0];
  var set = dict();
  try {
    var eff = ledgerChartFor(st, chartAcc);
    Object.keys(eff).forEach(function (k) { var ck = String(k).trim(); if (ck) set[ck] = true; });
  } catch (e) { /* ignore */ }
  scope.forEach(function (sid) {
    ((st && st.trades) || []).forEach(function (t) {
      if (!t || t.accountId !== sid) return;
      var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
      if (c) set[c] = true;
    });
  });
  var all = Object.keys(set);
  if (all.indexOf(code) === -1) all.push(code);
  function postedInScope(cd) {
    var n = 0;
    scope.forEach(function (sid) { n += ledgerPostedOn(st, sid, cd, excludeId, excludeCode); });
    return n;
  }
  var kids = ledgerDescendantsOf(code, all);
  if (kids.length) return { kind: 'parent', code: code, kids: kids.slice().sort() };
  var parents = [];
  var cur = code;
  var seen = dict();
  while (cur && !seen[cur]) {
    seen[cur] = true;
    var p = ledgerParentOf(cur, all);
    if (!p) break;
    if (postedInScope(p) > 0 && parents.indexOf(p) === -1) parents.push(p);
    cur = p;
  }
  if (parents.length) return { kind: 'orphans', code: code, parents: parents };
  return null;
}

// Existing rule-breakers for the cleanup hint: ledgers that hold records
// AND sub-ledgers. Sorted for stable messages.
function ledgerViolations(st, accountId) {
  var all = [];
  try { all = ledgerAccountCodes(st, accountId); } catch (e) { all = []; }
  var out = [];
  all.forEach(function (c) {
    try {
      if (ledgerPostedOn(st, accountId, c, null, null) > 0 && ledgerDescendantsOf(c, all).length > 0) out.push(c);
    } catch (e) { /* ignore */ }
  });
  return out.sort();
}

function ledgerConflictMessage(conf) {
  if (!conf) return '';
  function short(list) {
    var a = (list || []).slice().sort();
    return a.slice(0, 4).join(', ') + (a.length > 4 ? ', …' : '');
  }
  if (conf.kind === 'parent') {
    return '"' + conf.code + '" is an overview ledger — it holds sub-ledgers (' + short(conf.kids) + ') and can\'t take records. Post to a child ledger instead.';
  }
  return '"' + conf.code + '" would turn "' + conf.parents[0] + '" into an overview that still holds records. Move the "' + conf.parents[0] + '" record(s) to a child ledger, keep "' + conf.parents[0] + '" as an empty overview (add it with + Ledger), then post here.';
}

// Repair pass for cash bookkeeping records saved before the cash form
// locked amounts to the account fiat: a cash income/expense with a real
// quantity but a blank/zero total gains total=qty (exactly what the form
// saves today). Positive totals are never touched. Idempotent.
function repairCashTradeAmounts(trades, accounts) {
  try {
    var kinds = dict();
    ((accounts) || []).forEach(function (a) {
      if (a && a.id) kinds[a.id] = (typeof a.kind === 'string') ? a.kind.trim().toLowerCase() : '';
    });
    (trades || []).forEach(function (t) {
      if (!t || (t.type !== 'income' && t.type !== 'expense')) return;
      if (kinds[t.accountId] !== 'cash') return;
      var symU = String(t.symbol || '').toUpperCase();
      // Blank currency rejoins the books under the account fiat: without it
      // the record is unfetchable (no pair) and values at zero.
      if (String(t.currency || '').trim() === '' && symU !== '' && isValidCurrencyCode(symU)) {
        t.currency = symU;
      }
      if (String(t.currency || '').toUpperCase() !== symU || symU === '') return;
      var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
      if (!isFinite(q) || q <= 0) return;
      var tot = (t.total === undefined || t.total === null || String(t.total).trim() === '') ? NaN : Number(t.total);
      if (isFinite(tot) && tot > 0) return;
      t.total = q;
    });
  } catch (e) { /* repair never breaks load/import */ }
}
// Ledger row value: the signed main-fiat movement. Cash-pattern
// income/expense (amount in the account fiat) values by quantity at the
// frozen rate — the optional market-value total may be blank ("free").
// Everything else values by the booked total, as before.
function ledgerSignedMain(t, cashHint, main) {
  var isIn = (t.type === 'income' || t.type === 'buy');
  if (!isIn && t.type !== 'expense' && t.type !== 'sell') return 0;
  var dir = isIn ? 1 : -1;
  var symU = String(t.symbol || '').toUpperCase();
  var ccyU = String(t.currency || '').toUpperCase();
  // Cash bookkeeping values the amount in the account fiat by quantity.
  // cashHint (cash-scope accounts) covers records whose currency field is
  // blank or mismatched: the quantity is still account-fiat money, so it
  // converts at the frozen rate instead of booking a zero. Open cash income
  // floats at the latest fixing (main display fiat); everything else —
  // expenses, transfers, buys/sells, cost basis — stays frozen. When a
  // realization map is supplied (ledger tree / balances), consumed income
  // locks at spend-day rates and only the remainder floats.
  if ((t.type === 'income' || t.type === 'expense') && (cashHint || (ccyU !== '' && ccyU === symU))) {
    var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
    if (isFinite(q) && q > 0) {
      if (t.type === 'income' && cashHint) {
        var live = null;
        try { live = cashIncomeRate(t, main); } catch (e) { live = null; }
        if (live !== null && live !== undefined && isFinite(Number(live))) return dir * q * Number(live);
      }
      return dir * q * ledgerFxRate(t.fxLock);
    }
    q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
    if (isFinite(q) && q > 0) return dir * q * ledgerFxRate(t.fxLock);
    if (t.type === 'expense') {
      var et = Number(t.total);
      if (isFinite(et) && et > 0) return -et * ledgerFxRate(t.fxLock);
    }
    return 0;
  }
  var n = normalizeTrade(t);
  return dir * (isFinite(n.netMain) ? n.netMain : 0);
}

// Realization-aware row value: cash incomes in realMap use their attributed
// value (locked consumed + floated remainder); everything else keeps the
// frozen ledgerSignedMain behavior. realMap may be null (single-trade callers).
function ledgerSignedMainRealized(t, cashHint, main, realMap) {
  try {
    if (t && t.type === 'income' && cashHint && realMap && realMap.has(t)) {
      var v = realMap.get(t);
      if (isFinite(Number(v))) return Number(v);
    }
  } catch (e) { /* fall through frozen */ }
  return ledgerSignedMain(t, cashHint, main);
}

function ledgerTree(allTrades, accountId, main, labelMap) {
  return ledgerTreeMulti(allTrades, [accountId], main, labelMap, null);
}

// Multi-account tree for group mains (and asset views): the same roll-up
// over every id in scope. kinds maps id -> account kind; null means all
// cash (the legacy single-account behavior). Asset income/expense without
// a code pool into Unlabeled assets; buy/sell without a code and codeless
// transfers stay out of the tree entirely, on every kind. A labeled transfer
// posts -sent on the source and +received on the arrival under one code.
function ledgerTreeMulti(allTrades, ids, main, labelMap, kinds) {
  var labels = labelMap || {};
  var inScope = dict();
  (ids || []).forEach(function (id) { if (typeof id === 'string' && id !== '') inScope[id] = true; });
  function cashScope(id) {
    if (!kinds || typeof kinds[id] !== 'string') return true;
    return isCashKind(kinds[id]);
  }
  var own = {}; // code -> {code, amount}
  var unassignedIncome = 0;
  var unassignedIncomeCount = 0;
  var unassignedExpense = 0;
  var unassignedExpenseCount = 0;
  var unassignedAssets = 0;
  var unassignedAssetsCount = 0;
  // Signed zero is still zero: -0 would print as "-€0.00".
  function z(v) { return (v === 0) ? 0 : Math.round(v * 100) / 100; }
  // Realization (one attribution over the whole scope): consumed cash income
  // locks at spend-day rates, remainder floats. Same FIFO as balances, so
  // tree totals and account Values agree and closed accounts net to zero.
  var realMap = null;
  try {
    realMap = buildCashRealization(allTrades, main, function (id) { return !!inScope[id] && cashScope(id); });
  } catch (e) { realMap = null; }
  (allTrades || []).forEach(function (t) {
    if (!t || (!inScope[t.accountId] && t.type !== 'transfer')) return;
    if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'buy' && t.type !== 'sell' && t.type !== 'transfer') return;
    var code = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (t.type === 'transfer') {
      // Codeless transfers stay out of every bucket; a labeled move posts
      // -sent on the source leg and +received on the arrival leg under the
      // same code, so a group scope nets to the fee. Rates mirror the
      // balance legs (frozen source/arrival locks, main-fiat arrival at 1).
      if (!code) return;
      var sent = Number(t.qty);
      if (!isFinite(sent) || sent <= 0) return;
      // Multi-source: debit each in-scope source leg, credit self/arrivals per
      // leg. A code is only opened below, once something in this scope posts
      // to it, so a transfer elsewhere never adds an empty code here.
      var legsL = transferSourceLegs(t);
      if (!legsL.length) return;
      var hasOutputsL = Array.isArray(t.outputs) && t.outputs.length > 0;
      var outsL = hasOutputsL ? t.outputs : transferOutputsOf(t);
      var anyInScope = false;
      for (var li = 0; li < legsL.length; li++) if (inScope[legsL[li].accountId]) { anyInScope = true; break; }
      if (!anyInScope) {
        for (var di = 0; di < outsL.length; di++) {
          var oL = outsL[di];
          if (isTransferOutputInternal(oL) && inScope[String(oL.toAccountId).trim()]) { anyInScope = true; break; }
        }
      }
      if (!anyInScope) return;
      var mainU = String(main || '').toUpperCase();
      legsL.forEach(function (leg) {
        if (!inScope[leg.accountId]) return;
        var srcRateL = t.fromFxLock ? ledgerFxRate(t.fromFxLock) : ledgerFxRate(t.fxLock);
        if (!own[code]) own[code] = { code: code, amount: 0, count: 0 };
        own[code].amount = z(own[code].amount - leg.qty * srcRateL);
        own[code].count++;
        // Fee is already in leg.qty; fee is not a separate debit — the net
        // that moves is leg.net = leg.qty - leg.fee.
      });
      // Self remainder: each source keeps its own net (qty - fee) at its own rate
      legsL.forEach(function (leg) {
        if (!inScope[leg.accountId]) return;
        var selfForLeg = transferSelfArrivalFor(t, leg.accountId);
        if (selfForLeg > 0) {
          var srcRateL = t.fromFxLock ? ledgerFxRate(t.fromFxLock) : ledgerFxRate(t.fxLock);
          if (!own[code]) own[code] = { code: code, amount: 0, count: 0 };
          own[code].amount = z(own[code].amount + selfForLeg * srcRateL);
          own[code].count++;
        }
      });
      // Internal arrivals: credit each in-scope destination at the arrival rate
      outsL.forEach(function (o) {
        if (!isTransferOutputInternal(o)) return;
        var destIdL = String(o.toAccountId).trim();
        if (!destIdL || !inScope[destIdL]) return;
        var arrL = transferRowArrival(o, t.symbol);
        if (!isFinite(arrL) || arrL <= 0) return;
        var rowSymL = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
          ? String(t.symbol || '').toUpperCase()
          : String(o.toSymbol).trim().toUpperCase();
        var rowRateL = (rowSymL === mainU) ? 1 : (t.toFxLock ? ledgerFxRate(t.toFxLock) : ledgerFxRate(t.fxLock));
        if (!own[code]) own[code] = { code: code, amount: 0, count: 0 };
        own[code].amount = z(own[code].amount + arrL * rowRateL);
        own[code].count++;
      });
      return;
    }
    var signed = z(ledgerSignedMainRealized(t, cashScope(t.accountId), main, realMap));
    if (!code) {
      // Only bookkeeping types can be uncategorized; plain asset
      // buy/sell records without a code stay out of the tree entirely.
      // Unlabeled records (e.g. freed by a ledger delete) surface under two
      // virtual defaults so totals never lose money: income vs expenses on
      // cash, one Unlabeled assets pool everywhere else.
      if (t.type === 'income' || t.type === 'expense') {
        if (cashScope(t.accountId)) {
          if (t.type === 'income') { unassignedIncome = z(unassignedIncome + signed); unassignedIncomeCount++; }
          else { unassignedExpense = z(unassignedExpense + signed); unassignedExpenseCount++; }
        } else {
          unassignedAssets = z(unassignedAssets + signed); unassignedAssetsCount++;
        }
      }
      return;
    }
    if (!own[code]) own[code] = { code: code, amount: 0, count: 0 };
    own[code].amount = z(own[code].amount + signed);
    own[code].count++;
  });
  var codes = Object.keys(own);
  // Chart codes without records are structural parents (e.g. 1000 holding
  // only subledger postings): they render with zero of their own so the
  // tree shows the full chart, not just posted codes.
  Object.keys(labels || {}).forEach(function (k) {
    k = String(k).trim();
    if (k === '') return;
    if (!Object.prototype.hasOwnProperty.call(own, k)) {
      own[k] = { code: k, amount: 0, count: 0 };
      codes.push(k);
    }
  });
  var nodes = {};
  codes.forEach(function (c) {
    var tradeLabel = '';
    (allTrades || []).forEach(function (t) {
      if (tradeLabel) return;
      if (t && inScope[t.accountId] && String(t.ledger || '').trim() === c && t.ledgerLabel && String(t.ledgerLabel).trim() !== '') {
        tradeLabel = String(t.ledgerLabel).trim();
      }
    });
    nodes[c] = {
      code: c,
      label: tradeLabel || (labels[c] ? String(labels[c]) : c),
      own: z(own[c].amount),
      count: own[c].count,
      total: 0,
      kids: []
    };
  });
  var roots = [];
  codes.forEach(function (c) {
    var p = ledgerParentOf(c, codes);
    if (p && nodes[p]) nodes[p].kids.push(nodes[c]);
    else roots.push(nodes[c]);
  });
  function roll(n) {
    var t = n.own;
    n.kids.forEach(function (k) { t += roll(k); });
    n.total = z(t);
    n.kids.sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
    return n.total;
  }
  roots.forEach(roll);
  roots.sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
  var unassigned = z(unassignedIncome + unassignedExpense);
  var unassignedCount = unassignedIncomeCount + unassignedExpenseCount;
  return { roots: roots, unassigned: unassigned, unassignedCount: unassignedCount, unassignedIncome: z(unassignedIncome), unassignedIncomeCount: unassignedIncomeCount, unassignedExpense: z(unassignedExpense), unassignedExpenseCount: unassignedExpenseCount, unassignedAssets: z(unassignedAssets), unassignedAssetsCount: unassignedAssetsCount };
}
