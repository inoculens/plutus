'use strict';
// Debt position UI: reported totals only; no APR or interest arithmetic.
//
// A reported balance is something the lender already showed, so its
// observation time can never lie in the future (5 minutes of clock skew
// tolerated). Returns the form error sentence, or '' when acceptable.
function debtReportedAtIssue(reportedMs, nowMs) {
  if (typeof reportedMs !== 'number' || !isFinite(reportedMs)) return 'Enter when the balance was reported.';
  var now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
  if (reportedMs > now + 5 * 60 * 1000) return 'The reported time cannot be in the future.';
  return '';
}

function debtLocalDateTimeValue(date) {
  var d = date instanceof Date ? date : new Date(date);
  if (!isFinite(d.getTime())) d = new Date();
  function pad(v) { return v < 10 ? '0' + v : String(v); }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// Most a collateral account can pledge: everything it currently holds, in
// its own units, as form text ('' when it holds nothing). Pledges never move
// holdings, so today's balance is the whole cap.
function debtCollateralMaxText(trades, account) {
  if (!account) return '';
  var ticker = String(account.ticker || '').trim().toUpperCase();
  if (!ticker) return '';
  var txt = exactQtyHeldString(trades || [], account.id, ticker);
  if (txt === null) return '';
  var ui = qtyUiText(txt, ticker);
  if (!ui || ui.charAt(0) === '-' || !/[1-9]/.test(ui)) return '';
  return ui;
}

function debtCollateralError(message) {
  dockError('debt-position-error', message);
}

function debtCollateralRow(list, accounts, allocation) {
  var row = document.createElement('div');
  row.className = 'debt-collateral-row';
  var select = document.createElement('select');
  select.setAttribute('aria-label', 'Collateral account');
  var empty = document.createElement('option');
  empty.value = '';
  empty.textContent = 'Select collateral';
  select.appendChild(empty);
  (accounts || []).forEach(function (account) {
    var option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name + ' · ' + String(account.ticker || '').toUpperCase();
    if (allocation && allocation.accountId === account.id) option.selected = true;
    select.appendChild(option);
  });
  var quantity = document.createElement('input');
  quantity.type = 'number';
  quantity.min = '0';
  quantity.step = 'any';
  quantity.placeholder = 'Pledged quantity';
  quantity.setAttribute('aria-label', 'Pledged quantity');
  quantity.value = allocation && isFinite(Number(allocation.quantity)) ? String(allocation.quantity) : '';
  var actions = document.createElement('div');
  actions.className = 'debt-collateral-actions';
  var max = document.createElement('button');
  max.type = 'button';
  max.className = 'quiet debt-max-collateral';
  max.textContent = 'Max';
  max.addEventListener('click', function () {
    var st = loadState();
    var account = accountById(st, select.value);
    var unit = account ? String(account.ticker || '').trim().toUpperCase() : '';
    if (!account) { debtCollateralError('Choose a collateral account first.'); return; }
    var maxText = debtCollateralMaxText(st.trades, account);
    if (!maxText) {
      debtCollateralError(account.name + ' holds no ' + (unit || 'units') + ' to pledge.');
      return;
    }
    quantity.value = maxText;
    dockError('debt-position-error', '');
  });
  var remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'quiet debt-remove-collateral';
  remove.textContent = 'Remove';
  remove.addEventListener('click', function () { row.remove(); });
  actions.appendChild(max);
  actions.appendChild(remove);
  row.appendChild(select);
  row.appendChild(quantity);
  row.appendChild(actions);
  list.appendChild(row);
}

function describeDebtAsset(kind, ticker) {
  var k = String(kind || '').trim().toLowerCase();
  var t = String(ticker || '').trim().toUpperCase();
  if (!t) return 'Choose the unit in which the lender reports the debt.';
  if (k === 'crypto') {
    if (t === 'USDC') return 'USD Coin (USDC) · Live crypto quote';
    if (t === 'USDT') return 'Tether (USDT) · Live crypto quote';
    if (t === 'DAI') return 'Dai (DAI) · Live crypto quote';
    if (typeof SYMBOL_MAP === 'object' && SYMBOL_MAP && SYMBOL_MAP[t]) return SYMBOL_MAP[t] + ' (' + t + ') · Live CoinGecko quote';
    return 'Crypto (' + t + ') · manual price override if unquoted';
  }
  if (k === 'cash') {
    return 'Fiat currency (' + t + ') · ECB exchange rate';
  }
  if (k === 'commodity') {
    if (typeof hasCommoditySource === 'function' && hasCommoditySource(t)) return 'Commodity (' + t + ') · Live market quote';
    return 'Commodity (' + t + ') · manual price override';
  }
  if (k === 'stock') {
    return 'Stock / ETF (' + t + ') · Live market quote';
  }
  if (k === 'custom') {
    return 'Custom asset (' + t + ') · manual price override only';
  }
  return 'Debt denomination: ' + t;
}

function debtAssetTickerExample(kind, owner) {
  var k = String(kind || '').trim().toLowerCase();
  var ownerKind = owner ? String(owner.kind || '').trim().toLowerCase() : '';
  var ownerTicker = owner ? String(owner.ticker || '').trim().toUpperCase() : '';
  var sameKind = owner && ownerTicker && (ownerKind === k || (isCashKind(ownerKind) && isCashKind(k)));
  if (sameKind) return ownerTicker;
  if (k === 'stock') return 'SPCX';
  if (k === 'commodity') return 'XAU';
  if (k === 'cash') return 'USD';
  if (k === 'custom') return 'LOAN';
  return 'BTC';
}

function buildDebtPositionDialog() {
  var existing = document.getElementById('debt-position-dialog');
  if (existing) return existing;
  var dlg = document.createElement('dialog');
  dlg.id = 'debt-position-dialog';
  dlg.setAttribute('aria-labelledby', 'debt-position-title');
  dlg.innerHTML =
    '<div class="dialog-head"><h2 id="debt-position-title">Debt position</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="debt-position-form" novalidate>' +
    '<label for="debt-position-name">Position name</label><input id="debt-position-name" maxlength="120" required autocomplete="off">' +
    '<label>Debt denomination' + infoPill('Choose the unit in which the lender reports the debt.', 'debt-position-asset-status') + '</label><div class="debt-asset-fields">' +
    '<select id="debt-position-asset-kind" aria-label="Debt asset type">' +
    '<option value="cash">Fiat</option><option value="crypto">Crypto</option><option value="stock">Stock</option><option value="commodity">Commodity</option>' +
    '<option value="custom">Custom</option></select>' +
    '<input id="debt-position-asset-ticker" maxlength="12" pattern="[A-Za-z0-9._-]{1,12}" required autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Ticker, e.g. BTC" aria-label="Ticker"></div>' +
    '<label for="debt-position-balance">Total outstanding balance<span id="debt-position-unit"></span>' + infoPill('Enter the total balance currently reported by the lender. Plutus will keep this exact amount until you report a new one.') + '</label>' +
    '<input id="debt-position-balance" type="number" min="0" step="any" required inputmode="decimal">' +
    '<label for="debt-position-reported-at">Balance reported at</label><input id="debt-position-reported-at" type="datetime-local" required>' +
    '<label for="debt-position-note">Snapshot note (optional)</label><textarea id="debt-position-note" maxlength="280" rows="2"></textarea>' +
    '<label for="debt-position-notes">Position notes (optional)</label><textarea id="debt-position-notes" maxlength="280" rows="2"></textarea>' +
    '<div class="debt-collateral-heading"><label>Collateral sources (optional)</label>' +
    '<button id="debt-add-collateral" type="button">+ Add account</button></div>' +
    '<div id="debt-collateral-list" class="debt-collateral-list"></div>' +
    dockMarkup('debt-position-error', 'Save reported balance', 'debt-position-save') + '</form>';
  document.body.appendChild(dlg);
  wireDialog('debt-position-dialog');
  var form = document.getElementById('debt-position-form');
  var add = document.getElementById('debt-add-collateral');
  add.addEventListener('click', function () {
    var st = loadState();
    debtCollateralRow(document.getElementById('debt-collateral-list'), st.accounts || [], null);
  });
  form.addEventListener('submit', function (event) {
    if (event && event.preventDefault) event.preventDefault();
    var saveBtn = form.querySelector('.t-dock button.primary');
    if (saveBtn && (saveBtn.disabled || saveBtn.classList.contains('is-busy'))) return;
    function fail(message) {
      if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save reported balance');
      dockError('debt-position-error', message);
    }
    dockError('debt-position-error', '');
    if (flagMissingFields(form)) { fail(MISSING_FIELDS_MESSAGE); return; }
    var state = loadState();
    var ownerId = dlg.getAttribute('data-owner-id') || '';
    var owner = accountById(state, ownerId);
    if (!owner) { fail('The liability account no longer exists.'); return; }
    var positionId = dlg.getAttribute('data-position-id') || '';
    var position = null;
    accountDebtPositions(owner).forEach(function (p) { if (p.id === positionId) position = p; });
    if (positionId && !position) { fail('This debt position no longer exists. Refresh and try again.'); return; }
    var name = String(document.getElementById('debt-position-name').value || '').trim();
    var assetKindInput = document.getElementById('debt-position-asset-kind');
    var assetTickerInput = document.getElementById('debt-position-asset-ticker');
    var assetKind = position ? position.assetKind : String(assetKindInput.value || '').trim().toLowerCase();
    var assetTicker = position ? position.assetTicker : String(assetTickerInput.value || '').trim().toUpperCase();
    if (['crypto', 'stock', 'commodity', 'cash', 'custom'].indexOf(assetKind) === -1 || !/^[A-Z0-9._-]{1,12}$/.test(assetTicker)) {
      fail('Choose a supported debt asset type and enter a valid ticker.'); return;
    }
    var amount = Number(document.getElementById('debt-position-balance').value);
    var reportedInput = document.getElementById('debt-position-reported-at').value;
    var note = String(document.getElementById('debt-position-note').value || '').trim();
    if (!name || name.length > 120) { fail('Enter a position name (up to 120 characters).'); return; }
    if (!isFinite(amount) || amount < 0) { fail('Enter a valid non-negative total balance.'); return; }
    var reportedDate = new Date(reportedInput);
    var reportedIssue = reportedInput ? debtReportedAtIssue(reportedDate.getTime(), Date.now()) : 'Enter when the balance was reported.';
    if (reportedIssue) { fail(reportedIssue); return; }
    var collateral = [];
    var sourceSeen = Object.create(null);
    var rows = document.querySelectorAll('#debt-collateral-list .debt-collateral-row');
    for (var ri = 0; ri < rows.length; ri++) {
      var sourceId = String(rows[ri].querySelector('select').value || '');
      var quantityText = String(rows[ri].querySelector('input').value || '');
      if (!sourceId && !quantityText) continue;
      var quantity = Number(quantityText);
      if (!sourceId || !isFinite(quantity) || quantity <= 0) {
        fail('Choose a collateral account and enter a positive pledged quantity, or remove the empty row.');
        return;
      }
      if (sourceSeen[sourceId]) { fail('Each collateral account can appear only once per position.'); return; }
      var sourceAccount = accountById(state, sourceId);
      if (!sourceAccount) { fail('A selected collateral account no longer exists.'); return; }
      var sourceMax = debtCollateralMaxText(state.trades, sourceAccount);
      var sourceUnit = String(sourceAccount.ticker || '').trim().toUpperCase() || 'units';
      if (!sourceMax || quantity > Number(sourceMax)) {
        fail(sourceAccount.name + (sourceMax ? ' holds only ' + sourceMax : ' holds no') +
          ' ' + sourceUnit + ' available to pledge.');
        return;
      }
      sourceSeen[sourceId] = true;
      collateral.push({ accountId: sourceId, quantity: quantity });
    }
    var now = new Date().toISOString();
    var nextPosition = position ? {
      id: position.id,
      name: name,
      assetKind: position.assetKind,
      assetTicker: position.assetTicker,
      createdAt: position.createdAt,
      balanceSnapshots: position.balanceSnapshots.slice(),
      collateral: collateral
    } : {
      id: uid(),
      name: name,
      assetKind: assetKind,
      assetTicker: assetTicker,
      createdAt: now,
      balanceSnapshots: [],
      collateral: collateral
    };
    var positionNotes = String(document.getElementById('debt-position-notes').value || '').trim();
    if (positionNotes.length > 280) { fail('Position notes can be up to 280 characters.'); return; }
    if (positionNotes) nextPosition.notes = positionNotes;
    nextPosition.balanceSnapshots.push({
      id: uid(),
      amount: amount,
      reportedAt: reportedDate.toISOString(),
      enteredAt: now,
      note: note || undefined
    });
    if (!isValidDebtPosition(nextPosition, owner, state.accounts)) {
      fail('The debt position is invalid. Check the balance, timestamp and collateral details.');
      return;
    }
    setTradeSubmitBusy(saveBtn, true, 'Saving…');
    deferTradeSubmitWork(function () {
      if (!Array.isArray(owner.debtPositions)) owner.debtPositions = [];
      if (position) {
        owner.debtPositions = owner.debtPositions.map(function (p) { return p.id === position.id ? nextPosition : p; });
      } else {
        owner.debtPositions.push(nextPosition);
      }
      if (!saveStateGuarded(state)) {
        fail('Storage unavailable — the debt position was not saved.');
        return;
      }
      setTradeSubmitBusy(saveBtn, false, 'Save reported balance');
      closeDialog(dlg);
      clearBanner();
      render();
      try { refreshPrices(); } catch (e) { /* ignore */ }
    });
  });
  return dlg;
}

function openDebtPositionDialog(ownerId, positionId) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  if (!owner) return;
  var position = null;
  accountDebtPositions(owner).forEach(function (p) { if (p.id === positionId) position = p; });
  var dlg = buildDebtPositionDialog();
  dlg.setAttribute('data-owner-id', owner.id);
  dlg.setAttribute('data-position-id', position ? position.id : '');
  var title = document.getElementById('debt-position-title');
  var name = document.getElementById('debt-position-name');
  var balance = document.getElementById('debt-position-balance');
  var reported = document.getElementById('debt-position-reported-at');
  var note = document.getElementById('debt-position-note');
  var assetKindInput = document.getElementById('debt-position-asset-kind');
  var assetTickerInput = document.getElementById('debt-position-asset-ticker');
  var unit = document.getElementById('debt-position-unit');
  var list = document.getElementById('debt-collateral-list');
  title.textContent = position ? 'Update debt balance' : 'New debt position';
  name.value = position ? position.name : '';
  balance.value = position ? String((latestDebtBalanceSnapshot(position, Date.now()) || {}).amount || 0) : '';
  reported.value = debtLocalDateTimeValue(new Date());
  reported.max = reported.value;
  note.value = '';
  document.getElementById('debt-position-notes').value = (position && typeof position.notes === 'string') ? position.notes : '';
  assetKindInput.value = position ? position.assetKind : 'cash';
  assetTickerInput.value = position ? position.assetTicker : '';
  assetKindInput.disabled = !!position;
  assetTickerInput.disabled = !!position;
  function syncDebtAssetUI() {
    var kind = String(assetKindInput.value || '').trim().toLowerCase();
    var ticker = String(assetTickerInput.value || '').trim().toUpperCase();
    unit.textContent = ticker ? ' (' + ticker + ')' : '';
    assetTickerInput.placeholder = 'Ticker, e.g. ' + debtAssetTickerExample(kind, owner);
    var status = hintTextTarget(document.getElementById('debt-position-asset-status'));
    if (status) status.textContent = describeDebtAsset(kind, ticker);
  }
  assetKindInput.onchange = syncDebtAssetUI;
  assetTickerInput.oninput = syncDebtAssetUI;
  syncDebtAssetUI();
  dockError('debt-position-error', '');
  clearInvalidFields(document.getElementById('debt-position-form'));
  var saveBtn = document.getElementById('debt-position-save');
  if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save reported balance');
  list.innerHTML = '';
  var selectable = state.accounts || [];
  if (position && Array.isArray(position.collateral)) {
    position.collateral.forEach(function (allocation) { debtCollateralRow(list, selectable, allocation); });
  }
  openDialog('debt-position-dialog');
}

