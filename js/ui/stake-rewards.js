'use strict';
// Pending income UI (stake rewards, accrued yield, receivables): pending
// totals reported by the payer, no yield math. Shares the debt UI's building
// blocks (js/ui/debt.js): reported-time check, datetime field values,
// denomination hints and remembered <details> state.
// Claim (Mark paid for fiat) is the one action debt has no equivalent of: it
// records the received amount as an Income record and lowers the pending
// amount in one save.

function stakeRewardKindOptions() {
  return '<option value="crypto">Crypto</option><option value="cash">Fiat</option><option value="stock">Stock</option>' +
    '<option value="commodity">Commodity</option><option value="custom">Custom</option>';
}

function describeStakeRewardAsset(kind, ticker) {
  if (!String(ticker || '').trim()) return 'Choose what this income is paid in.';
  return describeDebtAsset(kind, ticker);
}

// Pledge rows reuse the debt collateral row styles: account, quantity, Max
// (everything the account holds today) and Remove. Only accounts holding
// the entry's own asset are offered.
function stakePledgeRow(list, accounts, row) {
  var el = document.createElement('div');
  el.className = 'debt-collateral-row stake-pledge-row';
  var select = document.createElement('select');
  select.setAttribute('aria-label', 'Pledged account');
  var empty = document.createElement('option');
  empty.value = '';
  empty.textContent = 'Select account';
  select.appendChild(empty);
  (accounts || []).forEach(function (account) {
    var option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name + ' · ' + String(account.ticker || '').toUpperCase();
    if (row && row.accountId === account.id) option.selected = true;
    select.appendChild(option);
  });
  var quantity = document.createElement('input');
  quantity.type = 'number';
  quantity.min = '0';
  quantity.step = 'any';
  quantity.placeholder = 'Pledged quantity';
  quantity.setAttribute('aria-label', 'Pledged quantity');
  quantity.value = row && isFinite(Number(row.quantity)) ? qtyUiText(String(row.quantity), (accounts[0] || {}).ticker) : '';
  var actions = document.createElement('div');
  actions.className = 'debt-collateral-actions';
  var max = document.createElement('button');
  max.type = 'button';
  max.className = 'quiet debt-max-collateral';
  max.textContent = 'Max';
  max.addEventListener('click', function () {
    var st = loadState();
    var account = accountById(st, select.value);
    if (!account) { dockError('stake-reward-error', 'Choose the pledged account first.'); return; }
    var maxText = debtCollateralMaxText(st.trades, account);
    if (!maxText) { dockError('stake-reward-error', account.name + ' holds no ' + String(account.ticker || '').toUpperCase() + ' to pledge.'); return; }
    quantity.value = maxText;
    dockError('stake-reward-error', '');
    quantity.dispatchEvent(new Event('input', { bubbles: true }));
  });
  var remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'quiet debt-remove-collateral';
  remove.textContent = 'Remove';
  remove.addEventListener('click', function () {
    el.remove();
    list.dispatchEvent(new Event('input', { bubbles: true }));
  });
  actions.appendChild(max);
  actions.appendChild(remove);
  el.appendChild(select);
  el.appendChild(quantity);
  el.appendChild(actions);
  list.appendChild(el);
}

// Accounts a pledge in this asset can come from: same ticker and kind.
function stakePledgeAccounts(st, kind, ticker) {
  var k = String(kind || '').trim().toLowerCase();
  var t = String(ticker || '').trim().toUpperCase();
  return (st.accounts || []).filter(function (account) {
    return !!account && String(account.ticker || '').trim().toUpperCase() === t &&
      String(account.kind || 'crypto').trim().toLowerCase() === k;
  });
}

