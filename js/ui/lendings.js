'use strict';
// Lending UI: the lending card inside Pending income, and the Repayment /
// Write off dialog. The math and the records live in js/data/lendings.js;
// this file only collects the inputs, previews the interest-first split and
// saves the entry and its record together.

function lendingFmt(value, entry) {
  return formatDebtPositionAmount(value, entry);
}

// The card body under the name: what is owed (≈ main), the split, borrower,
// due date and the last report. `item` is the card element.
function buildLendingCardBody(st, owner, entry, item, mainCur) {
  var parts = lendingParts(entry);
  var settled = !(parts.total > 0);
  var amount = document.createElement('p');
  amount.className = 'debt-position-amount';
  var text = parts.snapshot ? (settled ? 'Settled' : lendingFmt(parts.total, entry) + ' owed') : 'No reported balance';
  if (!settled && parts.snapshot) {
    var shim = { assetKind: entry.assetKind, assetTicker: entry.assetTicker,
      balanceSnapshots: [{ id: 'owed', amount: parts.total, reportedAt: parts.snapshot.reportedAt, enteredAt: parts.snapshot.enteredAt }] };
    var val = debtPositionValuation(shim, mainCur, livePrices, null, owner);
    var inMain = isCashKind(entry.assetKind) && entry.assetTicker === mainCur;
    if (val.known && val.value !== null && !inMain) text += ' (≈ ' + fmtMoney(val.value, mainCur) + ')';
  }
  amount.textContent = text;
  amount.title = text;
  item.appendChild(amount);
  var split = document.createElement('p');
  split.className = 'debt-position-reported lending-split';
  split.textContent = lendingFmt(parts.principal, entry) + ' lent + ' + lendingFmt(parts.interest, entry) + ' interest' +
    (typeof entry.borrower === 'string' && entry.borrower ? ' · ' + entry.borrower : '');
  item.appendChild(split);
  var due = lendingDueState(entry, todayStr());
  if (due) {
    var dueEl = document.createElement('p');
    dueEl.className = 'debt-position-reported lending-due' + (due === 'overdue' ? ' is-overdue' : '');
    dueEl.textContent = (due === 'overdue' ? 'Overdue since ' : 'Due ') + fmtDateDmy(entry.dueDate);
    item.appendChild(dueEl);
  }
  var reported = document.createElement('p');
  reported.className = 'debt-position-reported';
  reported.textContent = parts.snapshot
    ? (settled ? 'Nothing owed · last update ' : 'Not available until repaid · last reported ') + new Date(parts.snapshot.reportedAt).toLocaleString()
    : 'No report recorded';
  item.appendChild(reported);
  return { settled: settled };
}