function removeDebtPosition(ownerId, positionId) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  if (!owner) return;
  var position = null;
  accountDebtPositions(owner).forEach(function (p) { if (p.id === positionId) position = p; });
  if (!position) return;
  confirmAction('Remove debt position', 'Permanently remove "' + position.name + '" and all of its reported balance history?', 'Remove', true).then(function (ok) {
    if (!ok) return;
    var fresh = loadState();
    var currentOwner = accountById(fresh, ownerId);
    if (!currentOwner) return;
    currentOwner.debtPositions = accountDebtPositions(currentOwner).filter(function (p) { return p.id !== positionId; });
    if (!currentOwner.debtPositions.length) delete currentOwner.debtPositions;
    if (!saveStateGuarded(fresh)) return;
    render();
    try { refreshPrices(); } catch (e) { /* ignore */ }
  });
}

// Correcting a reported balance rewrites that one snapshot in place: same
// id, same enteredAt, so the rest of the history and the net-worth timeline
// keep their identity. A position always keeps at least one report.
function buildDebtSnapshotDialog() {
  var existing = document.getElementById('debt-snapshot-dialog');
  if (existing) return existing;
  var dlg = document.createElement('dialog');
  dlg.id = 'debt-snapshot-dialog';
  dlg.setAttribute('aria-labelledby', 'debt-snapshot-title');
  dlg.innerHTML =
    '<div class="dialog-head"><h2 id="debt-snapshot-title">Edit reported balance</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="debt-snapshot-form" novalidate>' +
    '<label for="debt-snapshot-amount">Reported balance<span id="debt-snapshot-unit"></span>' + infoPill('This corrects the selected entry. The position keeps its other reported balances.') + '</label>' +
    '<input id="debt-snapshot-amount" type="number" min="0" step="any" required inputmode="decimal">' +
    '<label for="debt-snapshot-reported-at">Balance reported at</label>' +
    '<input id="debt-snapshot-reported-at" type="datetime-local" required>' +
    '<label for="debt-snapshot-note">Snapshot note (optional)</label>' +
    '<textarea id="debt-snapshot-note" maxlength="280" rows="2"></textarea>' +
    dockMarkup('debt-snapshot-error', 'Save changes', 'debt-snapshot-save') + '</form>';
  document.body.appendChild(dlg);
  wireDialog('debt-snapshot-dialog');
  var form = document.getElementById('debt-snapshot-form');
  form.addEventListener('submit', function (event) {
    if (event && event.preventDefault) event.preventDefault();
    var saveBtn = form.querySelector('.t-dock button.primary');
    if (saveBtn && (saveBtn.disabled || saveBtn.classList.contains('is-busy'))) return;
    function fail(message) {
      if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save changes');
      dockError('debt-snapshot-error', message);
    }
    dockError('debt-snapshot-error', '');
    if (flagMissingFields(form)) { fail(MISSING_FIELDS_MESSAGE); return; }
    var state = loadState();
    var owner = accountById(state, dlg.getAttribute('data-owner-id') || '');
    if (!owner) { fail('The liability account no longer exists.'); return; }
    var position = null;
    var positionId = dlg.getAttribute('data-position-id') || '';
    accountDebtPositions(owner).forEach(function (p) { if (p.id === positionId) position = p; });
    if (!position) { fail('This debt position no longer exists. Refresh and try again.'); return; }
    var snapshotId = dlg.getAttribute('data-snapshot-id') || '';
    var index = -1;
    for (var i = 0; i < position.balanceSnapshots.length; i++) {
      if (position.balanceSnapshots[i].id === snapshotId) { index = i; break; }
    }
    if (index === -1) { fail('This reported balance no longer exists. Refresh and try again.'); return; }
    var amount = Number(document.getElementById('debt-snapshot-amount').value);
    var reportedInput = document.getElementById('debt-snapshot-reported-at').value;
    var note = String(document.getElementById('debt-snapshot-note').value || '').trim();
    if (!isFinite(amount) || amount < 0) { fail('Enter a valid non-negative reported balance.'); return; }
    if (!reportedInput) { fail('Enter when the balance was reported.'); return; }
    var reportedDate = new Date(reportedInput);
    var reportedIssue = debtReportedAtIssue(reportedDate.getTime(), Date.now());
    if (reportedIssue) { fail(reportedIssue); return; }
    if (note.length > 280) { fail('Snapshot notes can be up to 280 characters.'); return; }
    var previous = position.balanceSnapshots[index];
    // The datetime field is minute-precise: an untouched timestamp keeps its
    // original seconds instead of being silently truncated on save.
    var sameTime = reportedInput === (dlg.getAttribute('data-reported-local') || '');
    var edited = {
      id: previous.id,
      amount: amount,
      reportedAt: sameTime ? previous.reportedAt : reportedDate.toISOString(),
      enteredAt: previous.enteredAt
    };
    if (note) edited.note = note;
    position.balanceSnapshots[index] = edited;
    if (!isValidDebtPosition(position, owner, state.accounts)) {
      fail('The reported balance is invalid. Check the amount and timestamp.');
      return;
    }
    setTradeSubmitBusy(saveBtn, true, 'Saving…');
    deferTradeSubmitWork(function () {
      if (!saveStateGuarded(state)) {
        fail('Storage unavailable — the reported balance was not saved.');
        return;
      }
      setTradeSubmitBusy(saveBtn, false, 'Save changes');
      closeDialog(dlg);
      clearBanner();
      render();
    });
  });
  return dlg;
}