function buildStakeRewardDialog() {
  var existing = document.getElementById('stake-reward-dialog');
  if (existing) return existing;
  var dlg = document.createElement('dialog');
  dlg.id = 'stake-reward-dialog';
  dlg.setAttribute('aria-labelledby', 'stake-reward-title');
  dlg.innerHTML =
    '<div class="dialog-head"><h2 id="stake-reward-title">Pending income</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="stake-reward-form" novalidate>' +
    '<label for="stake-reward-name">Name</label><input id="stake-reward-name" maxlength="120" required autocomplete="off" placeholder="e.g. Aave ETH supply, Invoice 114">' +
    '<label>Paid in' + infoPill('Choose what this income is paid in.', 'stake-reward-asset-status') + '</label><div class="debt-asset-fields">' +
    '<select id="stake-reward-asset-kind" aria-label="Asset type">' + stakeRewardKindOptions() + '</select>' +
    '<input id="stake-reward-asset-ticker" maxlength="12" pattern="[A-Za-z0-9._-]{1,12}" required autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Ticker, e.g. ETH" aria-label="Ticker"></div>' +
    '<label for="stake-reward-mode">Reported as' + infoPill('Earned amount only: the payer shows just what you earned (unclaimed rewards, an invoice). Total including a pledge: the payer shows what you put in plus what it earned, as Aave or a term deposit does. Plutus subtracts the pledge for you; the pledged amount stays in its accounts, no record moves it.') + '</label>' +
    '<select id="stake-reward-mode"><option value="plain">Earned amount only</option><option value="pledge">Total including a pledge</option></select>' +
    '<div id="stake-reward-pledge-wrap" hidden><div class="debt-collateral-heading"><label>Pledged from</label>' +
    '<button id="stake-reward-add-pledge" type="button">+ Add account</button></div>' +
    '<div id="stake-reward-pledge-list" class="debt-collateral-list"></div></div>' +
    '<label for="stake-reward-balance"><span id="stake-reward-balance-label">Pending amount</span><span id="stake-reward-unit"></span>' + infoPill('The amount as the payer shows it now. Plutus keeps this exact figure, and counts what is earned in your net worth, until you report a new one or it is paid.') + '</label>' +
    '<input id="stake-reward-balance" type="number" min="0" step="any" required inputmode="decimal">' +
    '<p id="stake-reward-earned" class="stake-claim-pending" hidden></p>' +
    '<label for="stake-reward-reported-at">Reported at</label><input id="stake-reward-reported-at" type="datetime-local" required>' +
    '<label for="stake-reward-note">Snapshot note (optional)</label><textarea id="stake-reward-note" maxlength="280" rows="2"></textarea>' +
    '<label for="stake-reward-notes">Notes (optional)</label><textarea id="stake-reward-notes" maxlength="280" rows="2"></textarea>' +
    dockMarkup('stake-reward-error', 'Save', 'stake-reward-save') + '</form>';
  document.body.appendChild(dlg);
  wireDialog('stake-reward-dialog');
  var form = document.getElementById('stake-reward-form');
  document.getElementById('stake-reward-add-pledge').addEventListener('click', function () {
    var st = loadState();
    var kind = document.getElementById('stake-reward-asset-kind').value;
    var ticker = document.getElementById('stake-reward-asset-ticker').value;
    var choices = stakePledgeAccounts(st, kind, ticker);
    if (!choices.length) { dockError('stake-reward-error', 'No account holds ' + String(ticker || 'that asset').toUpperCase() + ' to pledge.'); return; }
    stakePledgeRow(document.getElementById('stake-reward-pledge-list'), choices, null);
  });
  form.addEventListener('input', function () { stakeRewardSyncEarned(); });
  form.addEventListener('change', function () { stakeRewardSyncEarned(); });
  form.addEventListener('submit', function (event) {
    if (event && event.preventDefault) event.preventDefault();
    var saveBtn = form.querySelector('.t-dock button.primary');
    if (saveBtn && (saveBtn.disabled || saveBtn.classList.contains('is-busy'))) return;
    function fail(message) {
      if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save');
      dockError('stake-reward-error', message);
    }
    dockError('stake-reward-error', '');
    if (flagMissingFields(form)) { fail(MISSING_FIELDS_MESSAGE); return; }
    var state = loadState();
    var owner = accountById(state, dlg.getAttribute('data-owner-id') || '');
    if (!owner) { fail('The account no longer exists.'); return; }
    var rewardId = dlg.getAttribute('data-reward-id') || '';
    var reward = rewardId ? findStakeReward(owner, rewardId) : null;
    if (rewardId && !reward) { fail('This pending income no longer exists. Refresh and try again.'); return; }
    var name = String(document.getElementById('stake-reward-name').value || '').trim();
    var assetKind = reward ? reward.assetKind : String(document.getElementById('stake-reward-asset-kind').value || '').trim().toLowerCase();
    var assetTicker = reward ? reward.assetTicker : String(document.getElementById('stake-reward-asset-ticker').value || '').trim().toUpperCase();
    var pledgeMode = reward ? isStakePledgeEntry(reward) : document.getElementById('stake-reward-mode').value === 'pledge';
    if (STAKE_REWARD_KINDS.indexOf(assetKind) === -1 || !/^[A-Z0-9._-]{1,12}$/.test(assetTicker)) {
      fail('Choose a supported asset type and enter a valid ticker.'); return;
    }
    if (isCashKind(assetKind) && !isValidCurrencyCode(assetTicker)) { fail('Enter a currency code for fiat, e.g. EUR.'); return; }
    var amountRaw = String(document.getElementById('stake-reward-balance').value || '').trim();
    var amount = Number(amountRaw);
    var reportedInput = document.getElementById('stake-reward-reported-at').value;
    var note = String(document.getElementById('stake-reward-note').value || '').trim();
    var notes = String(document.getElementById('stake-reward-notes').value || '').trim();
    if (!name || name.length > 120) { fail('Enter a name (up to 120 characters).'); return; }
    if (!isFinite(amount) || amount < 0) { fail(pledgeMode ? 'Enter the total the payer shows (0 or more).' : 'Enter a valid pending amount (0 or more).'); return; }
    if (qtyOverPrecise(amountRaw, assetTicker)) { fail(qtyPrecisionError(assetTicker)); return; }
    var reportedDate = new Date(reportedInput);
    var reportedIssue = reportedInput ? debtReportedAtIssue(reportedDate.getTime(), Date.now()) : 'Enter when the balance was reported.';
    if (reportedIssue) { fail(reportedIssue); return; }
    if (notes.length > 280) { fail('Notes can be up to 280 characters.'); return; }
    var pledge = null;
    if (pledgeMode) {
      pledge = [];
      var seen = Object.create(null);
      var rows = document.querySelectorAll('#stake-reward-pledge-list .stake-pledge-row');
      for (var ri = 0; ri < rows.length; ri++) {
        var sourceId = String(rows[ri].querySelector('select').value || '');
        var qtyText = String(rows[ri].querySelector('input').value || '').trim();
        if (!sourceId && !qtyText) continue;
        var qty = Number(qtyText);
        if (!sourceId || !isFinite(qty) || qty <= 0) { fail('Choose an account and enter a positive pledged quantity, or remove the empty row.'); return; }
        if (seen[sourceId]) { fail('Each account can appear only once in a pledge.'); return; }
        var source = accountById(state, sourceId);
        if (!source || stakePledgeAccounts(state, assetKind, assetTicker).indexOf(source) === -1) {
          fail('Pledged accounts must hold ' + assetTicker + '.'); return;
        }
        if (qtyOverPrecise(qtyText, assetTicker)) { fail(qtyPrecisionError(assetTicker)); return; }
        var maxText = debtCollateralMaxText(state.trades, source);
        if (!maxText || qty > Number(maxText)) {
          fail(source.name + (maxText ? ' holds only ' + maxText : ' holds no') + ' ' + assetTicker + ' to pledge.'); return;
        }
        seen[sourceId] = true;
        pledge.push({ accountId: sourceId, quantity: Number(exactQtyValue(qtyText, assetTicker)) });
      }
    }
    var now = new Date().toISOString();
    var next = {
      id: reward ? reward.id : uid(),
      name: name,
      assetKind: assetKind,
      assetTicker: assetTicker,
      createdAt: reward ? reward.createdAt : now,
      balanceSnapshots: reward ? reward.balanceSnapshots.slice() : []
    };
    if (notes) next.notes = notes;
    var snapshot;
    if (pledgeMode) {
      next.pledge = pledge;
      snapshot = stakePledgeSnapshot(next, amountRaw, reportedDate.toISOString(), note);
      if (!snapshot) { fail('Enter the total the payer shows (0 or more).'); return; }
    } else {
      snapshot = { id: uid(), amount: amount, reportedAt: reportedDate.toISOString(), enteredAt: now };
      if (note) snapshot.note = note;
    }
    next.balanceSnapshots.push(snapshot);
    if (!isValidStakeReward(next, owner, state.accounts)) { fail('The pending income is invalid. Check the amounts and timestamp.'); return; }
    setTradeSubmitBusy(saveBtn, true, 'Saving…');
    deferTradeSubmitWork(function () {
      if (!Array.isArray(owner.stakeRewards)) owner.stakeRewards = [];
      if (reward) owner.stakeRewards = owner.stakeRewards.map(function (r) { return r.id === reward.id ? next : r; });
      else owner.stakeRewards.push(next);
      if (!saveStateGuarded(state)) { fail('Storage unavailable — the pending income was not saved.'); return; }
      setTradeSubmitBusy(saveBtn, false, 'Save');
      closeDialog(dlg);
      clearBanner();
      render();
      try { refreshPrices(); } catch (e) { /* ignore */ }
    });
  });
  return dlg;
}