function buildLendingSettleDialog() {
  var existing = document.getElementById('lending-settle-dialog');
  if (existing) return existing;
  var dlg = document.createElement('dialog');
  dlg.id = 'lending-settle-dialog';
  dlg.setAttribute('aria-labelledby', 'lending-settle-title');
  dlg.innerHTML =
    '<div class="dialog-head"><h2 id="lending-settle-title">Repayment</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="lending-settle-form" novalidate>' +
    '<p id="lending-settle-owed" class="stake-claim-pending"></p>' +
    '<label for="lending-settle-amount"><span id="lending-settle-amount-label">Amount repaid</span><span id="lending-settle-unit"></span>' +
    infoPill('Interest is settled first, then the amount lent. A partial amount keeps the rest outstanding.', 'lending-settle-help') + '</label>' +
    '<input id="lending-settle-amount" type="number" min="0" step="any" required inputmode="decimal">' +
    '<p id="lending-settle-preview" class="lending-preview" aria-live="polite"></p>' +
    '<label for="lending-settle-at"><span id="lending-settle-at-label">Repaid at</span></label><input id="lending-settle-at" type="datetime-local" required>' +
    '<div id="lending-settle-value-wrap"><label for="lending-settle-value">Value of the interest when received<span id="lending-settle-ccy"></span> (optional)' +
    infoPill('What the interest part was worth when it arrived. It becomes its cost basis. Leave it empty to record it at zero cost.') + '</label>' +
    '<input id="lending-settle-value" type="number" min="0" step="any" inputmode="decimal"></div>' +
    '<div id="lending-settle-rate-wrap"><label for="lending-settle-rate">Exchange rate<span id="lending-settle-pair"></span> (optional)' +
    infoPill('Leave it empty to use the ECB rate of that date. Enter a rate only if that rate is unavailable or your bank used another one.') + '</label>' +
    '<input id="lending-settle-rate" type="number" min="0" step="any" inputmode="decimal"></div>' +
    '<label for="lending-settle-note">Record note (optional)</label><textarea id="lending-settle-note" maxlength="280" rows="2"></textarea>' +
    dockMarkup('lending-settle-error', 'Save', 'lending-settle-save') + '</form>';
  document.body.appendChild(dlg);
  wireDialog('lending-settle-dialog');
  var form = document.getElementById('lending-settle-form');
  form.addEventListener('input', lendingSettlePreview);
  form.addEventListener('submit', function (event) {
    if (event && event.preventDefault) event.preventDefault();
    var saveBtn = form.querySelector('.t-dock button.primary');
    if (saveBtn && (saveBtn.disabled || saveBtn.classList.contains('is-busy'))) return;
    var mode = dlg.getAttribute('data-mode') === 'writeoff' ? 'writeoff' : 'repay';
    var label = mode === 'writeoff' ? 'Write off' : 'Save repayment';
    function fail(message) {
      if (saveBtn) setTradeSubmitBusy(saveBtn, false, label);
      dockError('lending-settle-error', message);
    }
    dockError('lending-settle-error', '');
    if (flagMissingFields(form)) { fail(MISSING_FIELDS_MESSAGE); return; }
    var state0 = loadState();
    var owner0 = accountById(state0, dlg.getAttribute('data-owner-id') || '');
    var entry0 = owner0 ? findStakeReward(owner0, dlg.getAttribute('data-reward-id') || '') : null;
    if (!owner0 || !isStakeLendingEntry(entry0)) { fail('This lending no longer exists. Refresh and try again.'); return; }
    var atInput = document.getElementById('lending-settle-at').value;
    var atMs = atInput ? new Date(atInput).getTime() : NaN;
    if (!isFinite(atMs)) { fail('Enter when it happened.'); return; }
    if (debtReportedAtIssue(atMs, Date.now())) { fail('The time cannot be in the future.'); return; }
    var main = String(state0.settings.mainCurrency || '').toUpperCase();
    var ticker = String(owner0.ticker || '').trim().toUpperCase();
    var input = {
      amount: document.getElementById('lending-settle-amount').value,
      at: atMs,
      value: mode === 'repay' ? document.getElementById('lending-settle-value').value : '',
      note: document.getElementById('lending-settle-note').value
    };
    var build = mode === 'writeoff' ? buildLendingWriteOff : buildLendingRepayment;
    // Validate everything that needs no rate before any network wait.
    var dry = build(owner0, entry0, Object.assign({}, input, { fxLock: { rate: 1 } }), main);
    if (dry.error) { fail(dry.error); return; }
    var needRate = !!dry.trade && isCashKind(owner0.kind) && ticker !== main;
    var date = stakeRewardClaimDate(atMs);
    var rateRaw = String(document.getElementById('lending-settle-rate').value || '').trim();
    var lockP;
    if (!needRate) lockP = Promise.resolve(null);
    else if (rateRaw !== '') {
      var manual = Number(rateRaw);
      if (!isFinite(manual) || manual <= 0) { fail('The exchange rate must be more than 0.'); return; }
      lockP = Promise.resolve({ pair: ticker + '/' + main, rate: manual, source: 'manual', interpolated: false });
    } else {
      lockP = fetchEcbRate(date, ticker, main).then(function (res) {
        try { cacheRate(date, ticker, main, res.rate, res.source); saveFxCache(); } catch (e) { /* ignore */ }
        return { pair: ticker + '/' + main, rate: res.rate, source: res.source, interpolated: !!res.interpolated };
      }, function () { return null; });
    }
    setTradeSubmitBusy(saveBtn, true, 'Saving…');
    lockP.then(function (lock) {
      if (needRate && !lock) { fail('ECB rate for ' + ticker + '/' + main + ' unavailable — enter the exchange rate.'); return; }
      deferTradeSubmitWork(function () {
        // Fresh state: a slow rate fetch must not overwrite newer writes.
        var state = loadState();
        var owner = accountById(state, owner0.id);
        var entry = owner ? findStakeReward(owner, entry0.id) : null;
        if (!owner || !isStakeLendingEntry(entry)) { fail('This lending no longer exists. Refresh and try again.'); return; }
        var built = build(owner, entry, Object.assign({}, input, { fxLock: lock }), main);
        if (built.error) { fail(built.error); return; }
        if (built.trade) {
          var recordIssue = validateTrade(built.trade, 1e18);
          if (recordIssue) { fail('The record is invalid: ' + recordIssue + '.'); return; }
          try {
            var conflict = heldTimelineConflict(state.trades || [], built.trade, null);
            if (conflict) { fail(heldConflictMessage(conflict, [built.trade], state)); return; }
          } catch (e) { /* the engine clamps anyway */ }
        }
        var next = Object.assign({}, entry, { balanceSnapshots: entry.balanceSnapshots.concat([built.snapshot]), pledge: built.pledge });
        if (!isValidStakeReward(next, owner, state.accounts)) { fail('This could not be recorded. Check the amount and time.'); return; }
        owner.stakeRewards = accountStakeRewards(owner).map(function (r) { return r.id === entry.id ? next : r; });
        if (built.trade) {
          if (!Array.isArray(state.trades)) state.trades = [];
          state.trades.push(built.trade);
        }
        if (!saveStateGuarded(state)) { fail('Storage unavailable — nothing was saved.'); return; }
        if (built.trade) {
          try { tradePageByAccount[owner.id] = 0; } catch (e) { /* ignore */ }
          if (isCryptoQtyExpense(built.trade)) {
            try { freezeExecLock(built.trade.id, built.trade.symbol, built.trade.date, main, owner.kind || undefined); } catch (e) { /* ignore */ }
          }
        }
        setTradeSubmitBusy(saveBtn, false, label);
        closeDialog(dlg);
        clearBanner();
        render();
        try { refreshPrices(); } catch (e) { /* ignore */ }
      });
    });
  });
  return dlg;
}