function openDebtSnapshotDialog(ownerId, positionId, snapshotId) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  if (!owner) return;
  var position = null;
  accountDebtPositions(owner).forEach(function (p) { if (p.id === positionId) position = p; });
  if (!position) return;
  var snapshot = null;
  position.balanceSnapshots.forEach(function (s) { if (s.id === snapshotId) snapshot = s; });
  if (!snapshot) return;
  var dlg = buildDebtSnapshotDialog();
  dlg.setAttribute('data-owner-id', owner.id);
  dlg.setAttribute('data-position-id', position.id);
  dlg.setAttribute('data-snapshot-id', snapshot.id);
  var ticker = String(position.assetTicker || owner.ticker || '').trim().toUpperCase();
  document.getElementById('debt-snapshot-unit').textContent = ticker ? ' (' + ticker + ')' : '';
  document.getElementById('debt-snapshot-amount').value = String(snapshot.amount);
  var reported = document.getElementById('debt-snapshot-reported-at');
  reported.value = debtLocalDateTimeValue(new Date(snapshot.reportedAt));
  // No native max here: an imported future timestamp must still be fixable
  // through the form's own calm check (debtReportedAtIssue).
  dlg.setAttribute('data-reported-local', reported.value);
  document.getElementById('debt-snapshot-note').value = (typeof snapshot.note === 'string') ? snapshot.note : '';
  dockError('debt-snapshot-error', '');
  clearInvalidFields(document.getElementById('debt-snapshot-form'));
  var saveBtn = document.getElementById('debt-snapshot-save');
  if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save changes');
  openDialog('debt-snapshot-dialog');
}