// Pledge mode: the amount field holds the total the payer shows; a live line
// under it shows what Plutus will count (total - pledge).
function stakeRewardSyncEarned() {
  var mode = document.getElementById('stake-reward-mode');
  var wrap = document.getElementById('stake-reward-pledge-wrap');
  var out = document.getElementById('stake-reward-earned');
  var label = document.getElementById('stake-reward-balance-label');
  if (!mode || !wrap || !out || !label) return;
  var pledgeMode = mode.value === 'pledge';
  wrap.hidden = !pledgeMode;
  label.textContent = pledgeMode ? 'Total the payer shows' : 'Pending amount';
  out.hidden = !pledgeMode;
  if (!pledgeMode) return;
  var ticker = String(document.getElementById('stake-reward-asset-ticker').value || '').trim().toUpperCase();
  var rows = [];
  document.querySelectorAll('#stake-reward-pledge-list .stake-pledge-row').forEach(function (row) {
    var q = String(row.querySelector('input').value || '').trim();
    if (q !== '' && isFinite(Number(q)) && Number(q) > 0) rows.push({ quantity: q });
  });
  var pledged = stakePledgeSum(rows, ticker);
  var totalRaw = String(document.getElementById('stake-reward-balance').value || '').trim();
  var earned = totalRaw === '' ? null : stakePledgeEarned(totalRaw, pledged, ticker);
  var pledgedText = qtyUiText(String(pledged), ticker) + ' ' + ticker;
  out.textContent = earned === null
    ? 'Pledged: ' + pledgedText + '. Enter the total to see what is earned.'
    : 'Earned: ' + qtyUiText(String(earned), ticker) + ' ' + ticker + ' (total − ' + pledgedText + ' pledged)';
}

function openStakeRewardDialog(ownerId, rewardId) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  if (!owner) return;
  var reward = rewardId ? findStakeReward(owner, rewardId) : null;
  var dlg = buildStakeRewardDialog();
  dlg.setAttribute('data-owner-id', owner.id);
  dlg.setAttribute('data-reward-id', reward ? reward.id : '');
  var kindInput = document.getElementById('stake-reward-asset-kind');
  var tickerInput = document.getElementById('stake-reward-asset-ticker');
  var modeInput = document.getElementById('stake-reward-mode');
  var unit = document.getElementById('stake-reward-unit');
  var reported = document.getElementById('stake-reward-reported-at');
  var pledgeMode = isStakePledgeEntry(reward);
  document.getElementById('stake-reward-title').textContent = reward ? (pledgeMode ? 'Update total' : 'Update pending amount') : 'New pending income';
  document.getElementById('stake-reward-name').value = reward ? reward.name : '';
  var latest = reward ? latestDebtBalanceSnapshot(reward, Date.now()) : null;
  var shown = latest ? (pledgeMode && typeof latest.total === 'number' ? latest.total : latest.amount) : null;
  document.getElementById('stake-reward-balance').value = shown !== null ? qtyUiText(String(shown), reward.assetTicker) : '';
  reported.value = debtLocalDateTimeValue(new Date());
  reported.max = reported.value;
  document.getElementById('stake-reward-note').value = '';
  document.getElementById('stake-reward-notes').value = (reward && typeof reward.notes === 'string') ? reward.notes : '';
  // Income is usually paid in the account's own asset: a new entry starts there.
  var ownerKind = String(owner.kind || 'crypto').trim().toLowerCase();
  kindInput.value = reward ? reward.assetKind : (STAKE_REWARD_KINDS.indexOf(ownerKind) !== -1 ? ownerKind : 'crypto');
  tickerInput.value = reward ? reward.assetTicker : String(owner.ticker || '').trim().toUpperCase();
  modeInput.value = pledgeMode ? 'pledge' : 'plain';
  kindInput.disabled = !!reward;
  tickerInput.disabled = !!reward;
  modeInput.disabled = !!reward;
  var list = document.getElementById('stake-reward-pledge-list');
  list.innerHTML = '';
  if (pledgeMode) {
    var choices = stakePledgeAccounts(state, reward.assetKind, reward.assetTicker);
    reward.pledge.forEach(function (row) { stakePledgeRow(list, choices, row); });
  }
  function syncAsset() {
    var ticker = String(tickerInput.value || '').trim().toUpperCase();
    unit.textContent = ticker ? ' (' + ticker + ')' : '';
    var status = hintTextTarget(document.getElementById('stake-reward-asset-status'));
    if (status) status.textContent = describeStakeRewardAsset(kindInput.value, ticker);
  }
  kindInput.onchange = syncAsset;
  tickerInput.oninput = syncAsset;
  syncAsset();
  stakeRewardSyncEarned();
  dockError('stake-reward-error', '');
  clearInvalidFields(document.getElementById('stake-reward-form'));
  var saveBtn = document.getElementById('stake-reward-save');
  if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save');
  openDialog('stake-reward-dialog');
}

