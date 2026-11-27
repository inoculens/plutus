'use strict';
// Record form submit: validation, saving (buy, sell, transfer, swap, income,
// expense, edits) and error display.

// Add/Edit record validation error: a red panel that rises from behind the
// fixed submit button (same bounce + draining timer bar as the page banner,
// reusing its BANNER_* timings). tradeFormError(null) clears instantly (dialog
// open/reset/success); an on-screen panel updates in place without re-rising.
var tErrTimer = null;      // starts the animated exit when the bar runs out
var tErrOutTimer = null;   // really hides the panel after the exit animation

function tErrCancelTimers() {
  if (tErrTimer) { clearTimeout(tErrTimer); tErrTimer = null; }
  if (tErrOutTimer) { clearTimeout(tErrOutTimer); tErrOutTimer = null; }
}

function tErrClear() {
  tErrCancelTimers();
  var panel = document.getElementById('t-error-panel');
  var p = document.getElementById('t-error');
  if (p) p.textContent = '';
  if (panel) {
    panel.classList.remove('show', 'hide', 'run');
    panel.hidden = true;
  }
}

function tErrDismiss() {
  if (tErrTimer) { clearTimeout(tErrTimer); tErrTimer = null; }
  var panel = document.getElementById('t-error-panel');
  if (!panel || panel.hidden || panel.classList.contains('hide')) return;
  panel.classList.remove('show'); // 'run' stays so the bar does not snap back to full during the exit
  panel.classList.add('hide');
  tErrOutTimer = setTimeout(function () {
    tErrOutTimer = null;
    var pn = document.getElementById('t-error-panel');
    if (pn && pn.classList.contains('hide')) tErrClear();
  }, BANNER_OUT_MS + 50);
}

// Busy state of the record submit button: spinner + "Saving…", disabled, and
// aria-busy so the press is visibly acknowledged and cannot be repeated while
// the save runs (ECB fetch, attachment hashing). Passing a label on unlock
// restores it; without one the pre-busy label comes back.
var tradeSubmitBusy = false;
function setTradeSubmitBusy(btn, busy, label) {
  if (!btn) return;
  if (btn.id === 't-submit') tradeSubmitBusy = !!busy;
  if (busy) {
    if (!btn.classList.contains('is-busy')) btn.setAttribute('data-idle-label', btn.textContent || '');
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    btn.textContent = '';
    var spin = document.createElement('span');
    spin.className = 'btn-spin';
    spin.setAttribute('aria-hidden', 'true');
    var txt = document.createElement('span');
    txt.textContent = label || 'Saving…';
    btn.appendChild(spin);
    btn.appendChild(txt);
    return;
  }
  var idle = btn.getAttribute('data-idle-label');
  btn.classList.remove('is-busy');
  btn.removeAttribute('aria-busy');
  btn.removeAttribute('data-idle-label');
  btn.disabled = false;
  if (label) btn.textContent = label;
  else if (btn.querySelector('.btn-spin')) btn.textContent = idle || (btn.id === 't-submit' ? 'Add record' : 'Save');
}

// Lets the "Saving…" state paint before heavy save work runs. Animation
// frames never fire in hidden or occluded tabs, so a timer fallback guarantees
// the work still runs (exactly once) instead of waiting for the tab to return.
function deferTradeSubmitWork(callback) {
  var started = false;
  function run() {
    if (started) return;
    started = true;
    setTimeout(callback, 0);
  }
  var hasFrames = typeof requestAnimationFrame === 'function';
  if (hasFrames) requestAnimationFrame(run);
  setTimeout(run, hasFrames ? 100 : 0);
}

function tradeFormError(msg) {
  var panel = document.getElementById('t-error-panel');
  var p = document.getElementById('t-error');
  if (!panel || !p) return;
  if (!msg) { tErrClear(); return; }
  var x = document.getElementById('t-error-close');
  if (x && !x.getAttribute('data-wired')) {
    x.setAttribute('data-wired', '1');
    x.addEventListener('click', function () { tErrDismiss(); });
  }
  p.textContent = String(msg);
  var wasShowing = !panel.hidden && panel.classList.contains('show');
  tErrCancelTimers();
  panel.hidden = false;
  panel.classList.remove('hide');
  if (!wasShowing) { panel.classList.remove('show'); void panel.offsetWidth; panel.classList.add('show'); }
  // Timer bar waits for the rise (lead), then drains over BANNER_DWELL_MS;
  // the exit starts exactly when it runs out.
  var lead = wasShowing ? 0 : BANNER_IN_MS;
  try {
    panel.style.setProperty('--banner-in', BANNER_IN_MS + 'ms');
    panel.style.setProperty('--banner-out', BANNER_OUT_MS + 'ms');
    panel.style.setProperty('--banner-dwell', BANNER_DWELL_MS + 'ms');
    panel.style.setProperty('--banner-lead', lead + 'ms');
  } catch (e) { /* ignore */ }
  panel.classList.remove('run');
  void panel.offsetWidth; // restart the bar animation
  panel.classList.add('run');
  tErrTimer = setTimeout(tErrDismiss, lead + BANNER_DWELL_MS);
}

// One calm line for a timeline conflict. A draft that is itself short keeps
// the familiar oversell wording; a record that would no longer be fundable
// names its type/date/account so the cause is obvious without a ticker dump.
function heldConflictMessage(conflict, draftList, state) {
  if (!conflict) return '';
  var drafts = Array.isArray(draftList) ? draftList : [draftList];
  if (drafts.indexOf(conflict.trade) !== -1) {
    // A transfer can spend from several accounts: say which one is short.
    var multi = false;
    try { multi = !!(conflict.trade && conflict.trade.type === 'transfer' && transferSourceIds(conflict.trade).length > 1); } catch (e) { multi = false; }
    if (multi) {
      var shortName = '';
      try {
        var sa = accountById(state || loadState(), conflict.accountId);
        if (sa && sa.name) shortName = String(sa.name);
      } catch (e) { shortName = ''; }
      if (shortName) return 'oversell: ' + shortName + ' can spend at most ' + conflict.available;
    }
    return 'oversell: max sellable is ' + conflict.available;
  }
  var label = tradeTypeLabel(conflict.trade && conflict.trade.type);
  var when = (conflict.trade && conflict.trade.date) ? fmtDateDmy(conflict.trade.date) : '';
  var accName = '';
  try {
    var acc = accountById(state || loadState(), conflict.accountId);
    if (acc && acc.name) accName = String(acc.name);
  } catch (e) { accName = ''; }
  var sym = conflict.symbol || '';
  return 'Cannot save: the ' + label + ' on ' + when +
    (accName ? ' in ' + accName : '') +
    ' needs ' + fmtQty(conflict.needed, sym) + ' ' + sym +
    ', but only ' + fmtQty(conflict.available, sym) + ' would be available.';
}

