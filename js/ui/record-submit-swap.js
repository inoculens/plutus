'use strict';
// Record form submit, swaps. A swap is stored as two linked legs (a sell and
// a buy sharing a swapId). New swaps and swap edits validate both legs, lock
// the FX rate of the fiat value and save the pair together. onTradeSubmit
// calls these with the form values it already read and checked.

// New swap: creates the linked sell + buy pair.
function submitNewSwap(ctx) {
  var st0 = ctx.st0, main = ctx.main, acc = ctx.acc, accountId = ctx.accountId;
  var symbol = ctx.symbol, isCashAcc = ctx.isCashAcc, date = ctx.date, note = ctx.note;
  var txid = ctx.txid, txidTo = ctx.txidTo, manualRate = ctx.manualRate, manualPrice = ctx.manualPrice;
  var lockSubmit = ctx.lockSubmit, fxError = ctx.fxError;
  var toAccSwap = accountById(st0, uiVal('t-toaccount', ''));
  if (!toAccSwap) { tradeFormError('Pick a destination account for the swap.'); return; }
  if (toAccSwap.id === accountId) { tradeFormError('Swap needs two different accounts.'); return; }
  if (isCashAcc || isCashKind(toAccSwap.kind)) { tradeFormError('Cash accounts do not swap — record income, expense or transfer instead.'); return; }
  var fromSym = symbol;
  var toSym = String(toAccSwap.ticker).toUpperCase();
  if (fromSym === toSym) { tradeFormError('Same asset — use Transfer instead of Swap.'); return; }
  var fromQty = exactQtyValue(uiVal('t-qty', ''), fromSym);
  var toQty = exactQtyValue(uiVal('t-toqty', ''), toSym);
  var swapTotalRaw = String(uiVal('t-total', '')).trim();
  var swapTotal = (swapTotalRaw === '') ? null : Number(swapTotalRaw);
  var ccySelS = uiVal('t-currency', 'EUR');
  var swapCcy = (ccySelS === 'CUSTOM' ? uiVal('t-custom-ccy', '').trim().toUpperCase() : String(ccySelS).toUpperCase());
  var feeRawS = uiVal('t-fee', '').trim();
  var feeS = (feeRawS === '') ? 0 : Number(feeRawS);
  var feeCcyS = swapCcy; // one fiat per trade: fee follows the trade currency
  if (!isFinite(fromQty) || fromQty <= 0) { tradeFormError('From quantity must be > 0.'); return; }
  if (!isFinite(toQty) || toQty <= 0) { tradeFormError('Received quantity must be > 0.'); return; }
  if (swapTotal !== null && (!isFinite(swapTotal) || swapTotal <= 0)) { tradeFormError('Fiat value must be > 0 — or leave it empty to calculate it automatically.'); return; }
  if (!isValidCurrencyCode(swapCcy)) { tradeFormError('Currency code invalid.'); return; }
  if (!isFinite(feeS) || feeS < 0) { tradeFormError('Fee must be >= 0.'); return; }
  var swapDraftSell = { type: 'sell', symbol: fromSym, qty: fromQty, accountId: accountId, date: date };
  var swapDraftBuy = { type: 'buy', symbol: toSym, qty: toQty, accountId: toAccSwap.id, date: date };
  var swapConflict = heldTimelineConflict(st0.trades, [swapDraftSell, swapDraftBuy], null);
  if (swapConflict) {
    tradeFormError(heldConflictMessage(swapConflict, [swapDraftSell, swapDraftBuy], st0));
    return;
  }
  lockSubmit(true, 'Saving…');
  function proceedSwapCreateWithAttachment(lock) {
    function go() {
      deferTradeSubmitWork(function () {
        try {
          attResolveForSave(function (err, meta) {
            if (err) { tradeFormError(err); lockSubmit(false, 'Add record'); return; }
            proceedSwapCreate(lock, meta);
          });
        } catch (e) {
          tradeFormError('Could not save the attachment — record was not saved.');
          lockSubmit(false, 'Add record');
        }
      });
    }
    if (swapTotal !== null) { go(); return; }
    // Blank fiat value: derive it from the historical rates on the date.
    lockSubmit(true, 'Calculating value…');
    swapAutoFiatValue(fromSym, fromQty, (acc && acc.kind) || undefined, toSym, toQty, (toAccSwap && toAccSwap.kind) || undefined, date, swapCcy).then(function (v) {
      if (v === null) {
        tradeFormError('Could not calculate the fiat value for this date — enter it in Fiat value (optional) and save again.');
        lockSubmit(false, 'Add record');
        return;
      }
      swapTotal = v;
      go();
    }, function () {
      tradeFormError('Could not calculate the fiat value for this date — enter it in Fiat value (optional) and save again.');
      lockSubmit(false, 'Add record');
    });
  }
  function proceedSwapCreate(lock, attMeta) {
    var st = loadState();
    var swapId = uid();
    var createdAt = new Date().toISOString();
    var cleanNote = swapNoteClean(note);
    var sellLeg = { id: uid(), type: 'sell', symbol: fromSym, qty: fromQty, total: swapTotal, currency: swapCcy, date: date, fee: feeS, feeCurrency: feeCcyS, note: cleanNote, fxLock: lock, accountId: accountId, swapId: swapId, createdAt: createdAt };
    var buyLeg = { id: uid(), type: 'buy', symbol: toSym, qty: toQty, total: swapTotal, currency: swapCcy, date: date, fee: 0, feeCurrency: swapCcy, note: cleanNote, fxLock: lock, accountId: toAccSwap.id, swapId: swapId, createdAt: createdAt };
    // One swap record: the receipt rides both linked legs; each leg has its own txid.
    if (attMeta && attMeta !== 'keep') {
      sellLeg.attachment = attMeta;
      buyLeg.attachment = attMeta;
    }
    // Each leg keeps its own hash: sent on the sell leg, received on the buy leg.
    if (txid !== '') sellLeg.txid = txid;
    if (txidTo !== '') buyLeg.txid = txidTo;
    if (manualPrice !== null) {
      // Manual quote is for the received asset, denominated in the trade's
      // own Currency (like total and fee) — never the header display fiat.
      // The sold leg freezes via history.
      buyLeg.execLock = { price: manualPrice, vs: String(swapCcy).toUpperCase(), source: 'manual' };
    }
    var e1 = validateTrade(sellLeg, 1e18); // structural; holdings are checked on the timeline
    if (e1) { tradeFormError(e1); lockSubmit(false, 'Add record'); return; }
    var e2 = validateTrade(buyLeg, 1e18);
    if (e2) { tradeFormError(e2); lockSubmit(false, 'Add record'); return; }
    try {
      var cSwap = heldTimelineConflict(st.trades, [sellLeg, buyLeg], null);
      if (cSwap) {
        tradeFormError(heldConflictMessage(cSwap, [sellLeg, buyLeg], st));
        lockSubmit(false, 'Add record');
        return;
      }
    } catch (e) { /* validation continues; engine clamps anyway */ }
    st.trades.push(sellLeg);
    st.trades.push(buyLeg);
    if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Add record'); return; }
    // Freeze reference exec quotes in the background (saving never waits).
    try { freezeExecLock(sellLeg.id, fromSym, date, String(main).toUpperCase(), (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
    try { freezeExecLock(buyLeg.id, toSym, date, String(main).toUpperCase(), (toAccSwap && toAccSwap.kind) || undefined); } catch (e) { /* ignore */ }
    uiSetVal('t-qty', ''); uiSetVal('t-toqty', ''); uiSetVal('t-total', ''); uiSetVal('t-note', ''); uiSetVal('t-txid', ''); uiSetVal('t-txid-to', ''); uiSetVal('t-manual-rate', ''); uiSetVal('t-manual-price', '');
    var dd = document.getElementById('t-date'); if (dd) dd.value = todayDmy();
    attReset(attMeta && attMeta !== 'keep' ? attMeta : null);
    tradeFormError(null);
    lockSubmit(false, 'Add record');
    refreshPrices();
    try { tradePageByAccount[accountId] = 0; } catch (e) { /* ignore */ }
    try { tradePageByAccount[toAccSwap.id] = 0; } catch (e) { /* ignore */ }
    navTo(accountId);
    render();
    closeDialog('trade-dialog');
  }
  (function resolveSwapFx() {
    var mainU = String(main).toUpperCase();
    var needTotalS = (swapCcy !== mainU);
    function lock11S(f) { return { pair: f + '/' + mainU, rate: 1, source: '1:1', interpolated: false }; }
    if (!needTotalS) {
      proceedSwapCreateWithAttachment(lock11S(swapCcy));
      return;
    }
    if (manualRate !== null) {
      proceedSwapCreateWithAttachment({ pair: swapCcy + '/' + mainU, rate: manualRate, source: 'manual', interpolated: false });
      return;
    }
    lockSubmit(true, 'Saving…');
    fetchEcbRate(date, swapCcy, mainU).then(function (tRes) {
      var tl = { pair: swapCcy + '/' + mainU, rate: tRes.rate, source: tRes.source, interpolated: !!tRes.interpolated };
      try { cacheRate(date, swapCcy, mainU, tRes.rate, tRes.source); saveFxCache(); } catch (e) { /* ignore */ }
      proceedSwapCreateWithAttachment(tl);
    }, function () {
      fxError([swapCcy + ' → ' + mainU]);
    });
  })();
}

// Swap edit: updates the linked sell + buy pair as one record.
function submitSwapEdit(ctx) {
  var st0 = ctx.st0, main = ctx.main, date = ctx.date, note = ctx.note;
  var txid = ctx.txid, txidTo = ctx.txidTo, manualRate = ctx.manualRate, manualPrice = ctx.manualPrice;
  var lockSubmit = ctx.lockSubmit, fxError = ctx.fxError;
  var clickedSwap = null;
  (st0.trades || []).forEach(function (t) { if (t && t.id === editingTradeId) clickedSwap = t; });
  var pairE = swapPairForTrade(st0, clickedSwap);
  if (!pairE) {
    tradeFormError('This swap\'s linked leg is missing — delete the record and re-enter the swap.');
    return;
  }
  var fromAccE = accountById(st0, uiVal('t-account', '')) || accountById(st0, pairE.sell.accountId);
  var toAccE = accountById(st0, uiVal('t-toaccount', ''));
  if (!fromAccE || !toAccE) { tradeFormError('Pick both swap accounts.'); return; }
  if (fromAccE.id === toAccE.id) { tradeFormError('Swap needs two different accounts.'); return; }
  if (isCashKind(fromAccE.kind) || isCashKind(toAccE.kind)) { tradeFormError('Cash accounts do not swap — record income, expense or transfer instead.'); return; }
  var fromSymE = String(fromAccE.ticker).toUpperCase();
  var toSymE = String(toAccE.ticker).toUpperCase();
  if (fromSymE === toSymE) { tradeFormError('Same asset — use Transfer instead of Swap.'); return; }
  var fromQtyE = exactQtyValue(uiVal('t-qty', ''), fromSymE);
  var toQtyE = exactQtyValue(uiVal('t-toqty', ''), toSymE);
  var totalERaw = String(uiVal('t-total', '')).trim();
  var totalE = (totalERaw === '') ? null : Number(totalERaw);
  var ccySelE = uiVal('t-currency', 'EUR');
  var swapCcyE = (ccySelE === 'CUSTOM' ? uiVal('t-custom-ccy', '').trim().toUpperCase() : String(ccySelE).toUpperCase());
  var feeRawE = uiVal('t-fee', '').trim();
  var feeE = (feeRawE === '') ? 0 : Number(feeRawE);
  if (!isFinite(fromQtyE) || fromQtyE <= 0) { tradeFormError('From quantity must be > 0.'); return; }
  if (!isFinite(toQtyE) || toQtyE <= 0) { tradeFormError('Received quantity must be > 0.'); return; }
  if (totalE !== null && (!isFinite(totalE) || totalE <= 0)) { tradeFormError('Fiat value must be > 0 — or leave it empty to calculate it automatically.'); return; }
  if (!isValidCurrencyCode(swapCcyE)) { tradeFormError('Currency code invalid.'); return; }
  if (!isFinite(feeE) || feeE < 0) { tradeFormError('Fee must be >= 0.'); return; }
  var sellDraftE = { id: pairE.sell.id, type: 'sell', symbol: fromSymE, qty: fromQtyE, accountId: fromAccE.id, date: date };
  var buyDraftE = { id: pairE.buy.id, type: 'buy', symbol: toSymE, qty: toQtyE, accountId: toAccE.id, date: date };
  try {
    var cSellE = heldTimelineConflict(st0.trades, sellDraftE, pairE.sell.id);
    if (cSellE) { tradeFormError(heldConflictMessage(cSellE, [sellDraftE], st0)); return; }
    var cBuyE = heldTimelineConflict(st0.trades, buyDraftE, pairE.buy.id);
    if (cBuyE) { tradeFormError(heldConflictMessage(cBuyE, [buyDraftE], st0)); return; }
  } catch (e) { /* validation continues; engine clamps anyway */ }
  function proceedSwapEditWithAttachment(lock) {
    function go() {
      lockSubmit(true, 'Saving…');
      deferTradeSubmitWork(function () {
        try {
          attResolveForSave(function (err, meta) {
            if (err) { tradeFormError(err); lockSubmit(false, 'Save changes'); return; }
            proceedSwapEdit(lock, meta);
          });
        } catch (e) {
          tradeFormError('Could not save the attachment — record was not saved.');
          lockSubmit(false, 'Save changes');
        }
      });
    }
    if (totalE !== null) { go(); return; }
    // Blank fiat value: derive it from the historical rates on the date.
    lockSubmit(true, 'Calculating value…');
    swapAutoFiatValue(fromSymE, fromQtyE, fromAccE.kind || undefined, toSymE, toQtyE, toAccE.kind || undefined, date, swapCcyE).then(function (v) {
      if (v === null) {
        tradeFormError('Could not calculate the fiat value for this date — enter it in Fiat value (optional) and save again.');
        lockSubmit(false, 'Save changes');
        return;
      }
      totalE = v;
      go();
    }, function () {
      tradeFormError('Could not calculate the fiat value for this date — enter it in Fiat value (optional) and save again.');
      lockSubmit(false, 'Save changes');
    });
  }
  function proceedSwapEdit(lock, attMeta) {
    var st = loadState();
    var sellPrev = null;
    var buyPrev = null;
    var sellIdx = -1;
    var buyIdx = -1;
    for (var ei = 0; ei < (st.trades || []).length; ei++) {
      var et = st.trades[ei];
      if (!et) continue;
      if (et.id === pairE.sell.id) { sellPrev = et; sellIdx = ei; }
      if (et.id === pairE.buy.id) { buyPrev = et; buyIdx = ei; }
    }
    if (!sellPrev || !buyPrev || sellPrev.swapId !== buyPrev.swapId) {
      tradeFormError('Trade not found — it may have been deleted. Reopen the swap from the list.');
      lockSubmit(false, 'Save changes');
      return;
    }
    var nowFrom = accountById(st, fromAccE.id);
    var nowTo = accountById(st, toAccE.id);
    if (!nowFrom || !nowTo) {
      tradeFormError('A swap account no longer exists — reopen the swap and pick both accounts again.');
      lockSubmit(false, 'Save changes');
      return;
    }
    var cleanNoteE = swapNoteClean(note);
    var createdAtE = new Date().toISOString();
    function keepExec(prev, sym, allowManual) {
      var f = null;
      try { f = frozenExecOf(prev); } catch (e) { f = null; }
      if (!f) return null;
      if (!allowManual && String(f.source).toLowerCase() === 'manual') return null;
      if (prev.date !== date) return null;
      if (String(prev.symbol || '').toUpperCase() !== String(sym || '').toUpperCase()) return null;
      return { price: f.price, vs: f.vs, source: f.source };
    }
    var sellNew = {
      id: sellPrev.id,
      type: 'sell',
      symbol: fromSymE,
      qty: fromQtyE,
      total: totalE,
      currency: swapCcyE,
      date: date,
      fee: feeE,
      feeCurrency: swapCcyE,
      note: cleanNoteE,
      fxLock: lock,
      accountId: fromAccE.id,
      swapId: sellPrev.swapId,
      createdAt: sellPrev.createdAt || createdAtE
    };
    var buyNew = {
      id: buyPrev.id,
      type: 'buy',
      symbol: toSymE,
      qty: toQtyE,
      total: totalE,
      currency: swapCcyE,
      date: date,
      fee: 0,
      feeCurrency: swapCcyE,
      note: cleanNoteE,
      fxLock: lock,
      accountId: toAccE.id,
      swapId: buyPrev.swapId,
      createdAt: buyPrev.createdAt || createdAtE
    };
    // Preserve an existing ledger tag on either leg (swaps never create one).
    if (sellPrev.ledger) sellNew.ledger = sellPrev.ledger;
    if (sellPrev.ledgerLabel) sellNew.ledgerLabel = sellPrev.ledgerLabel;
    if (buyPrev.ledger) buyNew.ledger = buyPrev.ledger;
    if (buyPrev.ledgerLabel) buyNew.ledgerLabel = buyPrev.ledgerLabel;
    var needFreezeSellE = false;
    var needFreezeBuyE = false;
    var keptSellExec = keepExec(sellPrev, fromSymE, true);
    if (keptSellExec) sellNew.execLock = keptSellExec;
    else needFreezeSellE = true;
    if (manualPrice !== null) {
      buyNew.execLock = { price: manualPrice, vs: String(swapCcyE).toUpperCase(), source: 'manual' };
    } else {
      var keptBuyExec = keepExec(buyPrev, toSymE, false);
      if (keptBuyExec) buyNew.execLock = keptBuyExec;
      else needFreezeBuyE = true;
    }
    function applyAttachment(dst, prev) {
      if (attMeta && attMeta !== 'keep') { dst.attachment = attMeta; return; }
      if (attMeta === 'keep' && prev.attachment && isValidAttachment(prev.attachment)) dst.attachment = prev.attachment;
    }
    applyAttachment(sellNew, sellPrev);
    applyAttachment(buyNew, buyPrev);
    if (txid !== '') sellNew.txid = txid;
    if (txidTo !== '') buyNew.txid = txidTo;
    var errSellE = validateTrade(sellNew, 1e18);
    if (errSellE) { tradeFormError(errSellE); lockSubmit(false, 'Save changes'); return; }
    var errBuyE = validateTrade(buyNew, 1e18);
    if (errBuyE) { tradeFormError(errBuyE); lockSubmit(false, 'Save changes'); return; }
    try {
      var cSellFresh = heldTimelineConflict(st.trades, sellNew, sellPrev.id);
      if (cSellFresh) { tradeFormError(heldConflictMessage(cSellFresh, [sellNew], st)); lockSubmit(false, 'Save changes'); return; }
      var cBuyFresh = heldTimelineConflict(st.trades, buyNew, buyPrev.id);
      if (cBuyFresh) { tradeFormError(heldConflictMessage(cBuyFresh, [buyNew], st)); lockSubmit(false, 'Save changes'); return; }
    } catch (e) { /* validation continues; engine clamps anyway */ }
    st.trades[sellIdx] = sellNew;
    st.trades[buyIdx] = buyNew;
    if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Save changes'); return; }
    var mainUE = String(main).toUpperCase();
    if (needFreezeSellE) { try { freezeExecLock(sellNew.id, fromSymE, date, mainUE, nowFrom.kind); } catch (e) { /* ignore */ } }
    if (needFreezeBuyE) { try { freezeExecLock(buyNew.id, toSymE, date, mainUE, nowTo.kind); } catch (e) { /* ignore */ } }
    var keptAttE = (attMeta && attMeta !== 'keep') ? attMeta
      : (attMeta === 'keep' ? (sellPrev.attachment || buyPrev.attachment || null) : null);
    attReset(keptAttE);
    editingTradeId = null;
    tradeFormError(null);
    lockSubmit(false, 'Add record');
    var sbE = document.getElementById('t-submit'); if (sbE) sbE.textContent = 'Add record';
    var ttE = document.getElementById('trade-dialog-title'); if (ttE) ttE.textContent = 'Add record';
    refreshPrices();
    render();
    closeDialog('trade-dialog');
  }
  (function resolveSwapEditFx() {
    var mainUE = String(main).toUpperCase();
    var needTotalE = (swapCcyE !== mainUE);
    function lock11E(f) { return { pair: f + '/' + mainUE, rate: 1, source: '1:1', interpolated: false }; }
    if (!needTotalE) {
      proceedSwapEditWithAttachment(lock11E(swapCcyE));
      return;
    }
    if (manualRate !== null) {
      proceedSwapEditWithAttachment({ pair: swapCcyE + '/' + mainUE, rate: manualRate, source: 'manual', interpolated: false });
      return;
    }
    lockSubmit(true, 'Saving…');
    fetchEcbRate(date, swapCcyE, mainUE).then(function (tRes) {
      var tlE = { pair: swapCcyE + '/' + mainUE, rate: tRes.rate, source: tRes.source, interpolated: !!tRes.interpolated };
      try { cacheRate(date, swapCcyE, mainUE, tRes.rate, tRes.source); saveFxCache(); } catch (e) { /* ignore */ }
      proceedSwapEditWithAttachment(tlE);
    }, function () {
      fxError([swapCcyE + ' → ' + mainUE]);
    });
  })();
}
