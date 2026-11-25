'use strict';
// Record form: builds the dialog, adapts it to the record type and account,
// and opens it for a new record or an edit.

// --- Trade form ---
var TRADE_CCY_OPTIONS = ['EUR', 'USD', 'GBP', 'CHF', 'RON', 'USDC', 'USDT', 'DAI'];

function ccyOptions(selected) {
  var base = TRADE_CCY_OPTIONS.map(function (c) {
    return '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + '</option>';
  }).join('');
  return base + '<option value="CUSTOM"' + (selected === 'CUSTOM' ? ' selected' : '') + '>Other…</option>';
}

function buildTradeForm() {
  var host = document.getElementById('trade-dialog-body');
  if (!host || document.getElementById('trade-form')) return;
  initInfoPills();
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<form id="trade-form">' +
    '<label for="t-side">Type</label>' +
    '<select id="t-side"><option value="buy">Buy</option><option value="sell">Sell</option><option value="transfer">Transfer (self move + gas)</option><option value="income">Income (reward / airdrop)</option><option value="expense">Expense / fee</option><option value="swap">Swap (coin → coin)</option></select>' +
    '<div id="t-account-row"><label for="t-account">Account</label>' +
    '<select id="t-account"></select></div>' +
    '<div id="t-sources-row" hidden><span class="fld-label">Spend from' + infoPill('Each source spends what it held at the record date. Fee is split evenly or attributed to any source. The total qty below stays read-only — it is the sum of the source amounts.', 't-source-hint') + '</span>' +
    '<div id="t-source-list"></div>' +
    '<button type="button" id="t-source-add">+ Add source account</button>' +
    '<button type="button" id="t-source-split">Split evenly</button>' +
    '</div>' +
    '<div id="t-toaccount-row" hidden><label for="t-toaccount" id="t-toaccount-label">To account (optional)' + infoPill('Transfer moves cost basis — only the network + fiat fees count as losses.', 't-toaccount-hint') + '</label>' +
    '<select id="t-toaccount"></select></div>' +
    '<div id="t-qty-row"><label for="t-qty" id="t-qty-label">Quantity' + infoPill('Amount you received (net of any fee taken in asset).', 't-qty-hint') + '</label>' +
    '<input id="t-qty" autocomplete="off" inputmode="decimal" placeholder="e.g. 1">' +
    '</div>' +
    '<div id="t-toqty-row" hidden><label for="t-toqty" id="t-toqty-label">Received quantity' + infoPill('', 't-toqty-hint') + '</label>' +
    '<input id="t-toqty" autocomplete="off" inputmode="decimal" placeholder="e.g. 15.2">' +
    '</div>' +
    '<div id="t-recipients" hidden><span class="fld-label">Recipients' + infoPill('One transaction, many recipients — internal moves keep their cost basis, external rows spend by default. Amount that stayed here goes in Received back below.', 't-rec-hint') + '</span>' +
    '<div id="t-rec-list"></div>' +
    '<button type="button" id="t-rec-add">+ Add recipient</button>' +
    '</div>' +
    '<div id="t-selfrecv-row" hidden><label for="t-selfrecv" id="t-selfrecv-label">Received back (same account)' + infoPill('Part of the send that stayed in this account — fee = sent − recipients − this.', 't-selfrecv-hint') + '</label>' +
    '<input id="t-selfrecv" autocomplete="off" inputmode="decimal" placeholder="e.g. 0.99">' +
    '</div>' +
    '<div class="fld-locked" hidden><span class="fld-label">Symbol (locked to account)</span> <span id="t-symbol-locked" role="status"></span></div>' +
    '<div id="t-total-row"><label for="t-total" id="t-total-label">Total (native currency)' + infoPill('Full amount paid, including the fee below.', 't-total-hint') + '</label>' +
    '<input id="t-total" autocomplete="off" inputmode="decimal" placeholder="e.g. 50000">' +
    '</div>' +
    '<div id="t-currency-row"><label for="t-currency">Currency</label>' +
    '<select id="t-currency">' + ccyOptions('EUR') + '</select></div>' +
    '<label for="t-custom-ccy" id="t-custom-ccy-label" hidden>Custom currency code</label>' +
    '<input id="t-custom-ccy" autocomplete="off" spellcheck="false" placeholder="Code, e.g. JPY" hidden>' +
    '<label for="t-date">Date' + infoPill('Format DD/MM/YYYY.', 't-date-hint') + '</label>' +
    '<input id="t-date" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="DD/MM/YYYY" maxlength="10">' +
    '<details class="adv"><summary>Details</summary>' +
    '<div id="t-ledger-row" hidden><label for="t-ledger">Ledger (optional)' + infoPill('Bookkeeping code for this record — subledgers nest by prefix (1110 under 1100 under 1000).', 't-ledger-hint') + '</label>' +
    '<input id="t-ledger" autocomplete="off" spellcheck="false" placeholder="e.g. 1100" maxlength="24" list="t-ledger-codes">' +
    '<datalist id="t-ledger-codes"></datalist>' +
    '<label for="t-ledger-label">Ledger label (optional)</label>' +
    '<input id="t-ledger-label" autocomplete="off" spellcheck="false" placeholder="e.g. Income from X" maxlength="80">' +
    '</div>' +
    '<div id="t-networkfee-row" hidden><label for="t-networkfee">Transfer fees (in same asset)' + infoPill('Fee calculated automatically from the send and received inputs above.', 't-networkfee-hint') + '</label>' +
    '<input id="t-networkfee" autocomplete="off" inputmode="decimal" placeholder="e.g. 0.0005" readonly>' +
    '</div>' +
    '<div id="t-feefiat-row"><label for="t-fee">Fee (fiat, optional)' + infoPill('Denominated in the Currency above, like everything else on this trade. The total already includes it — the Real price is simply total ÷ qty (e.g. 50 EUR ÷ 0.00058193 BTC). Info only, zero P&L drag.') + '</label>' +
    '<input id="t-fee" autocomplete="off" inputmode="decimal" placeholder="e.g. 0">' +
    '</div>' +
    '<label for="t-note">Note (optional)</label>' +
    '<input id="t-note" autocomplete="off" placeholder="e.g. monthly savings">' +
    '<div id="t-txid-row"><label for="t-txid" id="t-txid-label">Transaction ID (optional)' + infoPill('Optional — saved with the record; BTC hashes link to mempool.space, other assets get a copy button.', 't-txid-hint') + '</label>' +
    '<input id="t-txid" autocomplete="off" spellcheck="false" placeholder="e.g. paste the tx hash"></div>' +
    '<div id="t-txid-to-row" hidden><label for="t-txid-to" id="t-txid-to-label">Received TX ID</label>' +
    '<input id="t-txid-to" autocomplete="off" spellcheck="false" placeholder="Optional — paste the tx hash"></div>' +
    '<div id="t-attach-row"><label for="t-attach">Attach invoice / receipt (optional)' + infoPill('Optional — PDF, PNG or JPG up to 10 MB. Stored on this device, synced encrypted when sync is on.', 't-attach-hint') + '</label>' +
    '<input id="t-attach" type="file" accept="application/pdf,image/png,image/jpeg">' +
    '<p class="fld-hint" id="t-attach-cur" hidden></p>' +
    '<button type="button" id="t-attach-remove" hidden>Remove file</button></div>' +
    '<label for="t-manual-rate">Manual FX rate (optional fallback when ECB is unavailable)</label>' +
    '<input id="t-manual-rate" autocomplete="off" inputmode="decimal" placeholder="e.g. 0.92">' +
    '<label for="t-manual-price">Manual exec price (optional, this trade only, in trade fiat)</label>' +
    '<input id="t-manual-price" autocomplete="off" inputmode="decimal" placeholder="e.g. 67000">' +
    '</details>' +
    '<div class="t-dock">' +
    '<div id="t-error-panel" class="t-err" role="alert" aria-live="assertive" hidden>' +
    '<div class="t-err-row"><p id="t-error" class="banner-error t-err-text"></p>' +
    '<button type="button" id="t-error-close" class="t-err-close" aria-label="Dismiss this message">✕</button></div>' +
    '<div class="t-err-progress"><div id="t-err-bar" class="t-err-bar"></div></div></div>' +
    '<button class="primary" type="submit" id="t-submit">Add record</button>' +
    '</div>' +
    '</form>';
  host.appendChild(wrap);
  var form = document.getElementById('trade-form');
  form.addEventListener('submit', onTradeSubmit);
  var dateEl = document.getElementById('t-date');
  if (dateEl) wireDateInput(dateEl);
  var acctSel = document.getElementById('t-account');
  if (acctSel) {
    acctSel.addEventListener('change', function () { syncLockedSymbol(); syncTradeTypeUI(); });
  }
  var sideSel = document.getElementById('t-side');
  if (sideSel) sideSel.addEventListener('change', syncTradeTypeUI);
  // One name per code: typing an existing code fills its current name when
  // the label is still empty (a different typed name renames everywhere on
  // save, same as the main Edit button).
  var ledCodeEl = document.getElementById('t-ledger');
  if (ledCodeEl) ledCodeEl.addEventListener('input', function () {
    try {
      var labEl = document.getElementById('t-ledger-label');
      if (!labEl || String(labEl.value || '').trim() !== '') return;
      var code = String(ledCodeEl.value || '').trim();
      if (!code) return;
      var stL = loadState();
      var accId = uiVal('t-account', '');
      if (!accountById(stL, accId)) return;
      var scope = null;
      try { scope = ledgerScopeOf(stL, accId); } catch (e) { scope = null; }
      var known = findLedgerLabel(stL, accId, code, scope);
      if (known) labEl.value = known;
    } catch (e) { /* never block typing */ }
  });
  var qtyEl = document.getElementById('t-qty');
  if (qtyEl) qtyEl.addEventListener('input', function () { try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var selfRecvEl = document.getElementById('t-selfrecv');
  if (selfRecvEl) selfRecvEl.addEventListener('input', function () { try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var toQtyEl = document.getElementById('t-toqty');
  if (toQtyEl) toQtyEl.addEventListener('input', function () { try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var recAdd = document.getElementById('t-rec-add');
  if (recAdd) recAdd.addEventListener('click', function () { try { addRecipientRow(); } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var srcAdd = document.getElementById('t-source-add');
  if (srcAdd) srcAdd.addEventListener('click', function () {
    try {
      var rows = readSourceRows();
      if (rows.length >= TRANSFER_MAX_SOURCES) { tradeFormError('Max ' + TRANSFER_MAX_SOURCES + ' source accounts.'); return; }
      addSourceRow();
    } catch (e) { /* ignore */ } try { syncTransferFeePreview(); } catch (e) { /* ignore */ } });
  var srcSplit = document.getElementById('t-source-split');
  if (srcSplit) srcSplit.addEventListener('click', function () { try { splitFeeEvenlyUI(); } catch (e) { /* ignore */ } });
  var toSel = document.getElementById('t-toaccount');
  if (toSel) toSel.addEventListener('change', function () { try { syncTradeTypeUI(); } catch (e) { /* hint only */ } });
  var ccy = document.getElementById('t-currency');
  var custom = document.getElementById('t-custom-ccy');
  ccy.addEventListener('change', function () {
    var needCustom = (ccy.value === 'CUSTOM');
    custom.hidden = !needCustom;
    var clabel = document.getElementById('t-custom-ccy-label');
    if (clabel) clabel.hidden = !needCustom;
  });
  var attInp = document.getElementById('t-attach');
  if (attInp) attInp.addEventListener('change', function () {
    try {
      pendingAttachFile = (attInp.files && attInp.files[0]) ? attInp.files[0] : null;
      if (pendingAttachFile) pendingAttachRemove = false;
      var cur = document.getElementById('t-attach-cur');
      if (pendingAttachFile && cur) { cur.textContent = 'New file: ' + pendingAttachFile.name; cur.hidden = false; }
      attUiSync();
    } catch (e) { /* never block the form */ }
  });
  var attRm = document.getElementById('t-attach-remove');
  if (attRm) attRm.addEventListener('click', function () {
    pendingAttachFile = null;
    try { if (attInp) attInp.value = ''; } catch (e) { /* ignore */ }
    if (currentAttachMeta) pendingAttachRemove = true;
    else pendingAttachRemove = false;
    attUiSync();
  });
  syncTradeTypeUI();
}
// Swap records carry one transaction ID per side: the sent leg's hash and the
// received leg's hash. Other types keep the single Transaction ID box. Each
// label keeps its info pill and gets a small ticker tag so it is obvious
// which asset the hash belongs to.
function syncSwapTxUI(isSwap, fromTicker, toTicker) {
  function relabel(labelId, text, ticker) {
    var lab = document.getElementById(labelId);
    if (!lab) return;
    var node = null;
    for (var i = 0; i < lab.childNodes.length; i++) {
      if (lab.childNodes[i].nodeType === 3) { node = lab.childNodes[i]; break; }
    }
    if (!node) { node = document.createTextNode(''); lab.insertBefore(node, lab.firstChild); }
    node.data = text;
    var old = lab.querySelector('.txid-tag');
    if (old) lab.removeChild(old);
    if (ticker) {
      var tag = document.createElement('span');
      tag.className = 'txid-tag';
      tag.textContent = ticker;
      if (node.nextSibling) lab.insertBefore(tag, node.nextSibling); else lab.appendChild(tag);
    }
  }
  var toRow = document.getElementById('t-txid-to-row');
  if (toRow) toRow.hidden = !isSwap;
  var fromIn = document.getElementById('t-txid');
  if (isSwap) {
    relabel('t-txid-label', 'Sent TX ID', fromTicker);
    relabel('t-txid-to-label', 'Received TX ID', toTicker);
    if (fromIn) fromIn.placeholder = 'Optional — paste the tx hash';
  } else {
    relabel('t-txid-label', 'Transaction ID (optional)', '');
    if (fromIn) fromIn.placeholder = 'e.g. paste the tx hash';
  }
  var pill = document.getElementById('t-txid-hint');
  if (pill) {
    var tip = isSwap
      ? 'Optional — one hash for each side of the swap. Bitcoin hashes link to mempool.space; other assets show the hash as text. Every hash has a copy button.'
      : 'Optional — saved with the record; BTC hashes link to mempool.space, other assets get a copy button.';
    pill.setAttribute('data-info', tip);
    pill.setAttribute('aria-label', tip);
  }
}

function syncTradeTypeUI() {
  var sideEl = document.getElementById('t-side');
  var type = sideEl ? sideEl.value : 'buy';
  function setHidden(id, hide) { var el = document.getElementById(id); if (el) el.hidden = !!hide; }
  function setLabel(id, txt) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.classList && el.classList.contains('info-pill')) {
      el.setAttribute('data-info', txt);
      el.setAttribute('aria-label', txt);
      el.hidden = !String(txt);
      return;
    }
    el.textContent = txt;
  }
  // Cash accounts are bookkeeping ledgers: only money-movement types.
  // (Legacy buy/sell/swap records on cash stay editable, never creatable.)
  var cashAcc = null;
  try { cashAcc = accountById(peekState(), uiVal('t-account', '')); } catch (e) { cashAcc = null; }
  var isCash = !!(cashAcc && isCashKind(cashAcc.kind));
  var cashTicker = isCash ? String(cashAcc.ticker || '').toUpperCase() : '';
  var legacyCashEdit = false;
  try { legacyCashEdit = !!(editingTradeId && (type === 'buy' || type === 'sell' || type === 'swap')); } catch (e) { legacyCashEdit = false; }
  if (isCash && !legacyCashEdit && sideEl) {
    var want = ['income', 'expense', 'transfer'];
    var labels = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };
    var cur = sideEl.value;
    sideEl.innerHTML = '';
    want.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = labels[v];
      sideEl.appendChild(o);
    });
    sideEl.value = (want.indexOf(cur) !== -1) ? cur : 'income';
    type = sideEl.value;
  } else if (!isCash && sideEl && sideEl.options && sideEl.options.length !== 6) {
    // Back to a non-cash account: restore the full type list.
    var full = ['buy', 'sell', 'transfer', 'income', 'expense', 'swap'];
    var fullLabels = { buy: 'Buy', sell: 'Sell', transfer: 'Transfer (self move + gas)', income: 'Income (reward / airdrop)', expense: 'Expense / fee', swap: 'Swap (coin → coin)' };
    var curF = sideEl.value;
    sideEl.innerHTML = '';
    full.forEach(function (v) {
      var oo = document.createElement('option');
      oo.value = v;
      oo.textContent = fullLabels[v];
      sideEl.appendChild(oo);
    });
    if (full.indexOf(curF) !== -1) sideEl.value = curF;
    type = sideEl.value;
  }
  var isTransfer = type === 'transfer';
  var isSwap = type === 'swap';
  var isIncome = type === 'income';
  var isExpense = type === 'expense';
  var isBuySell = type === 'buy' || type === 'sell';
  setHidden('t-toaccount-row', !isSwap);
  // A swap is one record in the UI: its receipt/txid are mirrored on both
  // linked legs, so the attachment row stays available.
  setHidden('t-attach-row', false);
  setHidden('t-toqty-row', !isSwap);
  setHidden('t-recipients', !isTransfer);
  setHidden('t-selfrecv-row', !isTransfer);
  setHidden('t-sources-row', !isTransfer);
  // While a transfer is being built its source rows own the total, so the
  // quantity box is read-only and filled by syncTransferFeePreview. Every
  // other type edits the quantity directly: unlock it and drop the derived
  // total so it never leaks into a buy, sell, income, expense or swap.
  if (!isTransfer) {
    try {
      var qtyUnlock = document.getElementById('t-qty');
      if (qtyUnlock && qtyUnlock.readOnly) {
        qtyUnlock.readOnly = false;
        qtyUnlock.value = '';
      }
    } catch (e) { /* ignore */ }
  }
  setHidden('t-networkfee-row', !(isTransfer));
  // Transfers carry no fiat of their own: the network fee IS the fee, valued
  // in fiat at the frozen historical rate. Fiat fee + total + currency stay
  // for the other types only.
  setHidden('t-feefiat-row', isTransfer);
  setHidden('t-total-row', isTransfer);
  setHidden('t-currency-row', isTransfer);
  if (isTransfer) {
    var custT = document.getElementById('t-custom-ccy');
    if (custT) custT.hidden = true;
    var clabT = document.getElementById('t-custom-ccy-label');
    if (clabT) clabT.hidden = true;
  }
  if (isTransfer) {
    setLabel('t-qty-label', 'You send (total)');
    setLabel('t-qty-hint', 'Total leaving the source — recipients + received back + fee must equal this.');
    setLabel('t-total-label', 'Fiat fee value (optional, leave 0)');
    setLabel('t-total-hint', 'Optional cash fee on top — leave empty when the fee is crypto-only.');
  } else if (isSwap) {
    setLabel('t-qty-label', 'From quantity (you send)');
    setLabel('t-toqty-label', 'Received quantity');
    setLabel('t-total-label', 'Fiat value (optional)');
    setLabel('t-qty-hint', 'Amount leaving the source account.');
    setLabel('t-total-hint', 'Leave empty to calculate it from the historical rates on the date. Enter your own figure to override — it is carried by both swap legs.');
    setLabel('t-toqty-hint', 'Amount arriving in the destination account.');
    setLabel('t-toaccount-label', 'To account');
  } else if (isIncome) {
    setLabel('t-qty-label', isCash ? ('Amount (in ' + cashTicker + ')') : 'Quantity received');
    setLabel('t-total-label', 'Market value at receipt (optional, 0 = free)');
    setLabel('t-qty-hint', isCash ? 'Money in, in the account currency.' : 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else if (isExpense) {
    var expTicker = (cashAcc && cashAcc.ticker) ? String(cashAcc.ticker).toUpperCase() : '';
    setLabel('t-qty-label', isCash ? ('Amount (in ' + cashTicker + ')') : ('Amount spent' + (expTicker ? ' (in ' + expTicker + ')' : '')));
    setLabel('t-total-label', 'Fiat lost');
    setLabel('t-qty-hint', isCash ? 'Money out, in the account currency.' : 'Exactly what left this account. Its fiat value is calculated from the rate on the date.');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else if (type === 'sell') {
    // Selling mirrors buying: quantity leaves, fiat arrives. The verbs keep
    // the direction obvious in both the labels and the hints.
    setLabel('t-qty-label', 'Amount sold');
    setLabel('t-total-label', 'Total received (native currency)');
    setLabel('t-qty-hint', 'Amount you sold (the asset leaves this account).');
    setLabel('t-total-hint', 'Full amount received, including the fee below.');
    setLabel('t-toqty-hint', '');
  } else {
    setLabel('t-qty-label', 'Quantity');
    setLabel('t-total-label', 'Total (native currency)');
    setLabel('t-qty-hint', 'Amount you received (net of any fee taken in asset).');
    setLabel('t-total-hint', 'Full amount paid, including the fee below.');
    setLabel('t-toqty-hint', '');
  }
  try {
    var totalPh = document.getElementById('t-total');
    if (totalPh) totalPh.placeholder = isSwap ? 'Auto — from historical rates' : 'e.g. 50000';
  } catch (e) { /* ignore */ }
  // Cash income/expense amounts live in the account fiat alone: the total
  // and currency rows hide (submit derives total=qty, currency=ticker).
  var cashSimple = isCash && (isIncome || isExpense);
  if (cashSimple) {
    setHidden('t-total-row', true);
    setHidden('t-currency-row', true);
    var custC = document.getElementById('t-custom-ccy');
    if (custC) custC.hidden = true;
    var clabC = document.getElementById('t-custom-ccy-label');
    if (clabC) clabC.hidden = true;
  }
  // An expense paid in the account asset has no fiat input: what left the
  // account is the quantity, and its fiat value is derived from the spend-date
  // rate (a website's own fx rate must never book a different amount). Only
  // when editing an old fiat-only record do the fiat rows stay, so it can
  // still be saved as it was.
  if (isExpense && !isCash) {
    var legacyFiatExp = false;
    try {
      var edExp = editingTradeId ? (peekState().trades || []).filter(function (x) { return x && x.id === editingTradeId; })[0] : null;
      legacyFiatExp = !!(edExp && edExp.type === 'expense' && !isCryptoQtyExpense(edExp) && Number(edExp.total) > 0);
    } catch (e) { legacyFiatExp = false; }
    if (!legacyFiatExp) {
      setHidden('t-total-row', true);
      setHidden('t-currency-row', true);
      var custE = document.getElementById('t-custom-ccy');
      if (custE) custE.hidden = true;
      var clabE = document.getElementById('t-custom-ccy-label');
      if (clabE) clabE.hidden = true;
    } else {
      setLabel('t-qty-label', 'Amount spent (optional for this older fiat-only record)');
    }
  }
  // Ledger row: cash income/expense always; asset income/expense only when
  // the global switch is on (optional at submit, required never).
  setHidden('t-ledger-row', !tradeLedgerAllowed(isCash, type));
  try {
    var dl = document.getElementById('t-ledger-codes');
    if (dl && tradeLedgerAllowed(isCash, type)) {
      var known = {};
      try {
        var stL = loadState();
        var dlScope = null;
        try { dlScope = ledgerScopeOf(stL, cashAcc.id); } catch (e) { dlScope = null; }
        if (!dlScope || !dlScope.length) dlScope = [cashAcc.id];
        var inDl = {};
        dlScope.forEach(function (sid) { inDl[sid] = true; });
        ((stL && stL.trades) || []).forEach(function (t) {
          if (t && inDl[t.accountId] && t.ledger && String(t.ledger).trim() !== '') known[String(t.ledger).trim()] = true;
        });
        var mapL = null;
        try {
          var chartAcc = cashAcc.id;
          var gmChart = groupMainOf(stL, cashAcc.id);
          if (gmChart) chartAcc = gmChart.id;
          mapL = ledgerChartFor(stL, chartAcc);
        } catch (e) { mapL = ledgerChartFor(stL, cashAcc.id); }
        Object.keys(mapL).forEach(function (k) { known[String(k).trim()] = true; });
      } catch (e) { /* ignore */ }
      dl.innerHTML = '';
      Object.keys(known).sort().forEach(function (c) {
        var op = document.createElement('option');
        op.value = c;
        dl.appendChild(op);
      });
    }
  } catch (e) { /* ignore */ }
  if (!isTransfer) {
    // Leaving a transfer must restore the custom-currency input when the
    // (now visible again) Currency select sits on Other….
    try {
      var ccySel = document.getElementById('t-currency');
      var needCustom = !!(ccySel && ccySel.value === 'CUSTOM');
      var custR = document.getElementById('t-custom-ccy');
      if (custR) custR.hidden = !needCustom;
      var clabR = document.getElementById('t-custom-ccy-label');
      if (clabR) clabR.hidden = !needCustom;
    } catch (e) { /* ignore */ }
  }
  // Rebuild to-account options for swaps (any other account). Transfers use
  // the recipients list below instead of this single select.
  try {
    var st = loadState();
    var fromId = uiVal('t-account', '');
    var fromAcc = accountById(st, fromId);
    var toSel = document.getElementById('t-toaccount');
    var hint = hintTextTarget(document.getElementById('t-toaccount-hint'));
    if (toSel && isSwap) {
      var prevTo = toSel.value;
      toSel.innerHTML = '';
      var curKept = false;
      (st.accounts || []).forEach(function (a) {
        if (a.id === fromId) return;
        var o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
        toSel.appendChild(o);
        if (a.id === prevTo) curKept = true;
      });
      if (prevTo && curKept) toSel.value = prevTo;
      else if (toSel.options.length) toSel.selectedIndex = 0;
      if (hint) hint.textContent = 'Both legs belong to one swap — the pair is edited and deleted together.';
    }
    try {
      var toAccTx = (toSel && isSwap) ? accountById(st, toSel.value) : null;
      syncSwapTxUI(isSwap, fromAcc ? String(fromAcc.ticker || '').toUpperCase() : '', toAccTx ? String(toAccTx.ticker || '').toUpperCase() : '');
    } catch (e) { /* labels fall back to the plain text */ }
    if (isTransfer) {
      try { refreshRecipientAccounts(); } catch (e) { /* ignore */ }
      if (isCash) setLabel('t-qty-label', 'You send (total, in ' + cashTicker + ')');
      // (Re)build the primary source row fixed to the current account.
      try {
        var srcList = document.getElementById('t-source-list');
        if (srcList && !srcList.querySelectorAll('.src-row').length) {
          clearSourceRows();
          addSourceRow();
        }
        refreshSourceAccounts();
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  void isBuySell; void isIncome; void isExpense;
  try { syncTransferFeePreview(); } catch (e) { /* ignore */ }
}

// --- Account-bound record dialog ---
// First field is the Account select (options rebuilt on every open);
// the symbol is shown locked read-only to that account's ticker.
// openPrefillTrade(accountId|null) preselects the originating card's
// account (or the default for null/unknown) and opens the dialog.

function syncLockedSymbol() {
  var sel = document.getElementById('t-account');
  var locked = document.getElementById('t-symbol-locked');
  if (!sel || !locked) return;
  var acc = accountById(peekState(), sel.value);
  locked.textContent = acc ? String(acc.ticker).toUpperCase() : '';
}

var editingTradeId = null;

// Fresh-trade reset: a new dialog must never inherit type, amounts, notes or
// destination picks from the previous entry — otherwise e.g. a Transfer's
// To-account row leaks into the next Buy.
function resetTradeForm() {
  editingTradeId = null;
  var sideReset = document.getElementById('t-side');
  if (sideReset) sideReset.disabled = false;
  uiSetVal('t-side', 'buy');
  uiSetVal('t-qty', '');
  try {
    var qtyReset = document.getElementById('t-qty');
    if (qtyReset) qtyReset.readOnly = false; // a transfer may have locked it
  } catch (e) { /* ignore */ }
  uiSetVal('t-toqty', '');
  uiSetVal('t-selfrecv', '');
  clearRecipientRows();
  clearSourceRows();
  transferSourcesAuto = true;
  uiSetVal('t-total', '');
  var ccy = document.getElementById('t-currency');
  if (ccy) ccy.value = 'EUR';
  uiSetVal('t-custom-ccy', '');
  var cust = document.getElementById('t-custom-ccy');
  if (cust) cust.hidden = true;
  var clab = document.getElementById('t-custom-ccy-label');
  if (clab) clab.hidden = true;
  uiSetVal('t-fee', '');
  uiSetVal('t-note', '');
  uiSetVal('t-txid', ''); uiSetVal('t-txid-to', '');
  uiSetVal('t-networkfee', '');
  uiSetVal('t-ledger', '');
  uiSetVal('t-ledger-label', '');
  uiSetVal('t-manual-rate', '');
  uiSetVal('t-manual-price', '');
  var toSel = document.getElementById('t-toaccount');
  if (toSel) toSel.innerHTML = '';
  var submitBtn0 = document.getElementById('t-submit');
  if (submitBtn0) { setTradeSubmitBusy(submitBtn0, false, 'Add record'); }
  var titleEl0 = document.getElementById('trade-dialog-title');
  if (titleEl0) titleEl0.textContent = 'Add record';
  var dd = document.getElementById('t-date');
  if (dd) dd.value = todayDmy();
  tradeFormError(null);
  attReset(null);
}

function openPrefillTrade(accountId, lockIt, presetType) {
  var st = loadState();
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  if (!accounts.length) {
    showBanner('Create your first account to enable Add record.');
    var host = document.getElementById('accounts');
    if (host && host.scrollIntoView) {
      try { host.scrollIntoView(); } catch (e) { /* ignore */ }
    }
    return null;
  }
  editingTradeId = null;
  var target = ((typeof accountId === 'string' && accountId.length > 0) && accountById(st, accountId)) ||
    accounts[0];
  buildTradeForm(); // ensure the form exists (init normally builds it)
  var sel = document.getElementById('t-account');
  if (sel) {
    sel.innerHTML = '';
    accounts.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = target.id;
  }
  var sideSel = document.getElementById('t-side');
  if (sideSel && presetType && TRADE_TYPES.concat(['swap']).indexOf(presetType) !== -1) sideSel.value = presetType;
  // Locked context (e.g. opened from an account page): the account is fixed,
  // so the select is hidden. From home the select stays visible.
  var row = document.getElementById('t-account-row');
  if (row) row.style.display = (lockIt && target) ? 'none' : '';
  syncLockedSymbol();
  resetTradeForm();
  // resetTradeForm defaults the type to Buy; re-apply an explicit preset after it.
  if (sideSel && presetType && TRADE_TYPES.concat(['swap']).indexOf(presetType) !== -1) sideSel.value = presetType;
  syncTradeTypeUI();
  openDialog('trade-dialog');
  return target;
}

function openEditTrade(tradeId) {
  var st = loadState();
  var tr = null;
  (st.trades || []).forEach(function (t) { if (t && t.id === tradeId) tr = t; });
  if (!tr) return;
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  if (!accounts.length) return;
  buildTradeForm();
  editingTradeId = tradeId;
  var swapPair = null;
  try { swapPair = swapPairForTrade(st, tr); } catch (e) { swapPair = null; }
  var srcTr = swapPair ? swapPair.sell : tr;
  var dstTr = swapPair ? swapPair.buy : null;
  var sel = document.getElementById('t-account');
  if (sel) {
    sel.innerHTML = '';
    accounts.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + ' · ' + String(a.ticker).toUpperCase();
      sel.appendChild(opt);
    });
    sel.value = srcTr.accountId || accounts[0].id;
  }
  var row = document.getElementById('t-account-row');
  if (row) row.style.display = '';
  var sideSel = document.getElementById('t-side');
  if (sideSel) {
    sideSel.disabled = false;
    var tt = swapPair ? 'swap' : (tr.type === 'buy' || tr.type === 'sell' || tr.type === 'transfer' || tr.type === 'income' || tr.type === 'expense' ? tr.type : 'buy');
    // Legacy buy/sell/swap on cash stays editable: ensure the full type
    // list exists before selecting (cash-new mode filters it).
    if ((tt === 'buy' || tt === 'sell' || tt === 'swap') && sideSel.options && sideSel.options.length !== 6) {
      var fullE = ['buy', 'sell', 'transfer', 'income', 'expense', 'swap'];
      var fullLE = { buy: 'Buy', sell: 'Sell', transfer: 'Transfer (self move + gas)', income: 'Income (reward / airdrop)', expense: 'Expense / fee', swap: 'Swap (coin → coin)' };
      sideSel.innerHTML = '';
      fullE.forEach(function (v) {
        var ooe = document.createElement('option');
        ooe.value = v;
        ooe.textContent = fullLE[v];
        sideSel.appendChild(ooe);
      });
    }
    sideSel.value = tt;
    // One swap is one record: the pair is edited together, never as a buy
    // or a sell leg in isolation.
    sideSel.disabled = !!swapPair;
  }
  syncLockedSymbol();
  syncTradeTypeUI();
  uiSetVal('t-qty', srcTr.qty !== undefined && srcTr.qty !== null ? qtyUiText(srcTr.qty, String(srcTr.symbol || '').toUpperCase()) : '');
  uiSetVal('t-toqty', dstTr && dstTr.qty !== undefined && dstTr.qty !== null ? qtyUiText(dstTr.qty, String(dstTr.symbol || '').toUpperCase()) : '');
  uiSetVal('t-total', srcTr.total !== undefined && srcTr.total !== null ? String(srcTr.total) : '');
  try {
    var cSel = document.getElementById('t-currency');
    if (cSel && srcTr.currency) {
      var cu = String(srcTr.currency).toUpperCase();
      var has = Array.prototype.some.call(cSel.options, function (o) { return o.value === cu; });
      if (has) cSel.value = cu;
      else { cSel.value = 'CUSTOM'; cSel.dispatchEvent(new Event('change', { bubbles: true })); uiSetVal('t-custom-ccy', cu); }
    }
  } catch (e) { /* ignore */ }
  uiSetVal('t-date', fmtDateDmy(srcTr.date || todayStr()));
  uiSetVal('t-fee', srcTr.fee !== undefined && srcTr.fee !== null ? String(srcTr.fee) : '');
  uiSetVal('t-note', swapPair ? swapNoteClean(srcTr.note || (dstTr && dstTr.note)) : (tr.note || ''));
  uiSetVal('t-ledger', (srcTr.ledger === undefined || srcTr.ledger === null) ? '' : String(srcTr.ledger));
  uiSetVal('t-ledger-label', (srcTr.ledgerLabel === undefined || srcTr.ledgerLabel === null) ? '' : String(srcTr.ledgerLabel));
  var srcTxText = srcTr.txid !== undefined && srcTr.txid !== null ? String(srcTr.txid) : '';
  var dstTxText = (dstTr && dstTr.txid !== undefined && dstTr.txid !== null) ? String(dstTr.txid) : '';
  if (swapPair) {
    // Older swaps mirrored one hash on both legs: show it once, on the sent side.
    if (srcTxText === '' && dstTxText !== '') { srcTxText = dstTxText; dstTxText = ''; }
    else if (dstTxText === srcTxText) dstTxText = '';
    uiSetVal('t-txid', srcTxText);
    uiSetVal('t-txid-to', dstTxText);
  } else {
    uiSetVal('t-txid', srcTxText);
    uiSetVal('t-txid-to', '');
  }
  uiSetVal('t-networkfee', srcTr.networkFee !== undefined && srcTr.networkFee !== null ? qtyUiText(srcTr.networkFee, String(srcTr.symbol || '').toUpperCase()) : '');
  if (tr.type === 'transfer') {
    // Recipients replace the old single-destination inputs: stored outputs
    // repopulate row-for-row; legacy records migrate to one row on open.
    // The same-account remainder is filled from selfQty, or derived for an
    // old no-destination self-move.
    clearRecipientRows();
    uiSetVal('t-selfrecv', '');
    var erows = [];
    if (Array.isArray(tr.outputs) && tr.outputs.length) {
      tr.outputs.forEach(function (o) {
        if (isTransferOutputInternal(o)) {
          erows.push({
            kind: 'internal',
            accountId: String(o.toAccountId).trim(),
            qty: String(o.qty),
            fee: (o.fee !== undefined && o.fee !== null) ? String(o.fee) : '',
            toQty: (o.toQty !== undefined && o.toQty !== null) ? String(o.toQty) : ''
          });
        } else if (o && typeof o === 'object') {
          erows.push({
            kind: 'external',
            label: String(o.label || ''),
            qty: String(o.qty),
            fee: (o.fee !== undefined && o.fee !== null) ? String(o.fee) : '',
            spend: o.spend !== false
          });
        }
      });
    } else if (tr.toAccountId) {
      var trQty = Number(tr.qty);
      var trNf = (tr.networkFee === undefined || tr.networkFee === null || String(tr.networkFee).trim() === '') ? 0 : Number(tr.networkFee);
      var crossSym = (tr.toSymbol !== undefined && tr.toSymbol !== null && String(tr.toSymbol).trim() !== '')
        ? String(tr.toSymbol).trim().toUpperCase() : String(tr.symbol || '').toUpperCase();
      if (crossSym !== String(tr.symbol || '').toUpperCase()) {
        erows.push({ kind: 'internal', accountId: tr.toAccountId, qty: String(tr.qty), fee: '', toQty: (tr.toQty !== undefined && tr.toQty !== null) ? String(tr.toQty) : '' });
      } else if (isFinite(trQty) && trQty > 0 && isFinite(trNf) && trNf >= 0 && trNf < trQty) {
        var decET = qtyDecimals(tr.symbol);
        var qScET = exactScaledOf(tr.qty, decET);
        var nfScET = exactScaledOf((tr.networkFee === undefined || tr.networkFee === null || String(tr.networkFee).trim() === '') ? 0 : tr.networkFee, decET);
        erows.push({ kind: 'internal', accountId: tr.toAccountId, qty: (qScET !== null && nfScET !== null && qScET > nfScET) ? exactToStringTrim(qScET - nfScET, decET) : String(trQty - trNf), fee: '' });
      }
    }
    erows.forEach(function (r) { try { addRecipientRow(r); } catch (e) { /* ignore */ } });
    // Multi-source: repopulate source rows from the stored `sources` list.
    // Legacy records without `sources` keep the single primary source row
    // that syncTradeTypeUI already created; explicit sources replace it.
    var srcList = document.getElementById('t-source-list');
    var srcRowsBuilt = null;
    if (Array.isArray(tr.sources) && tr.sources.length) {
      srcRowsBuilt = tr.sources;
      transferSourcesAuto = false; // explicit fees: manual mode
      clearSourceRows();
      var storedAutoModes = (Array.isArray(tr.sourceFeeAuto) && tr.sourceFeeAuto.length === srcRowsBuilt.length && tr.sourceFeeAuto.every(function (v) { return typeof v === 'boolean'; })) ? tr.sourceFeeAuto : null;
      srcRowsBuilt.forEach(function (s, sidx) {
        addSourceRow({
          accountId: s.accountId,
          qty: s.qty !== undefined ? s.qty : '',
          fee: s.fee !== undefined ? s.fee : '',
          auto: storedAutoModes ? storedAutoModes[sidx] : !s.fee
        });
      });
    } else {
      // Legacy single source: fill the primary row that syncTradeTypeUI created.
      transferSourcesAuto = true;
      var first = srcList ? srcList.querySelector('.src-row') : null;
      if (first) {
        var si = first.querySelector('.src-account');
        if (si) si.value = tr.accountId;
        var qi = first.querySelector('.src-qty');
        if (qi) qi.value = String(tr.qty !== undefined ? tr.qty : '');
        // A single source derives its fee from the recipients, so the old
        // stored fee is recomputed by the preview rather than typed back in.
        var fi = first.querySelector('.src-fee');
        if (fi) fi.value = '';
        var ai = first.querySelector('.src-auto');
        if (ai) ai.checked = true;
      }
    }
    try { refreshSourceAccounts(); refreshRecipientAccounts(); } catch (e) { /* ignore */ }
    try {
      var allRows = srcList ? srcList.querySelectorAll('.src-row') : [];
      if (allRows.length) syncSourceRowMode(allRows[0]);
    } catch (e) { /* ignore */ }
    var storedSelf = transferSelfQtyOf(tr);
    if (storedSelf > 0) {
      uiSetVal('t-selfrecv', qtyUiText(storedSelf, String(tr.symbol || '').toUpperCase()));
    } else if (!erows.length) {
      // Same-account move: restore what arrived back so the locked fee
      // recomputes exactly (legacy records carry sent + fee only).
      var selfQty = Number(tr.qty);
      var selfNf = (tr.networkFee === undefined || tr.networkFee === null || String(tr.networkFee).trim() === '') ? 0 : Number(tr.networkFee);
      if (isFinite(selfQty) && selfQty > 0 && isFinite(selfNf) && selfNf >= 0 && selfNf < selfQty) {
        var decES = qtyDecimals(tr.symbol);
        var qScES = exactScaledOf(tr.qty, decES);
        var nfScES = exactScaledOf((tr.networkFee === undefined || tr.networkFee === null || String(tr.networkFee).trim() === '') ? 0 : tr.networkFee, decES);
        uiSetVal('t-selfrecv', (qScES !== null && nfScES !== null && qScES > nfScES) ? exactToStringTrim(qScES - nfScES, decES) : String(selfQty - selfNf));
      }
    }
  }
  // Manual fields reflect their persistent state, like every other input:
  // the FX rate lives on in the trade's manual fxLock, the price in the
  // trade's manual execLock (else the global override for the symbol).
  // Blank only when nothing is stored anywhere.
  var manualFxRate = '';
  try {
    var fxSrc = srcTr.fxLock || (dstTr && dstTr.fxLock);
    if (fxSrc && fxSrc.source === 'manual' && isFinite(Number(fxSrc.rate)) && Number(fxSrc.rate) > 0) {
      manualFxRate = String(fxSrc.rate);
    }
  } catch (e) { manualFxRate = ''; }
  uiSetVal('t-manual-rate', manualFxRate);
  var manualPx = '';
  try {
    var pxTr = dstTr || tr;
    var frMan = frozenExecOf(pxTr);
    if (frMan && String(frMan.source).toLowerCase() === 'manual') {
      manualPx = String(frMan.price);
    } else {
      var ovMan = priceOverrideEntry(pxTr.symbol, PRICE_KIND_BY_ACCOUNT[pxTr.accountId]);
      if (ovMan !== null) manualPx = String(ovMan.price);
    }
  } catch (e) { manualPx = ''; }
  uiSetVal('t-manual-price', manualPx);
  try {
    var toSel = document.getElementById('t-toaccount');
    if (toSel && swapPair) {
      // syncTradeTypeUI rebuilt the destination list for this source.
      toSel.value = swapPair.buy.accountId;
    }
  } catch (e) { /* ignore */ }
  try { syncTransferFeePreview(); } catch (e) { /* ignore */ }
  var submitBtn2 = document.getElementById('t-submit');
  if (submitBtn2) { setTradeSubmitBusy(submitBtn2, false, 'Save changes'); }
  var titleEl2 = document.getElementById('trade-dialog-title');
  if (titleEl2) titleEl2.textContent = swapPair ? 'Edit swap' : 'Edit record';
  tradeFormError(null);
  attReset(swapPair ? (swapPair.sell.attachment || swapPair.buy.attachment) : tr.attachment);
  openDialog('trade-dialog');
}