// Live split under the amount: interest first, then principal, and what
// each part writes.
function lendingSettlePreview() {
  var dlg = document.getElementById('lending-settle-dialog');
  var out = document.getElementById('lending-settle-preview');
  if (!dlg || !out) return;
  var state = loadState();
  var owner = accountById(state, dlg.getAttribute('data-owner-id') || '');
  var entry = owner ? findStakeReward(owner, dlg.getAttribute('data-reward-id') || '') : null;
  if (!isStakeLendingEntry(entry)) { out.textContent = ''; return; }
  var mode = dlg.getAttribute('data-mode') === 'writeoff' ? 'writeoff' : 'repay';
  var raw = String(document.getElementById('lending-settle-amount').value || '').trim();
  var main = String(state.settings.mainCurrency || '').toUpperCase();
  var build = mode === 'writeoff' ? buildLendingWriteOff : buildLendingRepayment;
  var built = raw === '' ? null : build(owner, entry, { amount: raw, at: Date.now() - 1000, fxLock: { rate: 1 } }, main);
  out.classList.toggle('is-error', !!(built && built.error));
  if (!built) { out.textContent = ''; return; }
  if (built.error) { out.textContent = built.error; return; }
  var bits = [];
  if (built.interest > 0) {
    bits.push(lendingFmt(built.interest, entry) + (mode === 'writeoff' ? ' interest forgiven' : ' interest, recorded as income'));
  }
  if (built.principal > 0) {
    bits.push(lendingFmt(built.principal, entry) + (mode === 'writeoff' ? ' lost, recorded as an expense' : ' back in your Available balance'));
  }
  var left = built.snapshot.total;
  out.textContent = bits.join(' · ') + (left > 0 ? ' · ' + lendingFmt(left, entry) + ' still owed' : ' · nothing left owed');
}

