'use strict';
// Cost-basis engine: record normalization and ordering, average-cost and FIFO
// runs per account and symbol, and position summaries.
//
// The js/ledger files are the pure accounting engine: no DOM, no network, no
// storage. All main-currency conversion uses the trade's frozen fxLock.rate.
// computePositions / computeAverage / computeFifo buy/sell math is an
// established contract: preserve its behavior.
//
// Fee economics (all-in model): one fiat per trade — the fee is always
// denominated in the trade currency, so cost counts the FULL total (50 EUR
// in, 0.00058193 BTC out => entry 50/qty, e.g. 85920.99 — the fee simply
// lifts the calculated price, never a separate loss). Fees ride along as
// display-only info (feesFiat/fees sums + "Total fees paid" line); they never
// touch Realized, Unrealized or Total P&L. fee:0 behaves exactly as before.
// Sells book gross proceeds (total, no fee subtraction) for the same reason.

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

// Display twin of ledgerSortByDate's within-date rule: the engines walk each
// date's store slice as execution order (first record books first), while the
// list FEEDS the date newest-first — the latest execution on top, the day's
// first move at the bottom. Takes an already date-grouped list (contiguous
// equal-date runs) and reverses every run in place. Wrap the drag mapping
// around this, never around the engines: the store keeps execution order.
function reversePerDateBlocks(list) {
  var src = list || [];
  var out = [];
  var i = 0;
  while (i < src.length) {
    var d = (src[i] && typeof src[i].date === 'string') ? src[i].date : '';
    var j = i;
    while (j < src.length && ((src[j] && typeof src[j].date === 'string') ? src[j].date : '') === d) j++;
    for (var k = j - 1; k >= i; k--) out.push(src[k]);
    i = j;
  }
  return out;
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

function ledgerQtyEpsilon(symbol) {
  return qtyDecimals(symbol) >= 18 ? 0 : LEDGER_EPS;
}

// Stable linkage key for FIFO lot tracing (per-record Sold / Closed-from
// lines). Null when a legacy trade carries no id — such lots keep their
// math but opt out of per-record linkage.
function ledgerTradeId(t) {
  return (t && typeof t.id === 'string' && t.id !== '') ? t.id : null;
}

function computeAverage(trades) {
  var bySym = new Map();
  var list = ledgerSortByDate(trades);
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var sym = ledgerSym(t);
    if (!sym) continue;
    var qtyEps = ledgerQtyEpsilon(sym);
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
      if (e.qty <= qtyEps) continue; // no inventory: ignore, never negative
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
      if (Math.abs(e.qty) < qtyEps) { e.qty = 0; e.cost = 0; } // kill float dust
    } else if (t.type === 'expense') {
      var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
      var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
      var qe = hasQ ? Number(t.qty) : 0;
      if (hasQ && (!isFinite(qe) || qe <= 0)) continue;
      if (!bySym.has(sym)) bySym.set(sym, { qty: 0, cost: 0, realized: 0 });
      var ee = bySym.get(sym);
      if (hasQ) {
        if (ee.qty > qtyEps) {
          var rq = Math.min(qe, ee.qty);
          var aqe = ee.qty > 0 ? ee.cost / ee.qty : 0;
          var cRem = aqe * rq;
          ee.realized -= cRem; // crypto lost: proceeds 0 minus cost
          ee.cost -= cRem;
          ee.qty -= rq;
          if (Math.abs(ee.qty) < qtyEps) { ee.qty = 0; ee.cost = 0; }
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
      var outsA = transferOutputsOf(t);
      if (!outsA.length) {
      if (et.qty <= qtyEps) {
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
      if (Math.abs(et.qty) < qtyEps) { et.qty = 0; et.cost = 0; }
      } else {
        // Multi-recipient: internal same-symbol moves cancel globally (only
        // the fee matters); external and cross-fiat rows leave the pool.
        if (et.qty <= qtyEps) {
          if (fiatT > 0) et.realized -= fiatT;
          continue;
        }
        var tQtyA = Math.min(qt, et.qty);
        var scA = qt > 0 ? tQtyA / qt : 0;
        var feeQtyA = nft * scA;
        var avgA = et.qty > 0 ? et.cost / et.qty : 0;
        var leaveQ = feeQtyA;
        var leaveSpendC = 0;
        outsA.forEach(function (o) {
          var rq = Number(o.qty) * scA;
          if (!isFinite(rq) || rq <= 0) return;
          if (isTransferOutputInternal(o)) {
            var dS = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
              ? sym : String(o.toSymbol).trim().toUpperCase();
            if (dS === sym) return; // cancels globally
            return; // cross-fiat internal: leaves the pool silently
          }
          leaveQ += rq;
          if (o.spend !== false) leaveSpendC += avgA * rq; // external spend books its cost
        });
        var feeCostA = avgA * feeQtyA;
        et.qty -= leaveQ;
        et.cost -= avgA * leaveQ;
        et.realized -= feeCostA + fiatT + leaveSpendC;
        if (Math.abs(et.qty) < qtyEps) { et.qty = 0; et.cost = 0; }
      }
    }
  }
  bySym.forEach(function (e, sym) {
    var qtyEps = ledgerQtyEpsilon(sym);
    e.avgEntry = e.qty > qtyEps ? e.cost / e.qty : 0;
    if (Math.abs(e.qty) < qtyEps) { e.qty = 0; e.cost = 0; }
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
    var qtyEps = ledgerQtyEpsilon(sym);
    var n = normalizeTrade(t);
    var st = state(sym);
    var q = queues.get(sym);
    if (t.type === 'buy' || t.type === 'income') {
      var qb = Number(t.qty);
      if (!isFinite(qb) || qb <= 0) continue;
      q.push({ qty: qb, unitCost: qb > 0 ? n.netMain / qb : 0, date: t.date, buyId: ledgerTradeId(t) }); // all-in unit cost
      st.fees = (st.fees || 0) + n.feeMain; // display-only
    } else if (t.type === 'sell') {
      var qty = Number(t.qty);
      if (!isFinite(qty) || qty <= 0) continue;
      var heldFifo = q.reduce(function (s, l) { return s + l.qty; }, 0);
      if (heldFifo <= qtyEps) continue; // no inventory: ignore, never negative
      // Gross proceeds — fees live inside the buy price, never as sell drag.
      var proceedsTotal = n.totalMain;
      st.fees = (st.fees || 0) + n.feeMain;
      var unitProceeds = qty > 0 ? proceedsTotal / qty : 0;
      var sellQty = Math.min(qty, heldFifo);
      // Scale proceeds when the sell is clamped (oversell ignored, no negative).
      if (qty > sellQty && qty > 0) unitProceeds = (proceedsTotal * (sellQty / qty)) / (sellQty || 1);
      var left = sellQty;
      while (left > qtyEps && q.length > 0) {
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
          holdingDays: ledgerHoldingDays(lot.date, t.date),
          buyId: lot.buyId || null,
          sellId: ledgerTradeId(t),
          kind: 'sell'
        });
        st.realized += proceeds - cost;
        lot.qty -= take;
        left -= take;
        if (lot.qty <= qtyEps) q.shift();
      }
    } else if (t.type === 'expense') {
      var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
      var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
      if (hasQ) {
        var qe = Number(t.qty);
        if (!isFinite(qe) || qe <= 0) continue;
        var heldE = q.reduce(function (s, l) { return s + l.qty; }, 0);
        if (heldE > qtyEps) {
          var rq = Math.min(qe, heldE);
          var leftE = rq;
          while (leftE > qtyEps && q.length > 0) {
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
              holdingDays: ledgerHoldingDays(lote.date, t.date),
              buyId: lote.buyId || null,
              sellId: ledgerTradeId(t),
              kind: 'expense'
            });
            st.realized -= costE;
            lote.qty -= takeE;
            leftE -= takeE;
            if (lote.qty <= qtyEps) q.shift();
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
      if (heldT <= qtyEps) {
        if (fiatT > 0) st.realized -= fiatT;
        continue;
      }
      var tQty = Math.min(qt, heldT);
      var scaleT = qt > 0 ? tQty / qt : 0;
      var feeQtyT = nft * scaleT;
      // Remove gross qty oldest-first, then treat fee slice as expense.
      var removed = [];
      var leftT = tQty;
      while (leftT > qtyEps && q.length > 0) {
        var lotT = q[0];
        var takeT = Math.min(lotT.qty, leftT);
        removed.push({ qty: takeT, unitCost: lotT.unitCost, openDate: lotT.date, buyId: lotT.buyId || null });
        lotT.qty -= takeT;
        leftT -= takeT;
        if (lotT.qty <= qtyEps) q.shift();
      }
      var costOutT = removed.reduce(function (s, l) { return s + l.qty * l.unitCost; }, 0);
      var feeCostT = tQty > 0 ? costOutT * (feeQtyT / tQty) : 0;
      // Record the on-chain fee slice as loss lots (proportional across removed lots).
      if (feeQtyT > qtyEps && tQty > 0) {
        for (var ri = 0; ri < removed.length; ri++) {
          var rl = removed[ri];
          var ft = rl.qty * (feeQtyT / tQty);
          if (ft <= qtyEps) continue;
          var fc = ft * rl.unitCost;
          st.lots.push({
            openDate: rl.openDate,
            closeDate: t.date,
            qty: ft,
            proceeds: 0,
            cost: fc,
            gain: -fc,
            holdingDays: ledgerHoldingDays(rl.openDate, t.date),
            buyId: rl.buyId || null,
            sellId: ledgerTradeId(t),
            kind: 'network-fee'
          });
        }
      }
      st.realized -= feeCostT + fiatT;
      // qty/cost net: gross removed, nothing re-added globally (in+out cancel except fee already accounted via qty reduction below).
      // Re-add net? No: globally out+in cancel, leaving -feeQty. Queues already removed gross; re-add net portion with original lots scaled.
      var outsG = transferOutputsOf(t);
      var keepQtyT = tQty - feeQtyT;
      if (outsG.length) {
        // Multi-recipient: the same-account remainder and internal
        // same-symbol slices stay in the pool; external spend slices close
        // as expense lots; cross-fiat and neutral slices simply leave.
        keepQtyT = transferSelfQtyOf(t) * scaleT;
        var spendCostT = 0;
        outsG.forEach(function (o) {
          var rq = Number(o.qty) * scaleT;
          if (!isFinite(rq) || rq <= qtyEps) return;
          if (isTransferOutputInternal(o)) {
            var dS = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
              ? sym : String(o.toSymbol).trim().toUpperCase();
            if (dS === sym) keepQtyT += rq;
            return;
          }
          if (o.spend === false) return;
          for (var si = 0; si < removed.length; si++) {
            var srl = removed[si];
            var sft = (tQty > 0) ? srl.qty * (rq / tQty) : 0;
            if (sft <= qtyEps) continue;
            var sfc = sft * srl.unitCost;
            spendCostT += sfc;
            st.lots.push({
              openDate: srl.openDate,
              closeDate: t.date,
              qty: sft,
              proceeds: 0,
              cost: sfc,
              gain: -sfc,
              holdingDays: ledgerHoldingDays(srl.openDate, t.date),
              buyId: srl.buyId || null,
              sellId: ledgerTradeId(t),
              kind: 'expense'
            });
          }
        });
        st.realized -= spendCostT;
      }
      var netQtyT = keepQtyT;
      if (netQtyT > qtyEps && tQty > 0) {
        for (var ni = 0; ni < removed.length; ni++) {
          var ol = removed[ni];
          var keep = ol.qty * (netQtyT / tQty);
          if (keep > qtyEps) q.push({ qty: keep, unitCost: ol.unitCost, date: ol.openDate, buyId: ol.buyId || null });
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
  var accOfSym = {}; // sym -> account holding it (picks the price kind for shared tickers)
  (trades || []).forEach(function (t) {
    if (!t) return;
    var symAny = ledgerSym(t);
    if (symAny && accOfSym[symAny] === undefined && t.accountId !== undefined) accOfSym[symAny] = t.accountId;
  });
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
    var qtyEps = ledgerQtyEpsilon(sym);
    if (!hasBuy[sym] && !(v.qty > qtyEps) && !(Math.abs(v.realized || 0) > LEDGER_EPS)) return; // skip phantom sell-only rows
    // Unknown live price stays unknown (null) — never coerced to 0, which
    // fabricated a full loss (value 0, unrealized -cost, return -100%).
    var raw = livePriceFor(live, sym, accOfSym[sym]);
    var num = Number(raw);
    var known = isFinite(num) && num > 0;
    var livePrice = known ? num : null;
    var qtyHeld = v.qty || 0;
    if (Math.abs(qtyHeld) < qtyEps) qtyHeld = 0;
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