function removeDebtSnapshot(ownerId, positionId, snapshotId) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  if (!owner) return;
  var position = null;
  accountDebtPositions(owner).forEach(function (p) { if (p.id === positionId) position = p; });
  if (!position) return;
  var snapshot = null;
  position.balanceSnapshots.forEach(function (s) { if (s.id === snapshotId) snapshot = s; });
  if (!snapshot) return;
  if (position.balanceSnapshots.length < 2) return;
  var when = new Date(snapshot.reportedAt).toLocaleString();
  confirmAction('Remove reported balance', 'Remove the ' + formatDebtPositionAmount(snapshot.amount, position) +
    ' report from ' + when + '? The position keeps its other reported balances.', 'Remove', true).then(function (ok) {
    if (!ok) return;
    var fresh = loadState();
    var freshOwner = accountById(fresh, ownerId);
    if (!freshOwner) return;
    var freshPosition = null;
    accountDebtPositions(freshOwner).forEach(function (p) { if (p.id === positionId) freshPosition = p; });
    if (!freshPosition || freshPosition.balanceSnapshots.length < 2) return;
    var kept = freshPosition.balanceSnapshots.filter(function (s) { return s.id !== snapshotId; });
    if (kept.length === freshPosition.balanceSnapshots.length) return;
    freshPosition.balanceSnapshots = kept;
    if (!isValidDebtPosition(freshPosition, freshOwner, fresh.accounts)) return;
    if (!saveStateGuarded(fresh)) return;
    clearBanner();
    render();
  });
}

