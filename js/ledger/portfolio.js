'use strict';
// Joint per-account portfolio engine (transfers move basis between accounts).
// Processes ALL trades once in date order, keeping separate cost queues per
// (accountId, symbol). Transfers move cost/lots from source to dest at the
// source's basis (no P&L except network + fiat fees, which are real losses).
// Returns { byAccount: {accId: Map(sym->pos)}, analytics, lots }.
// Positions use the same live-price unknown rules as computePositions.
function computePortfolio(allTrades, live, method) {
  var isFifo = method === 'fifo';
  var sorted = ledgerSortByDate(allTrades || []);
  var acctState = dict(); // accId -> sym -> {qty,cost,realized,income,fees,fiatFees,queue,lots}
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
  function avgOf(s, sym) { return s.qty > ledgerQtyEpsilon(sym) ? s.cost / s.qty : 0; }
  sorted.forEach(function (t) {
    if (!t) return;
    var sym = ledgerSym(t);
    if (!sym) return;
    var qtyEps = ledgerQtyEpsilon(sym);
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
      if (isFifo) sb.queue.push({ qty: qb, unitCost: qb > 0 ? cb / qb : 0, date: t.date, buyId: ledgerTradeId(t) });
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
      if (isFifo) si.queue.push({ qty: qi, unitCost: qi > 0 ? ci / qi : 0, date: t.date, buyId: ledgerTradeId(t) });
    } else if (t.type === 'sell') {
      var qs = Number(t.qty);
      if (!isFinite(qs) || qs <= 0) return;
      var ss = stFor(t.accountId, sym);
      if (ss.qty <= qtyEps && (!isFifo || ss.queue.reduce(function (s, l) { return s + l.qty; }, 0) <= qtyEps)) return;
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
        while (left > qtyEps && ss.queue.length) {
          var lot = ss.queue[0];
          var take = Math.min(lot.qty, left);
          var pc = take * unitP;
          var cc = take * lot.unitCost;
          ss.lots.push({ openDate: lot.date, closeDate: t.date, qty: take, proceeds: pc, cost: cc, gain: pc - cc, holdingDays: ledgerHoldingDays(lot.date, t.date), accountId: t.accountId, symbol: sym, buyId: lot.buyId || null, sellId: ledgerTradeId(t), kind: 'sell' });
          ss.realized += pc - cc;
          totals.realized += pc - cc;
          lot.qty -= take;
          left -= take;
          if (lot.qty <= qtyEps) ss.queue.shift();
        }
        ss.qty -= sQty;
        // cost derived from queue; recompute for avg field
        var rc = 0, rq = 0;
        ss.queue.forEach(function (l) { rq += l.qty; rc += l.qty * l.unitCost; });
        ss.cost = rc;
        if (Math.abs(ss.qty) < qtyEps && Math.abs(rq) < qtyEps) { ss.qty = 0; ss.cost = 0; }
        else ss.qty = rq;
        totals.withdrawn += proceeds;
        totals.feesFiat += n.feeMain;
        ss.fees += n.feeMain;
      } else {
        var sQty2 = Math.min(qs, ss.qty);
        if (qs > ss.qty && qs > 0) proceeds = proceeds * (sQty2 / qs);
        var a2 = avgOf(ss, sym);
        ss.realized += proceeds - a2 * sQty2;
        totals.realized += proceeds - a2 * sQty2;
        ss.cost -= a2 * sQty2;
        ss.qty -= sQty2;
        if (Math.abs(ss.qty) < qtyEps) { ss.qty = 0; ss.cost = 0; }
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
            while (lE > qtyEps && se.queue.length) {
              var le2 = se.queue[0];
              var tk = Math.min(le2.qty, lE);
              var ce2 = tk * le2.unitCost;
              se.lots.push({ openDate: le2.date, closeDate: t.date, qty: tk, proceeds: 0, cost: ce2, gain: -ce2, holdingDays: ledgerHoldingDays(le2.date, t.date), accountId: t.accountId, symbol: sym, kind: 'expense', buyId: le2.buyId || null, sellId: ledgerTradeId(t) });
              se.realized -= ce2;
              totals.realized -= ce2;
              totals.feesCryptoMain += ce2;
              totals.feesCryptoQty += tk;
              le2.qty -= tk;
              lE -= tk;
              if (le2.qty <= qtyEps) se.queue.shift();
            }
            var rq2 = 0, rc2 = 0;
            se.queue.forEach(function (l) { rq2 += l.qty; rc2 += l.qty * l.unitCost; });
            se.qty = rq2; se.cost = rc2;
          } else if (se.qty > qtyEps) {
            var rqe = Math.min(qe, se.qty);
            var ae = avgOf(se, sym);
            var cre = ae * rqe;
            se.realized -= cre;
            totals.realized -= cre;
            totals.feesCryptoMain += cre;
            totals.feesCryptoQty += rqe;
            se.cost -= cre;
            se.qty -= rqe;
            if (Math.abs(se.qty) < qtyEps) { se.qty = 0; se.cost = 0; }
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
      // Multi-source: every leg pays its own share from its own FIFO queue or
      // average basis. Outputs and the same-account remainder are then
      // apportioned by each leg's net contribution, so attributing more fee
      // to one source shifts who actually funds the recipients.
      var legsP = transferSourceLegs(t);
      if (!legsP.length) return;
      var outsP = transferOutputsOf(t);
      var hasToP = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
      // No destination: on-chain move inside the source accounts (fresh
      // address, same owner) — each source keeps its own net; only its fee
      // is lost. With recipients each internal row is credited at the
      // contributing sources' basis; external spend rows book their cost as
      // a loss. Legacy parity: a named destination counts as active even
      // when the source holds nothing.
      if (outsP.length === 1 && isTransferOutputInternal(outsP[0])) {
        try { stFor(String(outsP[0].toAccountId).trim(), sym).touched = true; } catch (e) { /* ignore */ }
      }
      var fiatT = n.netMain; // all-in fiat cost (fee display-only)
      var feeFiatT = n.feeMain;
      var totalNetP = qt - nft;
      var workP = [];
      legsP.forEach(function (leg) {
        var src = stFor(leg.accountId, sym);
        src.touched = true;
        var fiatShare = qt > 0 ? fiatT * (leg.qty / qt) : 0;
        var feeShare = qt > 0 ? feeFiatT * (leg.qty / qt) : 0;
        var rec = { leg: leg, src: src, moved: 0, fee: 0, net: 0, removed: [], costOut: 0, feeCost: 0, costNet: 0 };
        if (isFifo) {
          var heldP = src.queue.reduce(function (s, l) { return s + l.qty; }, 0);
          if (heldP > qtyEps) {
            var movedP = Math.min(leg.qty, heldP);
            var scP = leg.qty > 0 ? movedP / leg.qty : 0;
            var feeP = leg.fee * scP;
            var ltP = movedP;
            while (ltP > qtyEps && src.queue.length) {
              var ltfP = src.queue[0];
              var tkP = Math.min(ltfP.qty, ltP);
              rec.removed.push({ qty: tkP, unitCost: ltfP.unitCost, openDate: ltfP.date, buyId: ltfP.buyId || null });
              ltfP.qty -= tkP;
              ltP -= tkP;
              if (ltfP.qty <= qtyEps) src.queue.shift();
            }
            var costP = rec.removed.reduce(function (s, l) { return s + l.qty * l.unitCost; }, 0);
            var feeCostP = movedP > 0 ? costP * (feeP / movedP) : 0;
            if (feeP > qtyEps && movedP > 0) {
              rec.removed.forEach(function (rl) {
                var fshP = rl.qty * (feeP / movedP);
                if (fshP <= qtyEps) return;
                var fcoP = fshP * rl.unitCost;
                src.lots.push({ openDate: rl.openDate, closeDate: t.date, qty: fshP, proceeds: 0, cost: fcoP, gain: -fcoP, holdingDays: ledgerHoldingDays(rl.openDate, t.date), accountId: leg.accountId, symbol: sym, kind: 'network-fee', buyId: rl.buyId || null, sellId: ledgerTradeId(t) });
              });
            }
            rec.moved = movedP;
            rec.fee = feeP;
            rec.net = movedP - feeP;
            rec.costOut = costP;
            rec.feeCost = feeCostP;
            rec.costNet = costP - feeCostP;
            var frqP = 0, frcP = 0;
            src.queue.forEach(function (l) { frqP += l.qty; frcP += l.qty * l.unitCost; });
            src.qty = frqP;
            src.cost = frcP;
          }
        } else if (src.qty > qtyEps) {
          var movedA = Math.min(leg.qty, src.qty);
          var scA = leg.qty > 0 ? movedA / leg.qty : 0;
          var feeA = leg.fee * scA;
          var aF = avgOf(src, sym);
          var costA = aF * movedA;
          var feeCostA = aF * feeA;
          src.qty -= movedA;
          src.cost -= costA;
          if (Math.abs(src.qty) < qtyEps) { src.qty = 0; src.cost = 0; }
          rec.moved = movedA;
          rec.fee = feeA;
          rec.net = movedA - feeA;
          rec.costOut = costA;
          rec.feeCost = feeCostA;
          rec.costNet = costA - feeCostA;
        }
        if (rec.moved > qtyEps) {
          src.realized -= rec.feeCost + fiatShare;
          totals.realized -= rec.feeCost + fiatShare;
          totals.feesCryptoMain += rec.feeCost;
          totals.feesCryptoQty += rec.fee;
          totals.feesFiat += feeShare;
          src.fees += feeShare;
        } else if (fiatShare > 0) {
          // Legacy parity: an empty source still books the fiat total and
          // the display fee, but never a crypto fee it did not pay.
          src.realized -= fiatShare;
          totals.realized -= fiatShare;
          totals.feesFiat += feeShare;
        }
        totals.expensesFiat += fiatShare;
        workP.push(rec);
      });
      var totalNetMovedP = workP.reduce(function (s, w) { return s + w.net; }, 0);
      if (!outsP.length && !hasToP) {
        // Same-account move: each source keeps its own net at its own basis.
        workP.forEach(function (w) {
          if (w.net <= qtyEps || w.moved <= qtyEps) return;
          if (isFifo) {
            var backP = w.net / w.moved;
            w.removed.forEach(function (rl) {
              var keepP = rl.qty * backP;
              if (keepP > qtyEps) w.src.queue.push({ qty: keepP, unitCost: rl.unitCost, date: rl.openDate, buyId: rl.buyId || null });
            });
          } else {
            w.src.qty += w.net;
            w.src.cost += w.costNet;
          }
        });
      } else if (totalNetMovedP > qtyEps) {
        var distScaleP = totalNetP > 0 ? totalNetMovedP / totalNetP : 0;
        var fifoScaleForP = function (w, partQty) {
          return w.moved > qtyEps ? partQty / w.moved : 0;
        };
        // Every outflow (received-back remainder, each recipient row) is funded
        // leg by leg: a source that is also a same-asset recipient pays its own
        // return first, the rest is pooled by net (transferFundingParts).
        var fundingItemsP = [];
        var selfP = transferSelfQtyOf(t);
        if (selfP > 0) fundingItemsP.push({ kind: 'self', qty: selfP * distScaleP, destId: '' });
        outsP.forEach(function (o) {
          var oq = Number(o.qty);
          if (!isFinite(oq) || oq <= 0) return;
          fundingItemsP.push({ kind: 'output', o: o, qty: oq * distScaleP, destId: transferFundingDest(o, sym) });
        });
        var fundingPartsP = transferFundingParts(
          workP.map(function (w) { return (w.net > qtyEps && w.moved > qtyEps) ? w.net : 0; }),
          workP.map(function (w) { return w.leg.accountId; }),
          fundingItemsP
        );
        var distributeP = function (item, itemParts) {
          if (!item || !isFinite(item.qty) || item.qty <= qtyEps) return;
          var isInternalP = item.kind === 'output' && isTransferOutputInternal(item.o);
          var dSymP = sym;
          if (isInternalP && item.o.toSymbol !== undefined && item.o.toSymbol !== null && String(item.o.toSymbol).trim() !== '') {
            dSymP = String(item.o.toSymbol).trim().toUpperCase();
          }
          var dstP = null;
          workP.forEach(function (w, wi) {
            if (w.net <= qtyEps || w.moved <= qtyEps) return;
            var partQty = itemParts[wi];
            if (!isFinite(partQty) || partQty <= qtyEps) return;
            if (item.kind === 'self') {
              if (isFifo) {
                var backS = fifoScaleForP(w, partQty);
                w.removed.forEach(function (rl) {
                  var keepS = rl.qty * backS;
                  if (keepS > qtyEps) w.src.queue.push({ qty: keepS, unitCost: rl.unitCost, date: rl.openDate, buyId: rl.buyId || null });
                });
              } else {
                w.src.qty += partQty;
                w.src.cost += w.costNet * (partQty / w.net);
              }
              return;
            }
            if (isInternalP) {
              var arrPart = partQty;
              if (dSymP !== sym && item.o.toQty !== undefined && item.o.toQty !== null && String(item.o.toQty).trim() !== '') {
                arrPart = Number(item.o.toQty) * distScaleP * (w.net / totalNetMovedP);
              }
              if (!isFinite(arrPart) || arrPart <= 0) return;
              if (!dstP) { dstP = stFor(String(item.o.toAccountId).trim(), dSymP); dstP.touched = true; }
              if (isFifo) {
                var keepD = fifoScaleForP(w, partQty);
                var arrivalScale = arrPart / partQty;
                if (!isFinite(arrivalScale) || arrivalScale <= 0) return;
                w.removed.forEach(function (rl) {
                  var kd = rl.qty * keepD * arrivalScale;
                  if (kd > qtyEps) dstP.queue.push({ qty: kd, unitCost: rl.unitCost / arrivalScale, date: rl.openDate, buyId: rl.buyId || null });
                });
              } else {
                dstP.qty += arrPart;
                dstP.cost += w.costNet * (partQty / w.net);
              }
              return;
            }
            if (item.o.spend === false) return;
            if (isFifo) {
              var spendS = fifoScaleForP(w, partQty);
              w.removed.forEach(function (rl) {
                var xshP = rl.qty * spendS;
                if (xshP <= qtyEps) return;
                var xcoP = xshP * rl.unitCost;
                w.src.lots.push({ openDate: rl.openDate, closeDate: t.date, qty: xshP, proceeds: 0, cost: xcoP, gain: -xcoP, holdingDays: ledgerHoldingDays(rl.openDate, t.date), accountId: w.leg.accountId, symbol: sym, kind: 'expense', buyId: rl.buyId || null, sellId: ledgerTradeId(t) });
                w.src.realized -= xcoP;
                totals.realized -= xcoP;
                totals.feesCryptoMain += xcoP;
                totals.feesCryptoQty += xshP;
              });
            } else {
              var xcoA = w.costNet * (partQty / w.net);
              w.src.realized -= xcoA;
              totals.realized -= xcoA;
              totals.feesCryptoMain += xcoA;
              totals.feesCryptoQty += partQty;
            }
          });
        };
        fundingItemsP.forEach(function (item, ii) { distributeP(item, fundingPartsP[ii]); });
      }
      if (isFifo) {
        var dirtyP = [];
        var markDirtyP = function (st2) { if (st2 && dirtyP.indexOf(st2) === -1) dirtyP.push(st2); };
        workP.forEach(function (w) { markDirtyP(w.src); });
        outsP.forEach(function (o) {
          if (!isTransferOutputInternal(o)) return;
          var dSymQ = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
            ? sym : String(o.toSymbol).trim().toUpperCase();
          markDirtyP(stFor(String(o.toAccountId).trim(), dSymQ));
        });
        dirtyP.forEach(function (st2) {
          st2.queue.sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; });
          var sqp = 0, scp = 0;
          st2.queue.forEach(function (l) { sqp += l.qty; scp += l.qty * l.unitCost; });
          st2.qty = sqp;
          st2.cost = scp;
        });
      }
    }
  });
  // Build per-account position maps with live prices.
  var byAccount = dict();
  Object.keys(acctState).forEach(function (accId) {
    var m = new Map();
    var syms = acctState[accId];
    Object.keys(syms).forEach(function (sym) {
      var s = syms[sym];
      if (!s.touched) return; // never active: drop phantom (e.g. sell-only with no inventory)
      var raw = livePriceFor(live, sym, accId);
      var num = Number(raw);
      var known = isFinite(num) && num > 0;
      var qtyHeld = Math.abs(s.qty) < ledgerQtyEpsilon(sym) ? 0 : s.qty;
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