// Claim / Mark paid: the received amount becomes an Income record in the
// receiving account, and the entry gets a new report for what is left
// pending. Fiat in a foreign currency needs that day's rate to the main
// currency, fetched like the record form does; a typed rate wins.
function stakeClaimLabel(dlg) {
  return (dlg && dlg.getAttribute('data-label')) || 'Claim';
}

function buildStakeRewardClaimDialog() {
  var existing = document.getElementById('stake-claim-dialog');
  if (existing) return existing;
  var dlg = document.createElement('dialog');
  dlg.id = 'stake-claim-dialog';
  dlg.setAttribute('aria-labelledby', 'stake-claim-title');
  dlg.innerHTML =
    '<div class="dialog-head"><h2 id="stake-claim-title">Claim</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="stake-claim-form" novalidate>' +
    '<p id="stake-claim-pending" class="stake-claim-pending"></p>' +
    '<label for="stake-claim-amount"><span id="stake-claim-amount-label">Amount received</span><span id="stake-claim-unit"></span>' + infoPill('The amount actually paid out. A partial payment keeps the rest pending; receiving more than the last report (it kept accruing) leaves nothing pending.') + '</label>' +
    '<input id="stake-claim-amount" type="number" min="0" step="any" required inputmode="decimal">' +
    '<label for="stake-claim-at">Received at</label><input id="stake-claim-at" type="datetime-local" required>' +
    '<div id="stake-claim-target-wrap"><label for="stake-claim-target">Paid into' + infoPill('The account that holds this asset or currency. The payment is recorded there as an Income record.') + '</label>' +
    '<select id="stake-claim-target"></select></div>' +
    '<div id="stake-claim-value-wrap"><label for="stake-claim-value">Value when received<span id="stake-claim-ccy"></span> (optional)' + infoPill('What the received amount was worth when it arrived. It becomes its cost basis. Leave it empty to record it at zero cost, like an Income record without a value.') + '</label>' +
    '<input id="stake-claim-value" type="number" min="0" step="any" inputmode="decimal"></div>' +
    '<div id="stake-claim-rate-wrap"><label for="stake-claim-rate">Exchange rate<span id="stake-claim-pair"></span> (optional)' + infoPill('Leave it empty to use the ECB rate of the payment date. Enter a rate only if that rate is unavailable or your bank used another one.') + '</label>' +
    '<input id="stake-claim-rate" type="number" min="0" step="any" inputmode="decimal"></div>' +
    '<label for="stake-claim-note">Record note (optional)</label><textarea id="stake-claim-note" maxlength="280" rows="2"></textarea>' +
    dockMarkup('stake-claim-error', 'Claim', 'stake-claim-save') + '</form>';
  document.body.appendChild(dlg);
  wireDialog('stake-claim-dialog');
  var form = document.getElementById('stake-claim-form');
  form.addEventListener('submit', function (event) {
    if (event && event.preventDefault) event.preventDefault();
    var saveBtn = form.querySelector('.t-dock button.primary');
    if (saveBtn && (saveBtn.disabled || saveBtn.classList.contains('is-busy'))) return;
    var label = stakeClaimLabel(dlg);
    function fail(message) {
      if (saveBtn) setTradeSubmitBusy(saveBtn, false, label);
      dockError('stake-claim-error', message);
    }
    dockError('stake-claim-error', '');
    if (flagMissingFields(form)) { fail(MISSING_FIELDS_MESSAGE); return; }
    var state0 = loadState();
    var owner0 = accountById(state0, dlg.getAttribute('data-owner-id') || '');
    var reward0 = owner0 ? findStakeReward(owner0, dlg.getAttribute('data-reward-id') || '') : null;
    if (!owner0 || !reward0) { fail('This pending income no longer exists. Refresh and try again.'); return; }
    var targetId = String(document.getElementById('stake-claim-target').value || '');
    var target0 = null;
    stakeRewardClaimTargets(state0, owner0, reward0).forEach(function (a) { if (a.id === targetId) target0 = a; });
    if (!target0) { fail('The receiving account no longer holds ' + reward0.assetTicker + '. Choose another one.'); return; }
    var atInput = document.getElementById('stake-claim-at').value;
    var atMs = atInput ? new Date(atInput).getTime() : NaN;
    if (!isFinite(atMs)) { fail('Enter when the payment was received.'); return; }
    if (debtReportedAtIssue(atMs, Date.now())) { fail('The payment time cannot be in the future.'); return; }
    var main = String(state0.settings.mainCurrency || '').toUpperCase();
    var ticker = String(target0.ticker || '').trim().toUpperCase();
    var rateRaw = String(document.getElementById('stake-claim-rate').value || '').trim();
    var claim = {
      amount: document.getElementById('stake-claim-amount').value,
      at: atMs,
      value: document.getElementById('stake-claim-value').value,
      note: document.getElementById('stake-claim-note').value
    };
    // Validate everything that needs no rate before any network wait.
    var dry = buildStakeRewardClaim(owner0, reward0, target0,
      Object.assign({}, claim, { fxLock: { rate: 1 } }), main);
    if (dry.error) { fail(dry.error); return; }
    var needRate = isCashKind(target0.kind) && ticker !== main;
    var date = stakeRewardClaimDate(atMs);
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
      if (needRate && !lock) {
        fail('ECB rate for ' + ticker + '/' + main + ' unavailable — enter the exchange rate.');
        return;
      }
      deferTradeSubmitWork(function () {
        // Fresh state: a slow rate fetch must not overwrite newer writes.
        var state = loadState();
        var owner = accountById(state, owner0.id);
        var reward = owner ? findStakeReward(owner, reward0.id) : null;
        var target = accountById(state, target0.id);
        if (!owner || !reward || !target) { fail('This pending income no longer exists. Refresh and try again.'); return; }
        var built = buildStakeRewardClaim(owner, reward, target, Object.assign({}, claim, { fxLock: lock }), main);
        if (built.error) { fail(built.error); return; }
        var recordIssue = validateTrade(built.trade, 1e18);
        if (recordIssue) { fail('The income record is invalid: ' + recordIssue + '.'); return; }
        var nextSnapshots = reward.balanceSnapshots.concat([built.snapshot]);
        if (!isValidStakeReward(Object.assign({}, reward, { balanceSnapshots: nextSnapshots }), owner, state.accounts)) {
          fail('The payment could not be recorded. Check the amount and time.');
          return;
        }
        reward.balanceSnapshots = nextSnapshots;
        if (!Array.isArray(state.trades)) state.trades = [];
        state.trades.push(built.trade);
        if (!saveStateGuarded(state)) { fail('Storage unavailable — nothing was saved.'); return; }
        try { tradePageByAccount[target.id] = 0; } catch (e) { /* ignore */ }
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

function openStakeRewardClaimDialog(ownerId, rewardId) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  var reward = owner ? findStakeReward(owner, rewardId) : null;
  if (!owner || !reward) return;
  var fiat = isFiatStakeReward(reward);
  var targets = stakeRewardClaimTargets(state, owner, reward);
  if (!targets.length) {
    showBanner('Add a ' + reward.assetTicker + (fiat ? ' cash' : '') + ' account first: the payment is recorded as income there.');
    return;
  }
  var dlg = buildStakeRewardClaimDialog();
  var label = fiat ? 'Mark paid' : 'Claim';
  dlg.setAttribute('data-owner-id', owner.id);
  dlg.setAttribute('data-reward-id', reward.id);
  dlg.setAttribute('data-label', label);
  var ticker = reward.assetTicker;
  var main = String(state.settings.mainCurrency || '').toUpperCase();
  var latest = latestDebtBalanceSnapshot(reward, Date.now());
  var pending = latest ? Number(latest.amount) : 0;
  document.getElementById('stake-claim-title').textContent = (fiat ? 'Payment · ' : 'Claim ') + reward.name;
  document.getElementById('stake-claim-pending').textContent = (isStakePledgeEntry(reward) ? 'Earned: ' : 'Pending: ') +
    formatDebtPositionAmount(pending, reward) +
    (latest && typeof latest.pledged === 'number' && latest.pledged > 0 ? ' · the ' + formatDebtPositionAmount(latest.pledged, reward) + ' pledge stays' : '') +
    (latest ? ' · reported ' + new Date(latest.reportedAt).toLocaleString() : '');
  document.getElementById('stake-claim-amount-label').textContent = fiat ? 'Amount paid' : 'Amount claimed';
  document.getElementById('stake-claim-unit').textContent = ' (' + ticker + ')';
  document.getElementById('stake-claim-ccy').textContent = main ? ' (' + main + ')' : '';
  document.getElementById('stake-claim-pair').textContent = ' (1 ' + ticker + ' in ' + main + ')';
  document.getElementById('stake-claim-amount').value = pending > 0 ? qtyUiText(String(pending), ticker) : '';
  var at = document.getElementById('stake-claim-at');
  at.value = debtLocalDateTimeValue(new Date());
  at.max = at.value;
  document.getElementById('stake-claim-value').value = '';
  document.getElementById('stake-claim-rate').value = '';
  document.getElementById('stake-claim-note').value = '';
  // Cash records carry their own value (the amount); only foreign fiat
  // needs a rate.
  document.getElementById('stake-claim-value-wrap').hidden = fiat;
  document.getElementById('stake-claim-rate-wrap').hidden = !fiat || ticker === main;
  var select = document.getElementById('stake-claim-target');
  select.innerHTML = '';
  targets.forEach(function (account) {
    var option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name + ' · ' + String(account.ticker || '').toUpperCase();
    select.appendChild(option);
  });
  select.value = targets[0].id;
  // Paid in the account's own asset: the payment lands in that account.
  document.getElementById('stake-claim-target-wrap').hidden = targets.length === 1 && targets[0].id === owner.id;
  dockError('stake-claim-error', '');
  clearInvalidFields(document.getElementById('stake-claim-form'));
  var saveBtn = document.getElementById('stake-claim-save');
  if (saveBtn) setTradeSubmitBusy(saveBtn, false, label);
  openDialog('stake-claim-dialog');
}

// Correcting a report rewrites that one snapshot in place (same id and
// enteredAt), exactly like a debt report. A reward keeps at least one.
function buildStakeRewardSnapshotDialog() {
  var existing = document.getElementById('stake-snapshot-dialog');
  if (existing) return existing;
  var dlg = document.createElement('dialog');
  dlg.id = 'stake-snapshot-dialog';
  dlg.setAttribute('aria-labelledby', 'stake-snapshot-title');
  dlg.innerHTML =
    '<div class="dialog-head"><h2 id="stake-snapshot-title">Edit pending amount</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="stake-snapshot-form" novalidate>' +
    '<label for="stake-snapshot-amount"><span id="stake-snapshot-label">Pending amount</span><span id="stake-snapshot-unit"></span>' + infoPill('This corrects the selected entry. The other reports stay. Income records already saved are not changed.') + '</label>' +
    '<input id="stake-snapshot-amount" type="number" min="0" step="any" required inputmode="decimal">' +
    '<label for="stake-snapshot-reported-at">Balance reported at</label>' +
    '<input id="stake-snapshot-reported-at" type="datetime-local" required>' +
    '<label for="stake-snapshot-note">Snapshot note (optional)</label>' +
    '<textarea id="stake-snapshot-note" maxlength="280" rows="2"></textarea>' +
    dockMarkup('stake-snapshot-error', 'Save changes', 'stake-snapshot-save') + '</form>';
  document.body.appendChild(dlg);
  wireDialog('stake-snapshot-dialog');
  var form = document.getElementById('stake-snapshot-form');
  form.addEventListener('submit', function (event) {
    if (event && event.preventDefault) event.preventDefault();
    var saveBtn = form.querySelector('.t-dock button.primary');
    if (saveBtn && (saveBtn.disabled || saveBtn.classList.contains('is-busy'))) return;
    function fail(message) {
      if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save changes');
      dockError('stake-snapshot-error', message);
    }
    dockError('stake-snapshot-error', '');
    if (flagMissingFields(form)) { fail(MISSING_FIELDS_MESSAGE); return; }
    var state = loadState();
    var owner = accountById(state, dlg.getAttribute('data-owner-id') || '');
    var reward = owner ? findStakeReward(owner, dlg.getAttribute('data-reward-id') || '') : null;
    if (!owner || !reward) { fail('This pending income no longer exists. Refresh and try again.'); return; }
    var snapshotId = dlg.getAttribute('data-snapshot-id') || '';
    var index = -1;
    for (var i = 0; i < reward.balanceSnapshots.length; i++) {
      if (reward.balanceSnapshots[i].id === snapshotId) { index = i; break; }
    }
    if (index === -1) { fail('This report no longer exists. Refresh and try again.'); return; }
    var amountRaw = String(document.getElementById('stake-snapshot-amount').value || '').trim();
    var amount = Number(amountRaw);
    var reportedInput = document.getElementById('stake-snapshot-reported-at').value;
    var note = String(document.getElementById('stake-snapshot-note').value || '').trim();
    if (!isFinite(amount) || amount < 0) { fail('Enter a valid pending amount (0 or more).'); return; }
    if (qtyOverPrecise(amountRaw, reward.assetTicker)) { fail(qtyPrecisionError(reward.assetTicker)); return; }
    if (!reportedInput) { fail('Enter when the balance was reported.'); return; }
    var reportedDate = new Date(reportedInput);
    var reportedIssue = debtReportedAtIssue(reportedDate.getTime(), Date.now());
    if (reportedIssue) { fail(reportedIssue); return; }
    var previous = reward.balanceSnapshots[index];
    var sameTime = reportedInput === (dlg.getAttribute('data-reported-local') || '');
    var edited = {
      id: previous.id,
      amount: amount,
      reportedAt: sameTime ? previous.reportedAt : reportedDate.toISOString(),
      enteredAt: previous.enteredAt
    };
    // A pledge report is corrected by its total; the pledge in force then
    // stays, and the earned part follows.
    if (isStakePledgeEntry(reward)) {
      var pledgedThen = typeof previous.pledged === 'number' ? previous.pledged : stakePledgeSum(reward.pledge, reward.assetTicker);
      edited.total = amount;
      edited.pledged = pledgedThen;
      edited.amount = stakePledgeEarned(amountRaw, pledgedThen, reward.assetTicker);
    }
    if (note) edited.note = note;
    reward.balanceSnapshots[index] = edited;
    if (!isValidStakeReward(reward, owner, state.accounts)) { fail('The report is invalid. Check the amount and timestamp.'); return; }
    setTradeSubmitBusy(saveBtn, true, 'Saving…');
    deferTradeSubmitWork(function () {
      if (!saveStateGuarded(state)) { fail('Storage unavailable — the report was not saved.'); return; }
      setTradeSubmitBusy(saveBtn, false, 'Save changes');
      closeDialog(dlg);
      clearBanner();
      render();
    });
  });
  return dlg;
}

function openStakeRewardSnapshotDialog(ownerId, rewardId, snapshotId) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  var reward = owner ? findStakeReward(owner, rewardId) : null;
  if (!reward) return;
  var snapshot = null;
  reward.balanceSnapshots.forEach(function (s) { if (s.id === snapshotId) snapshot = s; });
  if (!snapshot) return;
  var dlg = buildStakeRewardSnapshotDialog();
  dlg.setAttribute('data-owner-id', owner.id);
  dlg.setAttribute('data-reward-id', reward.id);
  dlg.setAttribute('data-snapshot-id', snapshot.id);
  document.getElementById('stake-snapshot-unit').textContent = ' (' + reward.assetTicker + ')';
  var pledgeReport = isStakePledgeEntry(reward) && typeof snapshot.total === 'number';
  document.getElementById('stake-snapshot-label').textContent = pledgeReport ? 'Total the payer showed' : 'Pending amount';
  document.getElementById('stake-snapshot-amount').value = qtyUiText(String(pledgeReport ? snapshot.total : snapshot.amount), reward.assetTicker);
  var reported = document.getElementById('stake-snapshot-reported-at');
  reported.value = debtLocalDateTimeValue(new Date(snapshot.reportedAt));
  dlg.setAttribute('data-reported-local', reported.value);
  document.getElementById('stake-snapshot-note').value = (typeof snapshot.note === 'string') ? snapshot.note : '';
  dockError('stake-snapshot-error', '');
  clearInvalidFields(document.getElementById('stake-snapshot-form'));
  var saveBtn = document.getElementById('stake-snapshot-save');
  if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save changes');
  openDialog('stake-snapshot-dialog');
}

function removeStakeRewardSnapshot(ownerId, rewardId, snapshotId) {
  var state = loadState();
  var reward = findStakeReward(accountById(state, ownerId), rewardId);
  if (!reward || reward.balanceSnapshots.length < 2) return;
  var snapshot = null;
  reward.balanceSnapshots.forEach(function (s) { if (s.id === snapshotId) snapshot = s; });
  if (!snapshot) return;
  confirmAction('Remove report', 'Remove the ' + formatDebtPositionAmount(snapshot.amount, reward) + ' report from ' +
    new Date(snapshot.reportedAt).toLocaleString() + '? The other reports stay; income records already saved are not changed.', 'Remove', true).then(function (ok) {
    if (!ok) return;
    var fresh = loadState();
    var freshReward = findStakeReward(accountById(fresh, ownerId), rewardId);
    if (!freshReward || freshReward.balanceSnapshots.length < 2) return;
    var kept = freshReward.balanceSnapshots.filter(function (s) { return s.id !== snapshotId; });
    if (kept.length === freshReward.balanceSnapshots.length) return;
    freshReward.balanceSnapshots = kept;
    if (!isValidStakeReward(freshReward, accountById(fresh, ownerId), fresh.accounts) || !saveStateGuarded(fresh)) return;
    clearBanner();
    render();
  });
}

function removeStakeReward(ownerId, rewardId) {
  var state = loadState();
  var reward = findStakeReward(accountById(state, ownerId), rewardId);
  if (!reward) return;
  confirmAction('Remove pending income', 'Permanently remove "' + reward.name + '" and its history? Income records already saved stay.', 'Remove', true).then(function (ok) {
    if (!ok) return;
    var fresh = loadState();
    var owner = accountById(fresh, ownerId);
    if (!owner) return;
    owner.stakeRewards = accountStakeRewards(owner).filter(function (r) { return r.id !== rewardId; });
    if (!owner.stakeRewards.length) delete owner.stakeRewards;
    if (!saveStateGuarded(fresh)) return;
    render();
    try { refreshPrices(); } catch (e) { /* ignore */ }
  });
}

function stakeRewardButton(className, text, label, onClick) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  if (label) button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

// Account view section, placed after the debt positions, on every account
// (the entry point lives with its list).
function buildStakeRewardsSection(st, account, members, host, after) {
  var scope = [account].concat(members || []);
  var canAdd = stakeRewardsAllowedOn(account);
  var totalCount = scope.reduce(function (count, owner) { return count + accountStakeRewards(owner).length; }, 0);
  if (!canAdd && !totalCount) return null;
  var section = document.createElement('section');
  section.className = 'debt-positions-section stake-rewards-section';
  var header = document.createElement('div');
  header.className = 'section-head debt-section-head';
  var details = debtPanel(document.createElement('details'), 'rewards:' + account.id);
  details.className = 'debt-positions-details';
  var summary = document.createElement('summary');
  var title = document.createElement('span');
  title.className = 'section-title';
  title.textContent = 'Pending income';
  summary.appendChild(title);
  var count = document.createElement('span');
  count.className = 'debt-position-count';
  count.textContent = String(totalCount);
  summary.appendChild(count);
  details.appendChild(summary);
  header.appendChild(details);
  if (canAdd) {
    header.appendChild(stakeRewardButton('ghost', '+ Pending', 'Add pending income to ' + account.name,
      function () { openStakeRewardDialog(account.id, null); }));
  }
  section.appendChild(header);
  var body = document.createElement('div');
  body.className = 'debt-position-list';
  var mainCur = String(st.settings.mainCurrency || '').trim().toUpperCase();
  scope.forEach(function (owner) {
    var rewards = accountStakeRewards(owner);
    if (!rewards.length) return;
    if (scope.length > 1) {
      var ownerTitle = document.createElement('p');
      ownerTitle.className = 'debt-owner-title';
      ownerTitle.textContent = owner.name + ' · ' + String(owner.ticker || '').toUpperCase();
      body.appendChild(ownerTitle);
    }
    rewards.forEach(function (reward) {
      var item = document.createElement('article');
      item.className = 'debt-position-card stake-reward-card';
      var top = document.createElement('div');
      top.className = 'debt-position-top';
      var nameEl = document.createElement('strong');
      nameEl.textContent = reward.name;
      top.appendChild(nameEl);
      var actions = document.createElement('div');
      actions.className = 'stake-reward-actions';
      var fiatEntry = isFiatStakeReward(reward);
      actions.appendChild(stakeRewardButton('debt-position-update stake-reward-claim', fiatEntry ? 'Mark paid' : 'Claim',
        (fiatEntry ? 'Mark paid: ' : 'Claim ') + reward.name,
        function () { openStakeRewardClaimDialog(owner.id, reward.id); }));
      actions.appendChild(stakeRewardButton('debt-position-update', isStakePledgeEntry(reward) ? 'Update total' : 'Update amount', (isStakePledgeEntry(reward) ? 'Update the total of ' : 'Update the pending amount of ') + reward.name,
        function () { openStakeRewardDialog(owner.id, reward.id); }));
      top.appendChild(actions);
      item.appendChild(top);
      // As of now, like the totals: a future-dated report never shows as current.
      var latest = latestDebtBalanceSnapshot(reward, Date.now());
      var amount = document.createElement('p');
      amount.className = 'debt-position-amount';
      var pledgeEntry = isStakePledgeEntry(reward);
      var text = latest ? formatDebtPositionAmount(latest.amount, reward) + (pledgeEntry ? ' earned' : '') : 'No reported balance';
      var val = latest ? debtPositionValuation(reward, mainCur, livePrices, null, owner) : null;
      var inMain = isCashKind(reward.assetKind) && reward.assetTicker === mainCur;
      if (val && val.known && val.value !== null && latest.amount > 0 && !inMain) text += ' (≈ ' + fmtMoney(val.value, mainCur) + ')';
      amount.textContent = text;
      amount.title = text;
      item.appendChild(amount);
      var reported = document.createElement('p');
      reported.className = 'debt-position-reported';
      reported.textContent = latest ? 'Pending · last reported ' + new Date(latest.reportedAt).toLocaleString() : 'No report recorded';
      item.appendChild(reported);
      // Pledge: what the payer shows, and where the pledge sits (it stays in
      // those accounts' holdings).
      if (pledgeEntry) {
        if (latest && typeof latest.total === 'number') {
          var totals = document.createElement('p');
          totals.className = 'debt-position-reported';
          totals.textContent = 'Payer shows ' + formatDebtPositionAmount(latest.total, reward) +
            ' · ' + formatDebtPositionAmount(latest.pledged, reward) + ' pledged';
          item.appendChild(totals);
        }
        var sources = document.createElement('p');
        sources.className = 'debt-position-collateral';
        sources.textContent = reward.pledge.length
          ? 'Pledged from: ' + reward.pledge.map(function (row) {
            var source = accountById(st, row.accountId);
            return (source ? source.name : 'Missing account') + ' · ' + formatDebtPositionAmount(row.quantity, reward);
          }).join(', ')
          : 'Nothing pledged now';
        item.appendChild(sources);
      }
      if (reward.assetTicker !== String(owner.ticker || '').trim().toUpperCase()) {
        var paid = document.createElement('p');
        paid.className = 'debt-position-reported';
        paid.textContent = 'Paid in ' + reward.assetTicker + ', not ' + String(owner.ticker || '').toUpperCase();
        item.appendChild(paid);
      }
      if (typeof reward.notes === 'string' && reward.notes !== '') {
        var notesEl = document.createElement('p');
        notesEl.className = 'debt-position-notes';
        notesEl.textContent = reward.notes;
        item.appendChild(notesEl);
      }
      var history = debtPanel(document.createElement('details'), 'reward-history:' + reward.id);
      history.className = 'debt-snapshot-history';
      var historySummary = document.createElement('summary');
      historySummary.textContent = 'History (' + reward.balanceSnapshots.length + ')';
      history.appendChild(historySummary);
      var list = document.createElement('ol');
      // Newest first; equal times (a claim in the same minute as a report)
      // keep entry order reversed, so the claim shows above the report.
      reward.balanceSnapshots.map(function (snapshot, index) { return { s: snapshot, i: index }; }).sort(function (a, b) {
        return (Date.parse(b.s.reportedAt) - Date.parse(a.s.reportedAt)) || (b.i - a.i);
      }).map(function (entry) { return entry.s; }).forEach(function (snapshot) {
        var li = document.createElement('li');
        li.className = 'debt-snapshot-item';
        var row = document.createElement('div');
        row.className = 'debt-snapshot-row';
        var snapBody = document.createElement('div');
        snapBody.className = 'debt-snapshot-body';
        var label = document.createElement('strong');
        label.textContent = formatDebtPositionAmount(snapshot.amount, reward) + (typeof snapshot.total === 'number' ? ' earned' : '');
        snapBody.appendChild(label);
        var when = document.createElement('span');
        when.textContent = new Date(snapshot.reportedAt).toLocaleString();
        snapBody.appendChild(when);
        if (typeof snapshot.total === 'number') {
          var split = document.createElement('span');
          split.textContent = 'Total ' + formatDebtPositionAmount(snapshot.total, reward) + ' · pledged ' + formatDebtPositionAmount(snapshot.pledged, reward);
          snapBody.appendChild(split);
        }
        if (snapshot.note) {
          var memo = document.createElement('p');
          memo.textContent = snapshot.note;
          snapBody.appendChild(memo);
        }
        row.appendChild(snapBody);
        var snapActions = document.createElement('div');
        snapActions.className = 'debt-snapshot-actions';
        snapActions.appendChild(stakeRewardButton('debt-snapshot-edit', 'Edit', 'Edit the ' + label.textContent + ' report from ' + when.textContent,
          function () { openStakeRewardSnapshotDialog(owner.id, reward.id, snapshot.id); }));
        if (reward.balanceSnapshots.length > 1) {
          snapActions.appendChild(stakeRewardButton('debt-snapshot-delete', 'Delete', 'Delete the ' + label.textContent + ' report from ' + when.textContent,
            function () { removeStakeRewardSnapshot(owner.id, reward.id, snapshot.id); }));
        }
        row.appendChild(snapActions);
        li.appendChild(row);
        list.appendChild(li);
      });
      history.appendChild(list);
      item.appendChild(history);
      item.appendChild(stakeRewardButton('debt-position-delete', 'Remove', 'Remove ' + reward.name,
        function () { removeStakeReward(owner.id, reward.id); }));
      body.appendChild(item);
    });
  });
  if (!totalCount) {
    var empty = document.createElement('p');
    empty.className = 'muted debt-empty';
    empty.textContent = 'No pending income recorded for this account.';
    body.appendChild(empty);
  }
  details.appendChild(body);
  section.appendChild(details);
  if (after && after.parentNode === host) host.insertBefore(section, after.nextSibling);
  else host.appendChild(section);
  return section;
}
