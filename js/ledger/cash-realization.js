'use strict';
// Cash realization: which FX rate a cash flow is shown at (frozen lock vs the
// latest fixing) and the IAS 21 style display value of cash income.

function ledgerFxRate(lock) {
  var r = lock ? Number(lock.rate) : NaN;
  return (isFinite(r) && r > 0) ? r : 1;
}

// Open cash income converts at the latest fixing, not the receipt lock:
// holdings float, closed flows stay frozen. Falls back to the frozen lock
// (same as every other figure) when no current rate is cached yet.
function cashIncomeRate(t, main) {
  try {
    var m = String(main || '').toUpperCase();
    var f = String((t && t.symbol) || (t && t.currency) || '').toUpperCase();
    if (!f || f === m) return ledgerFxRate(t && t.fxLock);
    var dk = todayStr();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return ledgerFxRate(t && t.fxLock);
    var hit = getCachedRate(dk, f, m);
    if (hit && isFinite(Number(hit.rate)) && Number(hit.rate) > 0) return Number(hit.rate);
  } catch (e) { /* fall through to frozen */ }
  return ledgerFxRate(t && t.fxLock);
}

// --- Cash realization (display attribution, IAS 21 style) ---
// Holdings float, spending realizes: a cash income's DISPLAY value is
// remainder_qty * today_rate + sum(consumed_qty_i * spend_rate_i), where
// each spend_rate_i is the consuming expense's frozen display rate
// (trade-date fixing into the current main). Consumption is FIFO, oldest
// income first among income already received on or before the expense's
// date (same-date incomes book before same-date expenses), same account +
// same fiat, expenses only. Transfers are moves, never spends. Qty-less (fiat-only) expenses consume nothing and
// book straight through. Asset incomes stay frozen (never in the map).
// Record lines, linkage, cost basis, invested/spent and native balances
// are untouched — only the converted view numbers use this.
function cashFiatOf(t) {
  return String((t && t.symbol) || '').trim().toUpperCase();
}

function cashQtyOf(t) {
  var q = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? NaN : Number(t.qty);
  return (isFinite(q) && q > 0) ? q : 0;
}

// Map cash-income trade object -> realized display value (signed +, main
// fiat). allTrades are display-converted (fxLock into main). isCash(id)
// gates which accounts realize; null/false means none. Expenses never
// appear in the map (their frozen value is used directly).
function buildCashRealization(allTrades, main, isCash) {
  var map = new Map();
  try {
    if (!allTrades || !allTrades.length) return map;
    var byKey = {};
    (allTrades || []).forEach(function (t) {
      if (!t) return;
      try {
        if (!isCash || !isCash(t.accountId)) return;
      } catch (e) { return; }
      if (t.type !== 'income' && t.type !== 'expense') return;
      var fiat = cashFiatOf(t);
      if (!fiat) return;
      var q = cashQtyOf(t);
      if (!(q > 0)) return;
      var key = String(t.accountId) + '|' + fiat;
      if (!byKey[key]) byKey[key] = { incomes: [], expenses: [] };
      if (t.type === 'income') byKey[key].incomes.push(t);
      else byKey[key].expenses.push(t);
    });
    function dOf(t) { return (t && typeof t.date === 'string') ? t.date : ''; }
    function byDate(a, b) {
      var da = dOf(a), db = dOf(b);
      if (da < db) return -1;
      if (da > db) return 1;
      return 0;
    }
    Object.keys(byKey).forEach(function (key) {
      var g = byKey[key];
      // One chronological stream: an expense may only consume income lots
      // that already exist on or before its date. Dates carry no time of day,
      // so on the SAME date incomes book first (money received that day can
      // fund that day's spend); remaining ties keep store order.
      var events = [];
      g.incomes.forEach(function (t, i) { events.push({ t: t, income: true, idx: i }); });
      g.expenses.forEach(function (t, i) { events.push({ t: t, income: false, idx: i }); });
      events.sort(function (a, b) {
        var c = byDate(a.t, b.t);
        if (c !== 0) return c;
        if (a.income !== b.income) return a.income ? -1 : 1;
        return a.idx - b.idx;
      });
      var lots = [];
      var li = 0; // oldest lot that may still have a balance
      events.forEach(function (ev) {
        if (ev.income) {
          lots.push({ t: ev.t, left: cashQtyOf(ev.t), consumedMain: 0 });
          return;
        }
        var e = ev.t;
        var need = cashQtyOf(e);
        if (!(need > 0)) return;
        var spendRate = ledgerFxRate(e.fxLock);
        while (need > LEDGER_EPS && li < lots.length) {
          var lot = lots[li];
          if (!lot || lot.left <= LEDGER_EPS) { li++; continue; }
          var take = Math.min(lot.left, need);
          lot.consumedMain += take * spendRate;
          lot.left -= take;
          need -= take;
          if (lot.left <= LEDGER_EPS) { lot.left = 0; li++; }
        }
        // Overspend beyond income received so far consumes nothing further
        // (never later income): the excess stays as a frozen expense
        // (negative balances allowed).
      });
      lots.forEach(function (lot) {
        var rem = lot.left;
        if (Math.abs(rem) < LEDGER_EPS) rem = 0;
        var todayRate = null;
        try { todayRate = cashIncomeRate(lot.t, main); } catch (e2) { todayRate = null; }
        if (!(isFinite(Number(todayRate)) && Number(todayRate) > 0)) {
          try { todayRate = ledgerFxRate(lot.t.fxLock); } catch (e3) { todayRate = 1; }
        }
        map.set(lot.t, lot.consumedMain + rem * Number(todayRate));
      });
    });
  } catch (e) { /* realization never breaks display; callers fall back frozen */ }
  return map;
}