// Implicit chart of accounts: remember a ledger label the user typed so
// the datalist and reports can reuse it. Learned into the record's own
// account (snapshotting the default on first edit); historic trades keep
// their own stored labels; this only updates the chart map.
// One name per code: chart first, then the first posted label in scope.
// Pure (no DOM, no save). scopeIds widens the search to the whole group
// (main first); omitted means the single account.
function findLedgerLabel(st, accountId, code, scopeIds) {
  code = (code === undefined || code === null) ? '' : String(code).trim();
  if (!code) return '';
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [accountId];
  var chartAcc = scope[0];
  try {
    var eff = ledgerChartFor(st, chartAcc);
    if (eff && eff[code]) return String(eff[code]);
  } catch (e) { /* ignore */ }
  var found = '';
  try {
    var inScope = dict();
    scope.forEach(function (sid) { if (typeof sid === 'string' && sid !== '') inScope[sid] = true; });
    (st.trades || []).forEach(function (t) {
      if (found || !t) return;
      var inT = !!inScope[t.accountId];
      if (!inT) {
        var srcsL = transferSourceIds(t);
        for (var siL = 0; siL < srcsL.length; siL++) if (inScope[srcsL[siL]]) { inT = true; break; }
      }
      if (!inT) return;
      if (String(t.ledger || '').trim() === code && t.ledgerLabel && String(t.ledgerLabel).trim() !== '') {
        found = String(t.ledgerLabel).trim();
      }
    });
  } catch (e) { /* ignore */ }
  return found;
}

function learnLedgerLabel(st, trade) {
  try {
    if (!st || !trade) return;
    var code = (trade.ledger === undefined || trade.ledger === null) ? '' : String(trade.ledger).trim();
    var label = (trade.ledgerLabel === undefined || trade.ledgerLabel === null) ? '' : String(trade.ledgerLabel).trim();
    if (code === '' || label === '') return;
    var map = null;
    if (trade.accountId) {
      if (!accountById(st, trade.accountId)) return;
      map = ensureAccountChart(st, trade.accountId);
    } else {
      if (!st.settings || typeof st.settings !== 'object') return;
      map = st.settings.ledgerLabels;
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        map = {};
        st.settings.ledgerLabels = map;
      }
    }
    // Capped like the validator: beyond 500 codes nothing is learned, so a
    // large chart can never be wiped by normalization on reload. No
    // early-out on match: propagation below must still run for the records.
    if (!Object.prototype.hasOwnProperty.call(map, code) && Object.keys(map).length >= 500) return;
    map[code] = label;
    // One name per code: a (re)typed label propagates to the group chart
    // and every record carrying the code in scope, so the tree, the cards
    // and the records never disagree afterwards.
    try {
      var scope = null;
      try { scope = trade.accountId ? ledgerScopeOf(st, trade.accountId) : null; } catch (e) { scope = null; }
      if (scope && scope.length > 1) {
        var mainMap = ensureAccountChart(st, scope[0]);
        if (mainMap[code] !== label) {
          if (!Object.prototype.hasOwnProperty.call(mainMap, code) && Object.keys(mainMap).length >= 500) return;
          mainMap[code] = label;
        }
        (st.trades || []).forEach(function (t) {
          if (!t || !tradeTouchesAccounts(t, scope)) return;
          if (String(t.ledger || '').trim() === code && String(t.ledgerLabel || '').trim() !== label) {
            t.ledgerLabel = label;
          }
        });
      } else if (trade.accountId) {
        (st.trades || []).forEach(function (t) {
          if (!t || !tradeTouchesAccounts(t, [trade.accountId])) return;
          if (String(t.ledger || '').trim() === code && String(t.ledgerLabel || '').trim() !== label) {
            t.ledgerLabel = label;
          }
        });
      }
    } catch (e) { /* propagation never breaks saving */ }
  } catch (e) { /* ignore */ }
}