function openLendingSettleDialog(ownerId, rewardId, mode) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  var entry = owner ? findStakeReward(owner, rewardId) : null;
  if (!owner || !isStakeLendingEntry(entry)) return;
  var writeOff = mode === 'writeoff';
  var dlg = buildLendingSettleDialog();
  dlg.setAttribute('data-owner-id', owner.id);
  dlg.setAttribute('data-reward-id', entry.id);
  dlg.setAttribute('data-mode', writeOff ? 'writeoff' : 'repay');
  var ticker = entry.assetTicker;
  var main = String(state.settings.mainCurrency || '').toUpperCase();
  var parts = lendingParts(entry);
  var fiat = isCashKind(owner.kind);
  document.getElementById('lending-settle-title').textContent = (writeOff ? 'Write off · ' : 'Repayment · ') + entry.name;
  document.getElementById('lending-settle-owed').textContent = 'Owed: ' + lendingFmt(parts.total, entry) +
    ' (' + lendingFmt(parts.principal, entry) + ' lent + ' + lendingFmt(parts.interest, entry) + ' interest)' +
    (parts.snapshot ? ' · reported ' + new Date(parts.snapshot.reportedAt).toLocaleString() : '');
  document.getElementById('lending-settle-amount-label').textContent = writeOff ? 'Amount written off' : 'Amount repaid';
  document.getElementById('lending-settle-at-label').textContent = writeOff ? 'Written off at' : 'Repaid at';
  var help = hintTextTarget(document.getElementById('lending-settle-help'));
  if (help) {
    help.textContent = writeOff
      ? 'Money you will not get back. Interest is forgiven first and needs no record; a lost amount lent leaves the account as an Expense record. Use it for a default, a forgiven loan or a failed platform.'
      : 'Interest is settled first and recorded as Income in this account; the amount lent needs no record (it never left your records) and returns to your Available balance. A partial amount keeps the rest outstanding.';
  }
  document.getElementById('lending-settle-unit').textContent = ' (' + ticker + ')';
  document.getElementById('lending-settle-ccy').textContent = main ? ' (' + main + ')' : '';
  document.getElementById('lending-settle-pair').textContent = ' (1 ' + ticker + ' in ' + main + ')';
  document.getElementById('lending-settle-amount').value = parts.total > 0 ? qtyUiText(String(parts.total), ticker) : '';
  var at = document.getElementById('lending-settle-at');
  at.value = debtLocalDateTimeValue(new Date());
  at.max = at.value;
  document.getElementById('lending-settle-value').value = '';
  document.getElementById('lending-settle-rate').value = '';
  document.getElementById('lending-settle-note').value = '';
  document.getElementById('lending-settle-value-wrap').hidden = writeOff || fiat;
  document.getElementById('lending-settle-rate-wrap').hidden = !fiat || ticker === main;
  dockError('lending-settle-error', '');
  clearInvalidFields(document.getElementById('lending-settle-form'));
  var saveBtn = document.getElementById('lending-settle-save');
  if (saveBtn) {
    saveBtn.classList.toggle('danger-btn', writeOff);
    setTradeSubmitBusy(saveBtn, false, writeOff ? 'Write off' : 'Save repayment');
  }
  lendingSettlePreview();
  openDialog('lending-settle-dialog');
}