// A price refresh repaints the account view and rebuilds these panels, so the
// <details> elements remember whether the owner left them open.
var debtPanelState = Object.create(null);

function debtPanel(details, key) {
  if (debtPanelState[key]) details.open = true;
  details.addEventListener('toggle', function () {
    debtPanelState[key] = !!details.open;
  });
  return details;
}

// The account's balance sheet: one card holding the net summary (an equation
// read left to right: Gross assets + Pending income − Liabilities = Net value)
// and, below it, the Pending income and Debt positions panels that feed it,
// in the same order as the equation. buildStakeRewardsSection slots its row
// in above the debt row.
function buildDebtPositionsSection(st, account, members, host, stats, financial) {
  var scope = [account].concat(members || []);
  var section = document.createElement('section');
  section.className = 'debt-positions-section balance-sheet';
  section.setAttribute('aria-label', 'Balance sheet');
  var financialRewards = financial && financial.rewards && financial.rewards.hasRewards ? financial.rewards : null;
  if (financial && financial.debt && (financial.debt.hasDebt || financialRewards)) {
    var netSummary = document.createElement('div');
    netSummary.className = 'debt-net-summary' + (financialRewards && financial.debt.hasDebt ? ' debt-net-summary-4' : '');
    function summaryLine(label, value, role, op) {
      var line = document.createElement('div');
      line.className = 'debt-net-line debt-net-' + role;
      var labelEl = document.createElement('span');
      if (op) {
        var opEl = document.createElement('i');
        opEl.className = 'debt-net-op';
        opEl.setAttribute('aria-hidden', 'true');
        opEl.textContent = op;
        labelEl.appendChild(opEl);
      }
      labelEl.appendChild(document.createTextNode(label));
      var valueEl = document.createElement('strong');
      valueEl.textContent = value;
      valueEl.title = value; // full figure stays reachable when the box truncates it
      line.appendChild(labelEl);
      line.appendChild(valueEl);
      netSummary.appendChild(line);
      return line;
    }
    var mainCcy = st.settings.mainCurrency;
    var net = reportedBalancesNet(financial.debt, financialRewards);
    summaryLine('Gross assets', financial.gross && financial.gross.complete ? fmtMoney(financial.gross.value, mainCcy) : '—', 'gross', '');
    if (financialRewards) {
      var rewardsLoading = !financialRewards.complete && scope.some(stakeRewardPricesLoading);
      summaryLine('Pending income', financialRewards.complete ? fmtMoney(financialRewards.value, mainCcy) : (rewardsLoading ? PRICE_LOADING_TEXT : '—'), 'income', '+');
    }
    if (financial.debt.hasDebt) {
      var debtLoading = !financial.debt.complete && scope.some(debtPricesLoading);
      summaryLine('Liabilities', financial.debt.complete ? fmtMoney(financial.debt.value, mainCcy) : (debtLoading ? PRICE_LOADING_TEXT : '—'), 'debt', '−');
    }
    var netKnown = financial.gross && financial.gross.complete && net.complete;
    var netLine = summaryLine('Net value', netKnown ? fmtMoney(financial.gross.value + net.value, mainCcy) : '—', 'net', '=');
    if (netKnown && financial.gross.value + net.value < 0) netLine.classList.add('is-negative');
    section.appendChild(netSummary);
    // Lendings: still yours (Net value counts them), not under your control
    // (Available leaves the whole outstanding amount out).
    var lent = financial.lent && financial.lent.hasLent ? financial.lent : null;
    if (lent) {
      var avail = document.createElement('div');
      avail.className = 'debt-net-available';
      var lentLoading = !lent.complete && scope.some(stakeRewardPricesLoading);
      var lentText = lent.complete ? fmtMoney(lent.value, mainCcy) : (lentLoading ? PRICE_LOADING_TEXT : '—');
      var lentEl = document.createElement('p');
      lentEl.className = 'debt-net-lent';
      lentEl.innerHTML = '<span><i class="debt-net-op" aria-hidden="true">−</i>Lent out</span>';
      var lentVal = document.createElement('strong');
      lentVal.textContent = lentText;
      lentVal.title = lentText;
      lentEl.appendChild(lentVal);
      var availKnown = netKnown && lent.complete;
      var availValue = availKnown ? financial.gross.value + net.value - lent.value : null;
      var availEl = document.createElement('p');
      availEl.className = 'debt-net-avail' + (availKnown && availValue < 0 ? ' is-negative' : '');
      availEl.innerHTML = '<span><i class="debt-net-op" aria-hidden="true">=</i>Available</span>';
      var availVal = document.createElement('strong');
      availVal.textContent = availKnown ? fmtMoney(availValue, mainCcy) : '—';
      availVal.title = availVal.textContent;
      availEl.appendChild(availVal);
      avail.appendChild(lentEl);
      avail.appendChild(availEl);
      section.appendChild(avail);
    }
  }
  var row = document.createElement('div');
  row.className = 'balance-sheet-row debt-positions-row';
  var header = document.createElement('div');
  header.className = 'section-head debt-section-head';
  var details = debtPanel(document.createElement('details'), 'positions:' + account.id);
  details.className = 'debt-positions-details';
  var summary = document.createElement('summary');
  var title = document.createElement('span');
  title.className = 'section-title';
  title.textContent = 'Debt positions';
  summary.appendChild(title);
  var totalCount = scope.reduce(function (count, owner) { return count + accountDebtPositions(owner).length; }, 0);
  var count = document.createElement('span');
  count.className = 'debt-position-count';
  count.textContent = String(totalCount);
  summary.appendChild(count);
  details.appendChild(summary);
  var add = document.createElement('button');
  add.type = 'button';
  add.className = 'ghost';
  add.textContent = '+ Position';
  add.setAttribute('aria-label', 'Add debt position to ' + account.name);
  add.addEventListener('click', function () { openDebtPositionDialog(account.id, null); });
  header.appendChild(add);
  row.appendChild(header);
  section.appendChild(row);
  var body = document.createElement('div');
  body.className = 'debt-position-list';
  var found = false;
  scope.forEach(function (owner) {
    var positions = accountDebtPositions(owner);
    if (!positions.length) return;
    if (scope.length > 1) {
      var ownerTitle = document.createElement('p');
      ownerTitle.className = 'debt-owner-title';
      ownerTitle.textContent = owner.name + ' · ' + String(owner.ticker || '').toUpperCase();
      body.appendChild(ownerTitle);
    }
    positions.forEach(function (position) {
      found = true;
      var item = document.createElement('article');
      item.className = 'debt-position-card';
      var top = document.createElement('div');
      top.className = 'debt-position-top';
      var nameEl = document.createElement('strong');
      nameEl.textContent = position.name;
      top.appendChild(nameEl);
      var update = document.createElement('button');
      update.type = 'button';
      update.className = 'debt-position-update';
      update.textContent = 'Update balance';
      update.addEventListener('click', function () { openDebtPositionDialog(owner.id, position.id); });
      top.appendChild(update);
      item.appendChild(top);
      // As of now, exactly like the totals: a snapshot dated in the future
      // (legacy or imported data) is never shown as the current balance.
      var latest = latestDebtBalanceSnapshot(position, Date.now());
      var amount = document.createElement('p');
      amount.className = 'debt-position-amount';
      var mainCur = String(st.settings.mainCurrency || '').trim().toUpperCase();
      var pTicker = String(position.assetTicker || (owner && owner.ticker) || '').trim().toUpperCase();
      var pKind = String(position.assetKind || (owner && owner.kind) || 'crypto').trim().toLowerCase();
      var posVal = latest ? debtPositionValuation(position, mainCur, livePrices, null, owner) : null;
      var posText = latest ? formatDebtPositionAmount(latest.amount, position) : 'No reported balance';
      if (latest && posVal && posVal.known && posVal.value !== null && (!isCashKind(pKind) || pTicker !== mainCur)) {
        posText += ' (≈ ' + fmtMoney(posVal.value, mainCur) + ')';
      }
      amount.textContent = posText;
      item.appendChild(amount);
      var reported = document.createElement('p');
      reported.className = 'debt-position-reported';
      reported.textContent = latest ? 'Last reported ' + new Date(latest.reportedAt).toLocaleString() : 'No snapshot recorded';
      item.appendChild(reported);
      if (typeof position.notes === 'string' && position.notes !== '') {
        var positionNotesEl = document.createElement('p');
        positionNotesEl.className = 'debt-position-notes';
        positionNotesEl.textContent = position.notes;
        item.appendChild(positionNotesEl);
      }
      if (Array.isArray(position.collateral) && position.collateral.length) {
        var collateral = document.createElement('p');
        collateral.className = 'debt-position-collateral';
        collateral.textContent = 'Collateral: ' + position.collateral.map(function (allocation) {
          var source = accountById(st, allocation.accountId);
          return (source ? source.name : 'Missing account') + ' · ' +
            fmtQty(allocation.quantity, source ? source.ticker : '') + ' ' +
            String(source ? source.ticker : '').toUpperCase();
        }).join(', ');
        item.appendChild(collateral);
      }
      var history = debtPanel(document.createElement('details'), 'history:' + position.id);
      history.className = 'debt-snapshot-history';
      var historySummary = document.createElement('summary');
      historySummary.textContent = 'Balance history (' + position.balanceSnapshots.length + ')';
      history.appendChild(historySummary);
      var list = document.createElement('ol');
      position.balanceSnapshots.slice().sort(function (a, b) {
        return Date.parse(b.reportedAt) - Date.parse(a.reportedAt);
      }).forEach(function (snapshot) {
        var li = document.createElement('li');
        li.className = 'debt-snapshot-item';
        var row = document.createElement('div');
        row.className = 'debt-snapshot-row';
        var snapBody = document.createElement('div');
        snapBody.className = 'debt-snapshot-body';
        var label = document.createElement('strong');
        label.textContent = formatDebtPositionAmount(snapshot.amount, position);
        snapBody.appendChild(label);
        var when = document.createElement('span');
        when.textContent = new Date(snapshot.reportedAt).toLocaleString();
        snapBody.appendChild(when);
        if (snapshot.note) {
          var memo = document.createElement('p');
          memo.textContent = snapshot.note;
          snapBody.appendChild(memo);
        }
        row.appendChild(snapBody);
        var actions = document.createElement('div');
        actions.className = 'debt-snapshot-actions';
        var edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'debt-snapshot-edit';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', 'Edit the ' + label.textContent + ' report from ' + when.textContent);
        edit.addEventListener('click', function () { openDebtSnapshotDialog(owner.id, position.id, snapshot.id); });
        actions.appendChild(edit);
        // A position always needs one reported balance; the only remaining
        // report is corrected with Edit (or the whole position removed).
        if (position.balanceSnapshots.length > 1) {
          var removeSnapshot = document.createElement('button');
          removeSnapshot.type = 'button';
          removeSnapshot.className = 'debt-snapshot-delete';
          removeSnapshot.textContent = 'Delete';
          removeSnapshot.setAttribute('aria-label', 'Delete the ' + label.textContent + ' report from ' + when.textContent);
          removeSnapshot.addEventListener('click', function () { removeDebtSnapshot(owner.id, position.id, snapshot.id); });
          actions.appendChild(removeSnapshot);
        }
        row.appendChild(actions);
        li.appendChild(row);
        list.appendChild(li);
      });
      history.appendChild(list);
      item.appendChild(history);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'debt-position-delete';
      remove.textContent = 'Remove position';
      remove.addEventListener('click', function () { removeDebtPosition(owner.id, position.id); });
      item.appendChild(remove);
      body.appendChild(item);
    });
  });
  if (!found) {
    var empty = document.createElement('p');
    empty.className = 'muted debt-empty';
    empty.textContent = 'No debt positions recorded for this account.';
    body.appendChild(empty);
  }
  details.appendChild(body);
  row.appendChild(details);
  if (stats && stats.parentNode === host) host.insertBefore(section, stats.nextSibling);
  else host.appendChild(section);
  return section;
}
