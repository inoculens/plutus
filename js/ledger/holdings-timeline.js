'use strict';
// Time-ordered holdings validation.
// A record may only spend what the account held AT THAT POINT in the ledger,
// not what it holds today. Replaying the whole timeline also proves that a
// change never invalidates a later sell/transfer/expense. Ordering matches
// computePortfolio: date first, stable existing order for equal dates.
function timelineHeldKey(accountId, symbol) {
  return String(accountId || '') + '\u0001' + String(symbol || '').trim().toUpperCase();
}

// One pass over the timeline. Returns every outflow that could not be fully
// funded (with engine-like proportional clamping, so a pre-existing bad
// record does not manufacture unrelated later failures).
function timelineOutflowShortfalls(trades) {
  var have = new Map();
  var out = [];
  function get(k) { return have.get(k) || 0; }
  function add(k, q) {
    if (!isFinite(q) || q === 0) return;
    have.set(k, get(k) + q);
  }
  function take(t, k, need, accountId) {
    if (!isFinite(need) || need <= 0) return 1;
    var available = get(k);
    var moved = Math.min(need, Math.max(0, available));
    if (need > moved + ledgerQtyEpsilon(ledgerSym(t))) {
      out.push({
        trade: t,
        key: k,
        accountId: (typeof accountId === 'string' && accountId !== '') ? accountId : t.accountId,
        symbol: ledgerSym(t),
        available: available,
        needed: need,
        shortfall: need - moved
      });
    }
    have.set(k, Math.max(0, available - moved));
    return moved > 0 ? (moved / need) : 0;
  }
  ledgerSortByDate(trades).forEach(function (t) {
    if (!t || typeof t.accountId !== 'string' || t.accountId === '') return;
    var sym = ledgerSym(t);
    if (!sym) return;
    var key = timelineHeldKey(t.accountId, sym);
    if (t.type === 'buy' || t.type === 'income') {
      var qIn = Number(t.qty);
      if (isFinite(qIn) && qIn > 0) add(key, qIn);
      return;
    }
    if (t.type === 'sell' || (t.type === 'expense' && !(t.qty === undefined || t.qty === null || String(t.qty).trim() === ''))) {
      var qOut = Number(t.qty);
      if (!isFinite(qOut) || qOut <= 0) return;
      take(t, key, qOut);
      return;
    }
    if (t.type !== 'transfer') return;
    var qSent = Number(t.qty);
    if (!isFinite(qSent) || qSent <= 0) return;
    var nfRaw = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
    var nf = (isFinite(nfRaw) && nfRaw >= 0 && nfRaw < qSent) ? nfRaw : null;
    if (nf === null) return; // structural validation rejects this row
    var legs = transferSourceLegs(t);
    if (!legs.length) return;
    var totalNet = qSent - nf;
    var movedNet = 0;
    // Each source pays its own gross amount; the fee is taken from its own
    // leg and the remainder funds outputs by net contribution.
    legs.forEach(function (leg) {
      var lk = timelineHeldKey(leg.accountId, sym);
      var scale = take(t, lk, leg.qty, leg.accountId);
      var moved = leg.qty * scale;
      var netMoved = moved - leg.fee * scale;
      leg.__key = lk;
      leg.__netMoved = netMoved;
      movedNet += netMoved;
    });
    var distScale = totalNet > 0 ? (movedNet / totalNet) : 0;
    var outs = transferOutputsOf(t);
    var hasTo = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
    if (!outs.length && !hasTo) {
      // Same-account move: only each source's fee is lost.
      legs.forEach(function (leg) {
        if (leg.__netMoved > 0) add(leg.__key, leg.__netMoved);
      });
      return;
    }
    if (outs.length) {
      // Multi-output remainder that stayed in the source accounts. Legs that
      // also receive a recipient row fund their own return first, so the
      // remainder only draws on what they have left.
      var selfBack = transferSelfQtyOf(t);
      if (selfBack > 0 && totalNet > 0) {
        var selfItems = [{ qty: selfBack * distScale, destId: '' }];
        outs.forEach(function (o) {
          var dest = transferFundingDest(o, sym);
          if (dest) selfItems.push({ qty: Number(o.qty) * distScale, destId: dest });
        });
        var selfParts = transferFundingParts(
          legs.map(function (leg) { return leg.__netMoved; }),
          legs.map(function (leg) { return leg.accountId; }),
          selfItems
        );
        legs.forEach(function (leg, li) {
          var back = selfParts[0][li];
          if (back > 0) add(leg.__key, back);
        });
      }
    }
    outs.forEach(function (o) {
      if (!isTransferOutputInternal(o)) return;
      var destId = String(o.toAccountId).trim();
      if (!destId) return;
      var destSym = (o.toSymbol !== undefined && o.toSymbol !== null && String(o.toSymbol).trim() !== '')
        ? String(o.toSymbol).trim().toUpperCase() : sym;
      var arrival = 0;
      if (destSym !== sym) {
        var cross = Number(o.toQty);
        arrival = (isFinite(cross) && cross > 0 ? cross : 0) * distScale;
      } else {
        arrival = Number(o.qty) * distScale;
      }
      if (isFinite(arrival) && arrival > 0) add(timelineHeldKey(destId, destSym), arrival);
    });
  });
  return out;
}

// Substitute a draft (or a swap's two drafts) into the timeline and compare
// against the original run. Only a newly created / worsened shortfall blocks:
// note-only edits stay possible even in books that already contain legacy
// inconsistencies, while any change that breaks another record is rejected.
function heldTimelineConflict(allTrades, draftOrDrafts, editingTradeId) {
  var drafts = Array.isArray(draftOrDrafts) ? draftOrDrafts.slice() : [draftOrDrafts];
  var original = allTrades || [];
  var list = [];
  var oldTrade = null;
  var i;
  if (editingTradeId) {
    for (i = 0; i < original.length; i++) {
      if (original[i] && original[i].id === editingTradeId) {
        oldTrade = original[i];
        list.push(drafts[0]);
      } else {
        list.push(original[i]);
      }
    }
  } else {
    list = original.slice();
  }
  if (!oldTrade) {
    drafts.forEach(function (d) { if (d) list.push(d); });
  } else {
    for (i = 1; i < drafts.length; i++) if (drafts[i]) list.push(drafts[i]);
  }
  var baseMap = new Map();
  timelineOutflowShortfalls(original).forEach(function (e) {
    var m = baseMap.get(e.trade);
    if (!m) { m = new Map(); baseMap.set(e.trade, m); }
    m.set(e.key, e.shortfall);
  });
  var next = timelineOutflowShortfalls(list);
  for (i = 0; i < next.length; i++) {
    var e = next[i];
    var prevMap = (oldTrade && e.trade === drafts[0]) ? baseMap.get(oldTrade) : baseMap.get(e.trade);
    var prevShort = prevMap ? (prevMap.get(e.key) || 0) : 0;
    if (e.shortfall > prevShort + ledgerQtyEpsilon(e.symbol)) {
      e.isDraft = drafts.indexOf(e.trade) !== -1;
      return e;
    }
  }
  return null;
}