function onTradeSubmit(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  if (tradeSubmitBusy) return; // a save is already running: ignore repeat presses / Enter
  tradeFormError(null);
  var st0 = loadState();
  var main = st0.settings.mainCurrency;
  var rawSide = uiVal('t-side', 'buy');
  var side = (rawSide === 'sell' || rawSide === 'transfer' || rawSide === 'income' || rawSide === 'expense' || rawSide === 'swap') ? rawSide : 'buy';
  var list = Array.isArray(st0.accounts) ? st0.accounts : [];
  var acc = accountById(st0, uiVal('t-account', '')) || list[0];
  if (!acc) { tradeFormError('Create your first account to enable Add record.'); return; }
  var symbol = String(acc.ticker).toUpperCase();
  var accountId = acc.id;
  var isCashAcc = isCashKind(acc.kind);
  var isEditing = !!(editingTradeId);
  // Cash accounts are bookkeeping ledgers: only money-movement types.
  if (isCashAcc && !isEditing && (side === 'buy' || side === 'sell' || side === 'swap')) {
    tradeFormError('Cash accounts use income, expense and transfer — buy/sell/swap are for assets.');
    return;
  }
  var submitBtn = document.getElementById('t-submit');
  function lockSubmit(locked, label) {
    setTradeSubmitBusy(submitBtn, !!locked, label);
  }
  var dateRaw = uiVal('t-date', '').trim();
  var date = dateRaw ? parseDateInput(dateRaw) : todayStr();
  if (!date) { tradeFormError('Date must be a valid date in ' + normalizeDateFormat(activeDateFormat) + ' format.'); return; }
  if (!isValidDateStr(date)) { tradeFormError('Date must be a valid date in ' + normalizeDateFormat(activeDateFormat) + ' format.'); return; }
  if (isFutureDateStr(date)) { tradeFormError('date cannot be in the future'); return; }
  var note = uiVal('t-note', '').trim();
  var txid = uiVal('t-txid', '').trim();
  // Transaction IDs are free-form optional metadata; do not block saving based on their format.
  // Swaps hold a second hash: the received side's transaction.
  var txidTo = (side === 'swap') ? uiVal('t-txid-to', '').trim() : '';

  var manualRateRaw = uiVal('t-manual-rate', '').trim();
  var manualPriceRaw = uiVal('t-manual-price', '').trim();
  var manualRate = (manualRateRaw === '') ? null : Number(manualRateRaw);
  if (manualRate !== null && (!isFinite(manualRate) || manualRate <= 0)) { tradeFormError('Manual rate must be > 0.'); return; }
  var manualPrice = (manualPriceRaw === '') ? null : Number(manualPriceRaw);
  if (manualPrice !== null && (!isFinite(manualPrice) || manualPrice <= 0)) { tradeFormError('Manual price must be > 0.'); return; }
  // Ledger inputs (cash income/expense). Length-checked here; attached below.
  // A blank code is allowed everywhere: cleared records pool into the
  // Unlabeled buckets instead of being forced into a ledger.
  var ledgerCode = uiVal('t-ledger', '').trim();
  var ledgerLabel = uiVal('t-ledger-label', '').trim();
  if (ledgerCode !== '' && !isValidLedgerCode(ledgerCode)) { tradeFormError('Ledger code is too long — up to 24 characters.'); return; }
  if (ledgerLabel !== '' && !isValidLedgerLabel(ledgerLabel)) { tradeFormError('Ledger label is too long — up to 80 characters.'); return; }
  // Parent-overview rule: ledgers with sub-ledgers are pure totals and take
  // no records; posting under a record-holding ledger is blocked with the
  // fix (move those records to a child, keep the parent record-free).
  // Grouped accounts judge against the whole group (main chart + members).
  // Any side that can carry a ledger is checked.
  if (ledgerCode !== '' && tradeLedgerAllowed(isCashAcc, side)) {
    var lscope = null;
    try { lscope = ledgerScopeOf(st0, accountId); } catch (e) { lscope = null; }
    var lconf = ledgerRecordConflict(st0, accountId, ledgerCode, isEditing ? editingTradeId : null, null, lscope);
    if (lconf) { tradeFormError(ledgerConflictMessage(lconf)); return; }
  }
  // Duplicate tx IDs (js/data/tx-duplicates.js): the same asset + hash on
  // another record asks before saving; Save anyway resubmits the form.
  var dupDrafts = [];
  var dupExclude = [];
  if (side === 'swap') {
    var dupPair = null;
    if (isEditing) {
      try {
        var dupClicked = (st0.trades || []).filter(function (x) { return x && x.id === editingTradeId; })[0];
        dupPair = dupClicked ? swapPairForTrade(st0, dupClicked) : null;
      } catch (e) { dupPair = null; }
    }
    if (dupPair) dupExclude = [dupPair.sell.id, dupPair.buy.id];
    var dupFrom = accountById(st0, uiVal('t-account', '')) || (dupPair ? accountById(st0, dupPair.sell.accountId) : null) || acc;
    var dupTo = accountById(st0, uiVal('t-toaccount', ''));
    dupDrafts.push({ symbol: dupFrom.ticker, txid: txid, accountId: dupFrom.id, prevId: dupPair ? dupPair.sell.id : null });
    if (dupTo) dupDrafts.push({ symbol: dupTo.ticker, txid: txidTo, accountId: dupTo.id, prevId: dupPair ? dupPair.buy.id : null });
  } else {
    if (isEditing) dupExclude = [editingTradeId];
    dupDrafts.push({ symbol: symbol, txid: txid, accountId: accountId, prevId: isEditing ? editingTradeId : null });
  }
  var txDup = txidDupGate(st0, dupDrafts, dupExclude, function () { onTradeSubmit(null); });
  if (txDup.prompt) return;
  // Swaps are saved by js/ui/record-submit-swap.js with these form values.
  function swapContext() {
    return {
      st0: st0,
      main: main,
      acc: acc,
      accountId: accountId,
      symbol: symbol,
      isCashAcc: isCashAcc,
      date: date,
      note: note,
      txid: txid,
      txidTo: txidTo,
      manualRate: manualRate,
      manualPrice: manualPrice,
      lockSubmit: lockSubmit,
      fxError: fxError,
      txDup: txDup
    };
  }
  // --- Swap: creates a linked sell+buy pair ---
  if (side === 'swap' && !isEditing) {
    submitNewSwap(swapContext());
    return;
  }
  // --- Swap edit: update the linked sell+buy pair as one record ---
  if (side === 'swap' && isEditing) {
    submitSwapEdit(swapContext());
    return;
  }
  // --- Single-leg types (buy/sell/transfer/income/expense), new or edit ---
  var qtyRaw = uiVal('t-qty', '');
  var totalRaw = uiVal('t-total', '');
  var ccySel = uiVal('t-currency', 'EUR');
  var currency = (ccySel === 'CUSTOM' ? uiVal('t-custom-ccy', '').trim().toUpperCase() : String(ccySel).toUpperCase());
  var feeRaw = uiVal('t-fee', '').trim();
  var fee = (feeRaw === '') ? 0 : Number(feeRaw);
  var feeCurrency = currency; // one fiat per trade: fee follows Currency
  var netRaw = uiVal('t-networkfee', '');
  var networkFee = (netRaw === undefined || netRaw === null || String(netRaw).trim() === '') ? 0 : Number(netRaw);
  // Recipients: one transaction, N outputs. The tx fee is sent − received
  // (computed); optional per-row fees attribute part of it. A lone
  // cross-fiat cash row carries the converted arrival instead of a fee.
  // transferRowsBuilt feeds the save paths below so both agree exactly.
  var transferRowsBuilt = null;
  var transferSourcesBuilt = null;
  var transferSourceAutoBuilt = null;
  var transferSelfBuilt = 0;
  var toAccCash = null;
  var isCrossFiat = false;
  if (side === 'transfer') {
    var srcRows = readSourceRows();
    var recRows = readRecipientRows();
    var multiSource = transferHasAdditionalSources(srcRows);
    var srcBuilt = null;
    if (multiSource) {
      var sb = buildTransferSources(srcRows, symbol);
      if (sb.error) { tradeFormError(sb.error); return; }
      srcBuilt = sb.sources;
    }
    var symDecSave = qtyDecimals(symbol);
    var sentScSave = exactScaledOf(qtyRaw, symDecSave);
    var sentOkSave = sentScSave !== null && sentScSave > 0n;
    if (!sentOkSave) { tradeFormError('Enter how much you sent (> 0).'); return; }
    var precBad = qtyOverPrecise(qtyRaw, symbol) || qtyOverPrecise(uiVal('t-selfrecv', ''), symbol);
    srcRows.forEach(function (sr) { if (qtyOverPrecise(sr.qty, symbol) || qtyOverPrecise(sr.fee, symbol)) precBad = true; });
    recRows.forEach(function (rr) { if (qtyOverPrecise(rr.qty, symbol) || qtyOverPrecise(rr.fee, symbol)) precBad = true; });
    if (precBad) { tradeFormError(qtyPrecisionError(symbol)); return; }
    if (recRows.length > TRANSFER_MAX_OUTPUTS) { tradeFormError('Too many recipients (max 20).'); return; }
    var seenAcc = {};
    var sumQSc = 0n, sumFSc = 0n, crossN = 0, crossOne = null;
    var rowErr = null;
    for (var ri = 0; ri < recRows.length && !rowErr; ri++) {
      (function (rr, idx) {
        var label = 'Recipient ' + (idx + 1);
        function fail(m) { rowErr = m; }
        if (rr.kind === 'internal') {
          var accPick = accountById(st0, rr.accountId);
          if (!accPick) return fail(label + ' account not found.');
          if (accPick.id === accountId && !multiSource) return fail(label + ' must differ from the source.');
          if (seenAcc[accPick.id]) return fail('Pick each account once — merge the amounts instead.');
          seenAcc[accPick.id] = true;
          var pickTick = String(accPick.ticker).toUpperCase();
          if (!isCashAcc && (isCashKind(accPick.kind) || pickTick !== symbol)) return fail(label + ' needs the same asset in both accounts — use Swap for different assets.');
          if (isCashAcc && !isCashKind(accPick.kind)) return fail('Cash moves only between cash accounts.');
          var rf0 = (String(rr.fee || '').trim() === '') ? 0n : exactScaledOf(rr.fee, symDecSave);
          if (rf0 === null || rf0 < 0n) return fail(label + ' fee must be >= 0.');
          sumFSc += rf0;
          if (isCashAcc && isCashKind(accPick.kind) && pickTick !== symbol) {
            crossN++;
            crossOne = { row: rr, acc: accPick };
          } else {
            var rq0 = exactScaledOf(rr.qty, symDecSave);
            if (rq0 === null || rq0 <= 0n) return fail(label + ' needs an amount > 0.');
            sumQSc += rq0;
          }
        } else {
          var rq = exactScaledOf(rr.qty, symDecSave);
          if (rq === null || rq <= 0n) return fail(label + ' needs an amount > 0.');
          var rf = (String(rr.fee || '').trim() === '') ? 0n : exactScaledOf(rr.fee, symDecSave);
          if (rf === null || rf < 0n) return fail(label + ' fee must be >= 0.');
          if (String(rr.label || '').trim() === '') return fail(label + ' needs a label.');
          if (String(rr.label).trim().length > TRANSFER_LABEL_MAX) return fail(label + ' label is too long.');
          sumQSc += rq;
          sumFSc += rf;
        }
      })(recRows[ri], ri);
    }
    if (rowErr) { tradeFormError(rowErr); return; }
    if (crossN > 0 && recRows.length > 1) { tradeFormError('Cross-fiat moves stay single-recipient — split the same-fiat rows into their own record.'); return; }
    var selfRawSub = String(uiVal('t-selfrecv', '')).trim();
    var selfScSub = 0n;
    if (selfRawSub !== '') {
      var selfScRaw = exactScaledOf(selfRawSub, symDecSave);
      if (selfScRaw === null || selfScRaw < 0n) { tradeFormError('Received back must be a number >= 0.'); return; }
      selfScSub = selfScRaw;
    }
    if (multiSource) {
      // Fee = source quantity minus recipient quantities and self-return.
      // Manual source fees are fixed; auto rows split the remainder.
      var totalQSc=0n,manualFeeSc=0n,autoSourceIndexes=[],autoSourceCaps=[];
      for(var si=0;si<srcBuilt.length;si++){
        var sq=exactScaledOf(srcBuilt[si].qty,symDecSave),sf=exactScaledOf(srcBuilt[si].fee||'0',symDecSave);
        if(sq===null||sq<=0n||sf===null||sf<0n||sf>=sq){tradeFormError('Each source needs a valid quantity and fee.');return;}
        totalQSc+=sq;
        if(srcRows[si]&&srcRows[si].auto){autoSourceIndexes.push(si);autoSourceCaps.push(sq-1n);}
        else manualFeeSc+=sf;
      }
      if(totalQSc<=0n){tradeFormError('Total sent must be > 0.');return;}
      if(crossN>0){tradeFormError('Cross-fiat moves are not supported with multiple sources.');return;}
      var requiredFeeSc=totalQSc-sumQSc-selfScSub;
      if(requiredFeeSc<0n){tradeFormError('Recipients + received back exceed the source amounts.');return;}
      if(sumFSc>requiredFeeSc){tradeFormError('Recipient fee attribution exceeds the transfer fee.');return;}
      if(manualFeeSc>requiredFeeSc){tradeFormError('Manual source fees exceed the transfer fee implied by recipients.');return;}
      var autoFeeSc=requiredFeeSc-manualFeeSc;
      if(autoSourceIndexes.length){
        var autoShares=splitTransferFeeEven(autoFeeSc,autoSourceCaps);
        if(!autoShares){tradeFormError('The fee cannot be split across these sources without exceeding a source amount.');return;}
        autoSourceIndexes.forEach(function(sourceIndex,ai){srcBuilt[sourceIndex].fee=autoShares[ai]>0n?exactNumOrStr(autoShares[ai],symDecSave):0;});
      } else if(autoFeeSc!==0n){tradeFormError('Source fees must equal the transfer fee. Adjust a fee or choose Split evenly.');return;}
      if(requiredFeeSc>=totalQSc){tradeFormError('Total fee must be less than total sent.');return;}
      qtyRaw=exactNumOrStr(totalQSc,symDecSave);
      networkFee=exactNumOrStr(requiredFeeSc,symDecSave);
      sentScSave=totalQSc;
      transferSelfBuilt=selfScSub>0n?exactNumOrStr(selfScSub,symDecSave):0;
      transferRowsBuilt=recRows;
    } else if (crossN === 1 && recRows.length === 1) {
      var rx = Number(crossOne.row.toQty);
      if (!isFinite(rx) || rx <= 0) { tradeFormError('Enter what arrives in ' + String(crossOne.acc.ticker).toUpperCase() + ' (> 0).'); return; }
      if (selfScSub >= sentScSave) { tradeFormError('Received back must be less than sent when another account receives funds.'); return; }
      crossOne.row.qty = String(exactNumOrStr(sentScSave - selfScSub, symDecSave));
      crossOne.row.toSymbol = String(crossOne.acc.ticker).toUpperCase();
      crossOne.row.fee = '';
      sumQSc = sentScSave - selfScSub;
      sumFSc = 0n;
      networkFee = 0;
      transferSelfBuilt = (selfScSub > 0n) ? exactNumOrStr(selfScSub, symDecSave) : selfRawSub;
      toAccCash = crossOne.acc;
      isCrossFiat = true;
    } else {
      var feeScSave = sentScSave - sumQSc - selfScSub;
      if (feeScSave < 0n) { tradeFormError('Recipients + received back exceed sent — lower an amount.'); return; }
      networkFee = exactNumOrStr(feeScSave, symDecSave);
      if (sumFSc > feeScSave) { tradeFormError('Recipient fees exceed the transfer fee (' + String(networkFee) + ').'); return; }
      transferSelfBuilt = (selfScSub > 0n) ? exactNumOrStr(selfScSub, symDecSave) : selfRawSub;
    }
    if (!recRows.length && !multiSource) {
      // No recipients: same-account move — the fee derives from what
      // arrived back (the fee field is computed-only, as ever).
      var backRaw = uiVal('t-selfrecv', '');
      var backChk = transferFeeFrom(String(qtyRaw), backRaw, symbol);
      if (!backChk) {
        if (String(backRaw).trim() === '') tradeFormError('Enter what arrived back (> 0).');
        else tradeFormError('Received back must be > 0 and at most what you sent.');
        return;
      }
      networkFee = backChk.fee;
    }
    var nfScChk = exactScaledOf(networkFee, symDecSave);
    if (nfScChk === null || nfScChk < 0n || nfScChk >= sentScSave) { tradeFormError('Transfer fees must be >= 0 and < qty.'); return; }
    uiSetVal('t-networkfee', exactToStringTrim(exactScaledOf(networkFee, symDecSave), symDecSave));
    transferRowsBuilt = recRows;
    if (multiSource) {
      transferSourcesBuilt = srcBuilt;
      transferSourceAutoBuilt = srcRows.map(function (r) { return !!r.auto; });
    }
  }
  if (!symbol || !/^[A-Z0-9._-]{1,12}$/.test(symbol)) { tradeFormError('Account ticker looks invalid.'); return; }
  if (!isFinite(fee) || fee < 0) { tradeFormError('Fee must be >= 0.'); return; }
  if (!isFinite(networkFee) || networkFee < 0) { tradeFormError('Transfer fees must be >= 0.'); return; }
  if (qtyOverPrecise(qtyRaw, symbol)) { tradeFormError(qtyPrecisionError(symbol)); return; }
  var qty = (side === 'expense' && String(qtyRaw).trim() === '') ? null : exactQtyValue(qtyRaw, symbol);
  var qtyChk = Number(qty);
  var total = (String(totalRaw).trim() === '') ? (side === 'buy' || side === 'sell' ? NaN : 0) : Number(totalRaw);
  // Cash income/expense amounts live in the account fiat alone: the amount
  // is the quantity, and total/currency derive from it (the rows hide).
  if (isCashAcc && (side === 'income' || side === 'expense')) {
    if (!isFinite(qtyChk) || qtyChk <= 0) { tradeFormError('Amount must be > 0.'); return; }
    total = exactNumOrStr(exactScaledOf(qtyRaw, qtyDecimals(symbol)), qtyDecimals(symbol));
    currency = symbol;
    feeCurrency = symbol;
  }
  if (side === 'transfer') {
    // Transfers carry no fiat of their own: the network fee IS the fee,
    // valued in fiat at the frozen historical rate. Ignore any stale fiat
    // inputs (the rows are hidden for transfers).
    fee = 0; total = 0; currency = String(main).toUpperCase(); feeCurrency = currency;
  }
  // Per-type validation (messages match legacy for buy/sell so tests keep passing).
  if (side === 'buy' || side === 'sell') {
    if (!isFinite(qtyChk) || qtyChk <= 0) { tradeFormError('Quantity must be > 0.'); return; }
    if (!isFinite(total) || total < 0) { tradeFormError('Total must be >= 0.'); return; }
    if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid — pick one or enter a 2–10 letter code.'); return; }
  } else if (side === 'transfer') {
    if (!isFinite(qtyChk) || qtyChk <= 0) { tradeFormError('Enter how much you sent (> 0).'); return; }
    if (nfScChk === null || nfScChk < 0n || nfScChk >= sentScSave) { tradeFormError('Transfer fees must be >= 0 and < qty.'); return; }
    // Recipients were validated row-by-row above (accounts exist, tickers
    // eligible, label present, sums balance); nothing left to check here.
  } else if (side === 'income') {
    if (!isFinite(qtyChk) || qtyChk <= 0) { tradeFormError('Quantity must be > 0.'); return; }
    // Cash derives from the account fiat alone (total/currency rows hide):
    // hidden-field leftovers must never override the derivation below.
    if (isCashAcc) { total = exactNumOrStr(exactScaledOf(qtyRaw, qtyDecimals(symbol)), qtyDecimals(symbol)); currency = symbol; }
    else if (String(totalRaw).trim() !== '' && (!isFinite(total) || total < 0)) { tradeFormError('Total must be >= 0.'); return; }
    else if (String(totalRaw).trim() !== '') {
      if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid.'); return; }
    } else { total = 0; currency = String(main).toUpperCase(); }
  } else if (side === 'expense') {
    var hasQ = !(String(qtyRaw).trim() === '');
    // Asset expenses carry no typed fiat: the quantity is the truth and the
    // fiat value derives from the spend-date rate. Only an older fiat-only
    // record being edited may keep its fiat amount (and only without a qty).
    var legacyFiatSave = false;
    try {
      var exSaved = editingTradeId ? (st0.trades || []).filter(function (x) { return x && x.id === editingTradeId; })[0] : null;
      legacyFiatSave = !!(exSaved && exSaved.type === 'expense' && !isCryptoQtyExpense(exSaved) && Number(exSaved.total) > 0);
    } catch (e) { legacyFiatSave = false; }
    var hasT = !isCashAcc && legacyFiatSave && !hasQ && !(String(totalRaw).trim() === '');
    if (!hasQ && !hasT) { tradeFormError(isCashAcc ? 'Expense needs a quantity or a cash amount.' : 'Enter how much you spent (quantity > 0).'); return; }
    if (hasQ && (!isFinite(qtyChk) || qtyChk <= 0)) { tradeFormError('Quantity must be > 0.'); return; }
    if (hasT && (!isFinite(total) || total <= 0)) { tradeFormError('Fiat amount must be > 0.'); return; }
    if (!hasQ) qty = null;
    if (isCashAcc) { total = exactNumOrStr(exactScaledOf(qtyRaw, qtyDecimals(symbol)), qtyDecimals(symbol)); currency = symbol; }
    else if (!hasT) { total = 0; currency = String(main).toUpperCase(); }
    else if (!isValidCurrencyCode(currency)) { tradeFormError('Currency code invalid.'); return; }
  }
  var from = currency;
  // Time-ordered held check: a record may spend what was available at its
  // date, and the replay also proves later records stay fundable. This is
  // deliberately not "today's balance", which made retro edits impossible.
  var heldDraft = {
    id: editingTradeId || null,
    type: side,
    symbol: symbol,
    qty: qty,
    accountId: accountId,
    date: date
  };
  if (side === 'transfer') {
    heldDraft.networkFee = networkFee;
    if (transferSourcesBuilt) heldDraft.sources = transferSourcesBuilt;
    var heldOuts = buildTransferOutputs(transferRowsBuilt, symbol);
    if (heldOuts.length) {
      heldDraft.outputs = heldOuts;
      if (transferSelfBuilt > 0) heldDraft.selfQty = transferSelfBuilt;
    }
  }
  try {
    var heldConflict = heldTimelineConflict(st0.trades, heldDraft, editingTradeId);
    if (heldConflict) {
      tradeFormError(heldConflictMessage(heldConflict, [heldDraft], st0));
      return;
    }
  } catch (e) { /* validation continues; engine clamps anyway */ }
  // proceed() re-reads state so a slow ECB fetch cannot clobber newer writes.
  // The attachment (if any) resolves first: the trade is only built after
  // its file is hashed + stored, so a record never points at a missing blob.
    function proceed(lock) {
      var __lock = lock;
      lockSubmit(true, 'Saving…');
      deferTradeSubmitWork(function () {
        try {
          attResolveForSave(function (err, meta) {
            if (err) { tradeFormError(err); lockSubmit(false, isEditing ? 'Save changes' : 'Add record'); return; }
            pendingAttachResolved = meta;
            try { proceedSave(__lock); } catch (e) { lockSubmit(false, 'Add record'); throw e; }
          });
        } catch (e) { tradeFormError('Could not save the attachment — record was not saved.'); lockSubmit(false, 'Add record'); }
      });
    }
    function proceedSave(lock) {
    var st = loadState();
    // NOTE: a trade-dialog manual price stays per-trade (trade.execLock,
    // attached below) and never touches the global live-price overrides —
    // those belong to Settings only.
    function withFeeLock(trade) {
      // One fiat per trade: no separate fee lock is ever written; a stale one
      // from older data is dropped so the fee always rides the trade lock.
      try { delete trade.feeFxLock; } catch (e) { /* ignore */ }
      return trade;
    }
    var trade;
    if (isEditing) {
      var idx = -1;
      for (var ii = 0; ii < (st.trades || []).length; ii++) if (st.trades[ii] && st.trades[ii].id === editingTradeId) { idx = ii; break; }
      if (idx === -1) { tradeFormError('Trade not found — it may have been deleted.'); lockSubmit(false, 'Save changes'); return; }
      var prev = st.trades[idx];
      trade = {
        id: prev.id,
        type: side,
        symbol: symbol,
        qty: qty,
        total: total,
        currency: from,
        date: date,
        fee: fee,
        feeCurrency: feeCurrency,
        note: note,
        fxLock: lock,
        accountId: accountId,
        createdAt: prev.createdAt || new Date().toISOString()
      };
      if (txid !== '') trade.txid = txid;
      withFeeLock(trade);
      if (pendingAttachResolved !== 'keep') {
        if (pendingAttachResolved) trade.attachment = pendingAttachResolved;
        else { try { delete trade.attachment; } catch (e) { trade.attachment = undefined; } }
      } else if (prev.attachment && isValidAttachment(prev.attachment)) {
        trade.attachment = prev.attachment;
      }
      // Reference exec quote: manual wins; else keep the frozen quote when the
      // identifying fields are untouched; otherwise refreeze after save.
      // Transfers freeze it too: it values the network fee in fiat at the
      // tx-date rate (Fee in fiat rate). Other rows carry no execLock.
      var needRefreeze = false;
      if (side === 'buy' || side === 'sell' || side === 'transfer' || isCryptoQtyExpense(trade)) {
        if (manualPrice !== null) {
          // Manual quote follows the trade's Currency field (like total and
          // fee), never the header display fiat — display converts it.
          trade.execLock = { price: manualPrice, vs: String(from).toUpperCase(), source: 'manual' };
        } else {
          var prevFrozen = null;
          try { prevFrozen = frozenExecOf(prev); } catch (e) { prevFrozen = null; }
          // A cleared manual field drops the manual quote (history refreezes);
          // an untouched history quote is kept as-is, no refetch.
          var keepIt = prevFrozen && String(prevFrozen.source).toLowerCase() !== 'manual' &&
            prev.date === date && String(prev.symbol).toUpperCase() === symbol;
          if (keepIt) {
            trade.execLock = { price: prevFrozen.price, vs: prevFrozen.vs, source: prevFrozen.source };
          } else {
            try { delete trade.execLock; } catch (e) { /* ignore */ }
            needRefreeze = true;
          }
        }
      } else {
        try { delete trade.execLock; } catch (e) { /* ignore */ }
      }
      if (side === 'transfer') {
        trade.networkFee = networkFee;
        if (transferSourcesBuilt) trade.sources = transferSourcesBuilt;
        if (transferSourceAutoBuilt) trade.sourceFeeAuto = transferSourceAutoBuilt.slice();
        var outsEdit = buildTransferOutputs(transferRowsBuilt, symbol);
        if (outsEdit.length) {
          trade.outputs = outsEdit;
          if (transferSelfBuilt > 0) trade.selfQty = transferSelfBuilt;
        }
        try { delete trade.toAccountId; } catch (e) { trade.toAccountId = undefined; }
        try { delete trade.toQty; } catch (e) { trade.toQty = undefined; }
        try { delete trade.toSymbol; } catch (e) { trade.toSymbol = undefined; }
      }
      else if (side === 'expense' && qty === null) { delete trade.qty; }
      // Bookkeeping: ledger rides income/expense records — required on cash,
      // optional on asset accounts while the global switch is on.
      if (tradeLedgerAllowed(isCashAcc, side)) {
        if (ledgerCode !== '') trade.ledger = ledgerCode;
        if (ledgerLabel !== '') trade.ledgerLabel = ledgerLabel;
        if (ledgerCode === '') {
          try { delete trade.ledger; } catch (e) { trade.ledger = undefined; }
          try { delete trade.ledgerLabel; } catch (e) { trade.ledgerLabel = undefined; }
        }
      }
      // Cross-fiat cash move: the converted arrival rides the single row
      // (the trade-level lock below still converts the arrival leg).
      if (isCrossFiat) {
        if (destLockForTrade) trade.toFxLock = destLockForTrade;
      }
      // Cash transfers freeze both fiat legs (source + arrival); the
      // trade's own lock stays 1:1 main (total is 0, engine-neutral).
      if (isCashAcc && side === 'transfer' && srcFiatLockForTrade) {
        trade.fromFxLock = srcFiatLockForTrade;
        if (!isCrossFiat) trade.toFxLock = srcFiatLockForTrade;
      }
      if (prev.swapId) trade.swapId = prev.swapId;
      var errE = validateTrade(trade, 1e18); // structural; holdings are checked on the timeline
      if (errE) { tradeFormError(errE); lockSubmit(false, 'Save changes'); return; }
      // Fresh-state timeline replay: the edit may not create a new shortfall,
      // now or in any later record it feeds.
      try {
        var conflictE = heldTimelineConflict(st.trades, trade, editingTradeId);
        if (conflictE) {
          tradeFormError(heldConflictMessage(conflictE, [trade], st));
          lockSubmit(false, 'Save changes');
          return;
        }
      } catch (e2) { /* ignore */ }
      st.trades[idx] = trade;
      learnLedgerLabel(st, trade);
      txidDupApply(st, [trade], txDup);
      if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Save changes'); return; }
      attReset(trade.attachment);
      if (needRefreeze) {
        try { freezeExecLock(trade.id, symbol, date, mainU, (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
      }
      editingTradeId = null;
      tradeFormError(null);
      lockSubmit(false, 'Add record');
      var sb2 = document.getElementById('t-submit'); if (sb2) sb2.textContent = 'Add record';
      var tt2 = document.getElementById('trade-dialog-title'); if (tt2) tt2.textContent = 'Add record';
      refreshPrices();
      render();
      closeDialog('trade-dialog');
      return;
    }
    trade = {
      id: uid(),
      type: side,
      symbol: symbol,
      qty: qty,
      total: total,
      currency: from,
      date: date,
      fee: fee,
      feeCurrency: feeCurrency,
      note: note,
      fxLock: lock,
      accountId: accountId,
      createdAt: new Date().toISOString()
    };
    if (txid !== '') trade.txid = txid;
    withFeeLock(trade);
    if (pendingAttachResolved !== 'keep') {
      if (pendingAttachResolved) trade.attachment = pendingAttachResolved;
      else { try { delete trade.attachment; } catch (e) { trade.attachment = undefined; } }
    }
    if (side === 'transfer') {
      trade.networkFee = networkFee;
      if (transferSourcesBuilt) trade.sources = transferSourcesBuilt;
      if (transferSourceAutoBuilt) trade.sourceFeeAuto = transferSourceAutoBuilt.slice();
      var outsNew = buildTransferOutputs(transferRowsBuilt, symbol);
      if (outsNew.length) {
        trade.outputs = outsNew;
        if (transferSelfBuilt > 0) trade.selfQty = transferSelfBuilt;
      }
    }
    if (side === 'expense' && qty === null) { delete trade.qty; }
    // Bookkeeping: ledger rides income/expense records — required on cash,
    // optional on asset accounts while the global switch is on.
    if (tradeLedgerAllowed(isCashAcc, side)) {
      if (ledgerCode !== '') trade.ledger = ledgerCode;
      if (ledgerLabel !== '') trade.ledgerLabel = ledgerLabel;
      if (ledgerCode === '') {
        try { delete trade.ledger; } catch (e) { trade.ledger = undefined; }
        try { delete trade.ledgerLabel; } catch (e) { trade.ledgerLabel = undefined; }
      }
    }
    // Cross-fiat cash move: the converted arrival rides the single row
    // (the trade-level lock below still converts the arrival leg).
    if (isCrossFiat) {
      if (destLockForTrade) trade.toFxLock = destLockForTrade;
    }
    // Cash transfers freeze both fiat legs (source + arrival); the
    // trade's own lock stays 1:1 main (total is 0, engine-neutral).
    if (isCashAcc && side === 'transfer' && srcFiatLockForTrade) {
      trade.fromFxLock = srcFiatLockForTrade;
      if (!isCrossFiat) trade.toFxLock = srcFiatLockForTrade;
    }
    if (side === 'buy' || side === 'sell' || side === 'transfer' || isCryptoQtyExpense(trade)) {
      if (manualPrice !== null) {
        // Same rule as the edit path: the manual quote follows the trade's
        // Currency field, never the header display fiat.
        trade.execLock = { price: manualPrice, vs: String(from).toUpperCase(), source: 'manual' };
      }
    } else {
      try { delete trade.execLock; } catch (e) { /* ignore */ }
    }
    var err = validateTrade(trade, 1e18); // structural; holdings are checked on the timeline
    if (err) { tradeFormError(err); lockSubmit(false, 'Add record'); return; }
    // New (including backdated) records run the same replay, so they cannot
    // spend funds that were not there yet or break a later record.
    try {
      var conflictN = heldTimelineConflict(st.trades, trade, null);
      if (conflictN) {
        tradeFormError(heldConflictMessage(conflictN, [trade], st));
        lockSubmit(false, 'Add record');
        return;
      }
    } catch (e3) { /* validation continues; engine clamps anyway */ }
    st.trades.push(trade);
    learnLedgerLabel(st, trade);
    txidDupApply(st, [trade], txDup);
    if (!saveStateGuarded(st)) { tradeFormError('Storage unavailable — trade was not saved.'); lockSubmit(false, 'Add record'); return; }
    if ((side === 'buy' || side === 'sell' || side === 'transfer' || isCryptoQtyExpense(trade)) && manualPrice === null) {
      // No manual quote: freeze the reference exec price in the background.
      // Saving never waits on it; failure just leaves the legacy async path.
      try { freezeExecLock(trade.id, symbol, date, mainU, (acc && acc.kind) || undefined); } catch (e) { /* ignore */ }
    }
    uiSetVal('t-qty', '');
    uiSetVal('t-toqty', '');
    uiSetVal('t-total', '');
    uiSetVal('t-note', '');
    uiSetVal('t-txid', ''); uiSetVal('t-txid-to', '');
    uiSetVal('t-networkfee', '');
    uiSetVal('t-manual-rate', '');
    uiSetVal('t-manual-price', '');
    attReset(null);
    var d = document.getElementById('t-date');
    if (d) d.value = todayDmy();
    tradeFormError(null);
    lockSubmit(false, 'Add record');
    refreshPrices(); // recompute + render when fresh prices land (renders sync too)
    try { tradePageByAccount[accountId] = 0; } catch (e) { /* ignore */ }
    try { transferDestIds(trade).forEach(function (id) { tradePageByAccount[id] = 0; }); } catch (e) { /* ignore */ }
    try {
      if (trade.sources) trade.sources.forEach(function (s) { tradePageByAccount[s.accountId] = 0; });
    } catch (e) { /* ignore */ }
    navTo(side === 'transfer' ? accountId : accountId);
    render(); // route() picks up the URL: the trade's account page shows the new rows
    closeDialog('trade-dialog');
  }
  // One fiat per trade: only the trade currency->main rate is ever needed.
  // Native total/fee stay in stone; only the lock converts for display/P&L.
  // Cross-fiat cash moves additionally lock the arrival fiat (toFxLock) so
  // the destination balance converts in the right currency.
  var mainU = String(main).toUpperCase();
  var needTotal = (total > 0 && from !== mainU);
  var destSym = isCrossFiat ? String(toAccCash.ticker).toUpperCase() : null;
  var needDest = !!(isCrossFiat && destSym && destSym !== mainU);
  var destLockForTrade = null;
  // Cash transfers zero their own currency (engine-neutral: total stays 0),
  // so the source fiat needs its own frozen rate for balance math.
  var srcSymTx = (isCashAcc && side === 'transfer') ? symbol : null;
  var needSrcFiat = !!(srcSymTx && srcSymTx !== mainU);
  var srcFiatLockForTrade = null;
  function lock11(pairFrom) {
    return { pair: pairFrom + '/' + mainU, rate: 1, source: '1:1', interpolated: false };
  }
  // An FX rate could not be locked: nothing is saved, the user is asked for a
  // manual rate. Shared by every record type (swaps included).
  function fxError(pairs) {
    lockSubmit(false, isEditing ? 'Save changes' : 'Add record');
    showBanner('FX rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.', 'error', {
      title: 'FX error',
      lines: [
        'Pair: ' + pairs.join(', '),
        'Trade date: ' + fmtDateDmy(date),
        'Cause: no ECB fixing cached and the rate request failed (weekend gap or network).',
        'Tip: nothing was saved yet — enter the rate manually to proceed.'
      ]
    });
    tradeFormError('ECB rate unavailable — open “Manual FX rate” below and enter a rate to save this trade.');
  }
  if (!needTotal && !needDest) {
    if (isCrossFiat) destLockForTrade = lock11(destSym);
    if (isCashAcc && side === 'transfer') srcFiatLockForTrade = lock11(srcSymTx);
    proceed(lock11(from));
    return;
  }
  if (manualRate !== null && !needDest) {
    if (isCrossFiat) destLockForTrade = lock11(destSym);
    if (isCashAcc && side === 'transfer') srcFiatLockForTrade = lock11(srcSymTx);
    proceed((from === mainU) ? lock11(from)
      : { pair: from + '/' + mainU, rate: manualRate, source: 'manual', interpolated: false });
    return;
  }
  lockSubmit(true, 'Saving…');
  var srcP = !needTotal
    ? Promise.resolve(lock11(from))
    : (manualRate !== null
      ? Promise.resolve((from === mainU) ? lock11(from)
        : { pair: from + '/' + mainU, rate: manualRate, source: 'manual', interpolated: false })
      : fetchEcbRate(date, from, mainU).then(function (totalRes) {
        var tLock = { pair: from + '/' + mainU, rate: totalRes.rate, source: totalRes.source, interpolated: !!totalRes.interpolated };
        try { cacheRate(date, from, mainU, totalRes.rate, totalRes.source); saveFxCache(); } catch (e) { /* ignore */ }
        return tLock;
      }));
  var destP = !needDest
    ? Promise.resolve(isCrossFiat ? lock11(destSym) : null)
    : fetchEcbRate(date, destSym, mainU).then(function (destRes) {
      var dLock = { pair: destSym + '/' + mainU, rate: destRes.rate, source: destRes.source, interpolated: !!destRes.interpolated };
      try { cacheRate(date, destSym, mainU, destRes.rate, destRes.source); saveFxCache(); } catch (e) { /* ignore */ }
      return dLock;
    });
  var srcFiatP = !needSrcFiat
    ? Promise.resolve(srcSymTx ? lock11(srcSymTx) : null)
    : fetchEcbRate(date, srcSymTx, mainU).then(function (srcRes) {
      var sLock = { pair: srcSymTx + '/' + mainU, rate: srcRes.rate, source: srcRes.source, interpolated: !!srcRes.interpolated };
      try { cacheRate(date, srcSymTx, mainU, srcRes.rate, srcRes.source); saveFxCache(); } catch (e) { /* ignore */ }
      return sLock;
    });
  Promise.all([srcP, destP, srcFiatP]).then(function (locks) {
    destLockForTrade = locks[1];
    srcFiatLockForTrade = locks[2];
    proceed(locks[0]);
  }, function () {
    var pairs = (isCashAcc && side === 'transfer')
      ? [srcSymTx + ' → ' + mainU].concat(isCrossFiat ? [destSym + ' → ' + mainU] : [])
      : [from + ' → ' + mainU];
    fxError(pairs);
  });
}
