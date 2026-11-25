'use strict';
// Record validation before saving (shape, amounts, held quantities).

function validateTrade(t, heldQty) {
  t = t || {};
  var type = t.type;
  if (type !== undefined && TRADE_TYPES.indexOf(type) === -1) {
    return 'type must be buy, sell, transfer, income or expense';
  }
  var effType = type || 'buy';
  if (effType === 'expense') {
    var hasQ = !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '');
    var hasT = !(t.total === undefined || t.total === null || String(t.total).trim() === '');
    if (!hasQ && !hasT) return 'expense needs qty or total';
    if (hasQ) {
      var qex = Number(t.qty);
      if (!isFinite(qex) || qex <= 0) return 'qty must be > 0';
      if (typeof heldQty === 'number' && isFinite(heldQty)) {
        if (qex > heldQty + ledgerQtyEpsilon(t.symbol)) return 'oversell: max sellable is ' + heldQty;
      }
    }
    if (hasT) {
      var tex = Number(t.total);
      if (!isFinite(tex) || tex < 0) return 'total must be >= 0';
      if (!hasQ && tex <= 0) return 'total must be > 0';
    }
  } else {
    if (typeof t.qty !== 'number' && typeof t.qty !== 'string') return 'qty must be > 0';
    if (typeof t.qty === 'string' && t.qty.trim() === '') return 'qty must be > 0';
    var qty = Number(t.qty);
    if (!isFinite(qty) || qty <= 0) return 'qty must be > 0';
    if ((effType === 'sell' || effType === 'transfer') && typeof heldQty === 'number' && isFinite(heldQty)) {
      if (qty > heldQty + ledgerQtyEpsilon(t.symbol)) return 'oversell: max sellable is ' + heldQty;
    }
  }
  if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
    if (typeof t.total !== 'number' && typeof t.total !== 'string') return 'total must be >= 0';
    var total = Number(t.total);
    if (!isFinite(total) || total < 0) return 'total must be >= 0';
  }
  if (t.fee !== undefined && t.fee !== null && String(t.fee).trim() !== '') {
    if (typeof t.fee !== 'number' && typeof t.fee !== 'string') return 'fee must be >= 0';
    var fee = Number(t.fee);
    if (!isFinite(fee) || fee < 0) return 'fee must be >= 0';
  }
  // One fiat per trade: the stated total already includes the fee, so the fee
  // cannot exceed an explicitly stated positive total (standalone fees with
  // no total stay allowed).
  if (t.fee !== undefined && t.fee !== null && String(t.fee).trim() !== '' &&
      t.total !== undefined && t.total !== null && String(t.total).trim() !== '') {
    var vFee = Number(t.fee);
    var vTot = Number(t.total);
    if (isFinite(vTot) && vTot > 0 && isFinite(vFee) && vFee > vTot) {
      return 'fee cannot exceed total';
    }
  }
  if (t.networkFee !== undefined && t.networkFee !== null && String(t.networkFee).trim() !== '') {
    if (typeof t.networkFee !== 'number' && typeof t.networkFee !== 'string') return 'network fee must be >= 0';
    var nf = Number(t.networkFee);
    if (!isFinite(nf) || nf < 0) return 'network fee must be >= 0';
    if (typeof t.qty === 'number' || typeof t.qty === 'string') {
      var qq = Number(t.qty);
      if (isFinite(qq) && qq > 0 && nf >= qq) return 'network fee must be < qty';
    }
  }
  if (t.feeCurrency !== undefined && t.feeCurrency !== null && String(t.feeCurrency).trim() !== '') {
    if (!isValidCurrencyCode(t.feeCurrency)) return 'fee currency invalid';
  }
  if (!isValidTxid(t.txid)) return 'transaction ID looks invalid — paste the full tx hash';
  if (t.attachment !== undefined && t.attachment !== null && !isValidAttachment(t.attachment)) return 'attachment is invalid — re-attach the file';
  if (t.currency !== undefined && t.currency !== null && String(t.currency).trim() !== '') {
    if (!isValidCurrencyCode(t.currency)) return 'currency invalid';
  }
  if (effType === 'transfer') {
    var srcErrV = transferSourcesStructuralError(t);
    if (srcErrV) return srcErrV;
    var srcIdsV = transferSourceIdsOfRaw(t);
    var sourceOverlapAllowedV = Array.isArray(t.sources) && t.sources.length > 1;
    var hasToV = t.toAccountId !== undefined && t.toAccountId !== null && String(t.toAccountId).trim() !== '';
    var outsV = (t.outputs !== undefined && t.outputs !== null && Array.isArray(t.outputs) && t.outputs.length) ? t.outputs : null;
    if (outsV) {
      if (outsV.length > TRANSFER_MAX_OUTPUTS) return 'too many recipients (max 20)';
      if (hasToV) return 'transfer has both a destination and recipients';
      var sumQV = 0, sumFV = 0, selfVV = 0;
      for (var vi = 0; vi < outsV.length; vi++) {
        if (!isValidTransferOutput(outsV[vi], t.symbol, sourceOverlapAllowedV ? null : t.accountId, undefined, sourceOverlapAllowedV ? null : srcIdsV)) return 'recipient ' + (vi + 1) + ' is invalid';
        sumQV += Number(outsV[vi].qty);
        if (outsV[vi].fee !== undefined && outsV[vi].fee !== null && String(outsV[vi].fee).trim() !== '') sumFV += Number(outsV[vi].fee);
      }
      if (t.selfQty !== undefined && t.selfQty !== null && String(t.selfQty).trim() !== '') {
        if (typeof t.selfQty !== 'number' && typeof t.selfQty !== 'string') return 'received back must be >= 0';
        selfVV = Number(t.selfQty);
        if (!isFinite(selfVV) || selfVV < 0) return 'received back must be >= 0';
      }
      var qVV = Number(t.qty);
      var nfVV = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
      if (isFinite(qVV) && qVV > 0 && isFinite(nfVV) && nfVV >= 0) {
        if (Math.abs(sumQV + selfVV + nfVV - qVV) > 1e-8) return 'recipients + received back + fee must equal sent';
        if (sumFV - nfVV > 1e-12) return 'recipient fees exceed the transfer fee';
      }
    } else if (hasToV && t.accountId && t.toAccountId && t.accountId === t.toAccountId) return 'transfer needs two different accounts';
    else if (hasToV && srcIdsV.indexOf(String(t.toAccountId).trim()) !== -1) return 'a source account cannot also receive';
  }
  if (typeof t.date === 'string' && t.date.length > 0) {
    if (!isValidDateStr(t.date)) return 'date must be a valid ISO calendar date';
    if (isFutureDateStr(t.date)) return 'date cannot be in the future';
  }
  return null;
}
