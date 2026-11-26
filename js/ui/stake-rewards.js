'use strict';
// Stake rewards UI: pending totals reported by the protocol, no yield math.
// Shares the debt UI's building blocks (js/ui/debt.js): reported-time check,
// datetime field values, denomination hints and remembered <details> state.
// Claim is the one action debt has no equivalent of: it records the claimed
// tokens as an Income record and lowers the pending balance in one save.

function stakeRewardKindOptions() {
  return '<option value="crypto">Crypto</option><option value="stock">Stock</option>' +
    '<option value="commodity">Commodity</option><option value="custom">Custom</option>';
}

function describeStakeRewardAsset(kind, ticker) {
  if (!String(ticker || '').trim()) return 'Choose the token the rewards are paid in.';
  return describeDebtAsset(kind, ticker);
}

function buildStakeRewardDialog() {
  var existing = document.getElementById('stake-reward-dialog');
  if (existing) return existing;
  var dlg = document.createElement('dialog');
  dlg.id = 'stake-reward-dialog';
  dlg.setAttribute('aria-labelledby', 'stake-reward-title');
  dlg.innerHTML =
    '<div class="dialog-head"><h2 id="stake-reward-title">Stake reward</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="stake-reward-form" novalidate>' +
    '<label for="stake-reward-name">Reward name</label><input id="stake-reward-name" maxlength="120" required autocomplete="off" placeholder="e.g. Validator rewards">' +
    '<label>Paid in' + infoPill('Choose the token the rewards are paid in.', 'stake-reward-asset-status') + '</label><div class="debt-asset-fields">' +
    '<select id="stake-reward-asset-kind" aria-label="Reward asset type">' + stakeRewardKindOptions() + '</select>' +
    '<input id="stake-reward-asset-ticker" maxlength="12" pattern="[A-Za-z0-9._-]{1,12}" required autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Ticker, e.g. ETH" aria-label="Ticker"></div>' +
    '<label for="stake-reward-balance">Unclaimed balance<span id="stake-reward-unit"></span>' + infoPill('Enter the total unclaimed rewards the protocol currently shows. Plutus keeps this exact amount, and counts it in your net worth, until you report a new one or claim.') + '</label>' +
    '<input id="stake-reward-balance" type="number" min="0" step="any" required inputmode="decimal">' +
    '<label for="stake-reward-reported-at">Balance reported at</label><input id="stake-reward-reported-at" type="datetime-local" required>' +
    '<label for="stake-reward-note">Snapshot note (optional)</label><textarea id="stake-reward-note" maxlength="280" rows="2"></textarea>' +
    '<label for="stake-reward-notes">Reward notes (optional)</label><textarea id="stake-reward-notes" maxlength="280" rows="2"></textarea>' +
    dockMarkup('stake-reward-error', 'Save unclaimed balance', 'stake-reward-save') + '</form>';
  document.body.appendChild(dlg);
  wireDialog('stake-reward-dialog');
  var form = document.getElementById('stake-reward-form');
  form.addEventListener('submit', function (event) {
    if (event && event.preventDefault) event.preventDefault();
    var saveBtn = form.querySelector('.t-dock button.primary');
    if (saveBtn && (saveBtn.disabled || saveBtn.classList.contains('is-busy'))) return;
    function fail(message) {
      if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save unclaimed balance');
      dockError('stake-reward-error', message);
    }
    dockError('stake-reward-error', '');
    if (flagMissingFields(form)) { fail(MISSING_FIELDS_MESSAGE); return; }
    var state = loadState();
    var owner = accountById(state, dlg.getAttribute('data-owner-id') || '');
    if (!owner) { fail('The staking account no longer exists.'); return; }
    var rewardId = dlg.getAttribute('data-reward-id') || '';
    var reward = rewardId ? findStakeReward(owner, rewardId) : null;
    if (rewardId && !reward) { fail('This stake reward no longer exists. Refresh and try again.'); return; }
    var name = String(document.getElementById('stake-reward-name').value || '').trim();
    var assetKind = reward ? reward.assetKind : String(document.getElementById('stake-reward-asset-kind').value || '').trim().toLowerCase();
    var assetTicker = reward ? reward.assetTicker : String(document.getElementById('stake-reward-asset-ticker').value || '').trim().toUpperCase();
    if (STAKE_REWARD_KINDS.indexOf(assetKind) === -1 || !/^[A-Z0-9._-]{1,12}$/.test(assetTicker)) {
      fail('Choose a supported asset type and enter a valid ticker.'); return;
    }
    var amountRaw = String(document.getElementById('stake-reward-balance').value || '').trim();
    var amount = Number(amountRaw);
    var reportedInput = document.getElementById('stake-reward-reported-at').value;
    var note = String(document.getElementById('stake-reward-note').value || '').trim();
    var notes = String(document.getElementById('stake-reward-notes').value || '').trim();
    if (!name || name.length > 120) { fail('Enter a reward name (up to 120 characters).'); return; }
    if (!isFinite(amount) || amount < 0) { fail('Enter a valid unclaimed balance (0 or more).'); return; }
    if (qtyOverPrecise(amountRaw, assetTicker)) { fail(qtyPrecisionError(assetTicker)); return; }
    var reportedDate = new Date(reportedInput);
    var reportedIssue = reportedInput ? debtReportedAtIssue(reportedDate.getTime(), Date.now()) : 'Enter when the balance was reported.';
    if (reportedIssue) { fail(reportedIssue); return; }
    if (notes.length > 280) { fail('Reward notes can be up to 280 characters.'); return; }
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
    var snapshot = { id: uid(), amount: amount, reportedAt: reportedDate.toISOString(), enteredAt: now };
    if (note) snapshot.note = note;
    next.balanceSnapshots.push(snapshot);
    if (!isValidStakeReward(next)) { fail('The stake reward is invalid. Check the balance and timestamp.'); return; }
    setTradeSubmitBusy(saveBtn, true, 'Saving…');
    deferTradeSubmitWork(function () {
      if (!Array.isArray(owner.stakeRewards)) owner.stakeRewards = [];
      if (reward) owner.stakeRewards = owner.stakeRewards.map(function (r) { return r.id === reward.id ? next : r; });
      else owner.stakeRewards.push(next);
      if (!saveStateGuarded(state)) { fail('Storage unavailable — the stake reward was not saved.'); return; }
      setTradeSubmitBusy(saveBtn, false, 'Save unclaimed balance');
      closeDialog(dlg);
      clearBanner();
      render();
      try { refreshPrices(); } catch (e) { /* ignore */ }
    });
  });
  return dlg;
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
  var unit = document.getElementById('stake-reward-unit');
  var reported = document.getElementById('stake-reward-reported-at');
  document.getElementById('stake-reward-title').textContent = reward ? 'Update unclaimed rewards' : 'New stake reward';
  document.getElementById('stake-reward-name').value = reward ? reward.name : '';
  var latest = reward ? latestDebtBalanceSnapshot(reward, Date.now()) : null;
  document.getElementById('stake-reward-balance').value = latest ? qtyUiText(String(latest.amount), reward.assetTicker) : '';
  reported.value = debtLocalDateTimeValue(new Date());
  reported.max = reported.value;
  document.getElementById('stake-reward-note').value = '';
  document.getElementById('stake-reward-notes').value = (reward && typeof reward.notes === 'string') ? reward.notes : '';
  // Rewards are usually paid in the staked asset: a new reward starts there.
  var ownerKind = String(owner.kind || 'crypto').trim().toLowerCase();
  kindInput.value = reward ? reward.assetKind : (STAKE_REWARD_KINDS.indexOf(ownerKind) !== -1 ? ownerKind : 'crypto');
  tickerInput.value = reward ? reward.assetTicker : String(owner.ticker || '').trim().toUpperCase();
  kindInput.disabled = !!reward;
  tickerInput.disabled = !!reward;
  function syncAsset() {
    var ticker = String(tickerInput.value || '').trim().toUpperCase();
    unit.textContent = ticker ? ' (' + ticker + ')' : '';
    var status = hintTextTarget(document.getElementById('stake-reward-asset-status'));
    if (status) status.textContent = describeStakeRewardAsset(kindInput.value, ticker);
  }
  kindInput.onchange = syncAsset;
  tickerInput.oninput = syncAsset;
  syncAsset();
  dockError('stake-reward-error', '');
  clearInvalidFields(document.getElementById('stake-reward-form'));
  var saveBtn = document.getElementById('stake-reward-save');
  if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Save unclaimed balance');
  openDialog('stake-reward-dialog');
}

// Claim: the claimed tokens become an Income record in the receiving
// account, and the reward gets a new report for what is left pending.
function buildStakeRewardClaimDialog() {
  var existing = document.getElementById('stake-claim-dialog');
  if (existing) return existing;
  var dlg = document.createElement('dialog');
  dlg.id = 'stake-claim-dialog';
  dlg.setAttribute('aria-labelledby', 'stake-claim-title');
  dlg.innerHTML =
    '<div class="dialog-head"><h2 id="stake-claim-title">Claim stake reward</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="stake-claim-form" novalidate>' +
    '<p id="stake-claim-pending" class="stake-claim-pending"></p>' +
    '<label for="stake-claim-amount">Claimed amount<span id="stake-claim-unit"></span>' + infoPill('The amount the protocol paid out. A partial claim keeps the rest pending; claiming more than the last report (rewards kept accruing) leaves nothing pending.') + '</label>' +
    '<input id="stake-claim-amount" type="number" min="0" step="any" required inputmode="decimal">' +
    '<label for="stake-claim-at">Claimed at</label><input id="stake-claim-at" type="datetime-local" required>' +
    '<div id="stake-claim-target-wrap"><label for="stake-claim-target">Paid into' + infoPill('The account that holds the reward token. The claim is recorded there as an Income record.') + '</label>' +
    '<select id="stake-claim-target"></select></div>' +
    '<label for="stake-claim-value">Value at claim<span id="stake-claim-ccy"></span> (optional)' + infoPill('What the claimed tokens were worth when you claimed them. It becomes their cost basis. Leave it empty to record them at zero cost, like an Income record without a value.') + '</label>' +
    '<input id="stake-claim-value" type="number" min="0" step="any" inputmode="decimal">' +
    '<label for="stake-claim-note">Record note (optional)</label><textarea id="stake-claim-note" maxlength="280" rows="2"></textarea>' +
    dockMarkup('stake-claim-error', 'Claim', 'stake-claim-save') + '</form>';
  document.body.appendChild(dlg);
  wireDialog('stake-claim-dialog');
  var form = document.getElementById('stake-claim-form');
  form.addEventListener('submit', function (event) {
    if (event && event.preventDefault) event.preventDefault();
    var saveBtn = form.querySelector('.t-dock button.primary');
    if (saveBtn && (saveBtn.disabled || saveBtn.classList.contains('is-busy'))) return;
    function fail(message) {
      if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Claim');
      dockError('stake-claim-error', message);
    }
    dockError('stake-claim-error', '');
    if (flagMissingFields(form)) { fail(MISSING_FIELDS_MESSAGE); return; }
    var state = loadState();
    var owner = accountById(state, dlg.getAttribute('data-owner-id') || '');
    var reward = owner ? findStakeReward(owner, dlg.getAttribute('data-reward-id') || '') : null;
    if (!owner || !reward) { fail('This stake reward no longer exists. Refresh and try again.'); return; }
    var targetId = String(document.getElementById('stake-claim-target').value || '');
    var target = null;
    stakeRewardClaimTargets(state, owner, reward).forEach(function (a) { if (a.id === targetId) target = a; });
    if (!target) { fail('The receiving account no longer holds ' + reward.assetTicker + '. Choose another one.'); return; }
    var atInput = document.getElementById('stake-claim-at').value;
    var atMs = atInput ? new Date(atInput).getTime() : NaN;
    if (!isFinite(atMs)) { fail('Enter when the reward was claimed.'); return; }
    if (debtReportedAtIssue(atMs, Date.now())) { fail('The claim time cannot be in the future.'); return; }
    var built = buildStakeRewardClaim(owner, reward, target, {
      amount: document.getElementById('stake-claim-amount').value,
      at: atMs,
      value: document.getElementById('stake-claim-value').value,
      note: document.getElementById('stake-claim-note').value
    }, state.settings.mainCurrency);
    if (built.error) { fail(built.error); return; }
    var recordIssue = validateTrade(built.trade, 1e18);
    if (recordIssue) { fail('The claim record is invalid: ' + recordIssue + '.'); return; }
    var nextSnapshots = reward.balanceSnapshots.concat([built.snapshot]);
    var nextReward = Object.assign({}, reward, { balanceSnapshots: nextSnapshots });
    if (!isValidStakeReward(nextReward)) { fail('The claim could not be recorded. Check the amount and time.'); return; }
    setTradeSubmitBusy(saveBtn, true, 'Saving…');
    deferTradeSubmitWork(function () {
      reward.balanceSnapshots = nextSnapshots;
      if (!Array.isArray(state.trades)) state.trades = [];
      state.trades.push(built.trade);
      if (!saveStateGuarded(state)) { fail('Storage unavailable — the claim was not saved.'); return; }
      try { tradePageByAccount[target.id] = 0; } catch (e) { /* ignore */ }
      setTradeSubmitBusy(saveBtn, false, 'Claim');
      closeDialog(dlg);
      clearBanner();
      render();
      try { refreshPrices(); } catch (e) { /* ignore */ }
    });
  });
  return dlg;
}

function openStakeRewardClaimDialog(ownerId, rewardId) {
  var state = loadState();
  var owner = accountById(state, ownerId);
  var reward = owner ? findStakeReward(owner, rewardId) : null;
  if (!owner || !reward) return;
  var targets = stakeRewardClaimTargets(state, owner, reward);
  if (!targets.length) {
    showBanner('Add a ' + reward.assetTicker + ' account first: claimed rewards are recorded as income there.');
    return;
  }
  var dlg = buildStakeRewardClaimDialog();
  dlg.setAttribute('data-owner-id', owner.id);
  dlg.setAttribute('data-reward-id', reward.id);
  var ticker = reward.assetTicker;
  var main = String(state.settings.mainCurrency || '').toUpperCase();
  var latest = latestDebtBalanceSnapshot(reward, Date.now());
  var pending = latest ? Number(latest.amount) : 0;
  document.getElementById('stake-claim-title').textContent = 'Claim ' + reward.name;
  document.getElementById('stake-claim-pending').textContent = 'Unclaimed: ' + formatDebtPositionAmount(pending, reward) +
    (latest ? ' · reported ' + new Date(latest.reportedAt).toLocaleString() : '');
  document.getElementById('stake-claim-unit').textContent = ' (' + ticker + ')';
  document.getElementById('stake-claim-ccy').textContent = main ? ' (' + main + ')' : '';
  document.getElementById('stake-claim-amount').value = pending > 0 ? qtyUiText(String(pending), ticker) : '';
  var at = document.getElementById('stake-claim-at');
  at.value = debtLocalDateTimeValue(new Date());
  at.max = at.value;
  document.getElementById('stake-claim-value').value = '';
  document.getElementById('stake-claim-note').value = '';
  var select = document.getElementById('stake-claim-target');
  select.innerHTML = '';
  targets.forEach(function (account) {
    var option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name + ' · ' + String(account.ticker || '').toUpperCase();
    select.appendChild(option);
  });
  select.value = targets[0].id;
  // Paid in the staked asset: the claim lands in the staking account itself.
  document.getElementById('stake-claim-target-wrap').hidden = targets.length === 1 && targets[0].id === owner.id;
  dockError('stake-claim-error', '');
  clearInvalidFields(document.getElementById('stake-claim-form'));
  var saveBtn = document.getElementById('stake-claim-save');
  if (saveBtn) setTradeSubmitBusy(saveBtn, false, 'Claim');
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
    '<div class="dialog-head"><h2 id="stake-snapshot-title">Edit unclaimed balance</h2>' +
    '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
    '<form id="stake-snapshot-form" novalidate>' +
    '<label for="stake-snapshot-amount">Unclaimed balance<span id="stake-snapshot-unit"></span>' + infoPill('This corrects the selected entry. The reward keeps its other reports. Income records of past claims are not changed.') + '</label>' +
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
    if (!owner || !reward) { fail('This stake reward no longer exists. Refresh and try again.'); return; }
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
    if (!isFinite(amount) || amount < 0) { fail('Enter a valid unclaimed balance (0 or more).'); return; }
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
    if (note) edited.note = note;
    reward.balanceSnapshots[index] = edited;
    if (!isValidStakeReward(reward)) { fail('The report is invalid. Check the amount and timestamp.'); return; }
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
  document.getElementById('stake-snapshot-amount').value = qtyUiText(String(snapshot.amount), reward.assetTicker);
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
    new Date(snapshot.reportedAt).toLocaleString() + '? The reward keeps its other reports; income records of past claims are not changed.', 'Remove', true).then(function (ok) {
    if (!ok) return;
    var fresh = loadState();
    var freshReward = findStakeReward(accountById(fresh, ownerId), rewardId);
    if (!freshReward || freshReward.balanceSnapshots.length < 2) return;
    var kept = freshReward.balanceSnapshots.filter(function (s) { return s.id !== snapshotId; });
    if (kept.length === freshReward.balanceSnapshots.length) return;
    freshReward.balanceSnapshots = kept;
    if (!isValidStakeReward(freshReward) || !saveStateGuarded(fresh)) return;
    clearBanner();
    render();
  });
}

function removeStakeReward(ownerId, rewardId) {
  var state = loadState();
  var reward = findStakeReward(accountById(state, ownerId), rewardId);
  if (!reward) return;
  confirmAction('Remove stake reward', 'Permanently remove "' + reward.name + '" and its unclaimed balance history? Income records of past claims stay.', 'Remove', true).then(function (ok) {
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

// Account view section, placed after the debt positions. Shown on every
// asset account (the entry point lives with its list) and wherever a group
// member already carries rewards.
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
  title.textContent = 'Stake rewards';
  summary.appendChild(title);
  var count = document.createElement('span');
  count.className = 'debt-position-count';
  count.textContent = String(totalCount);
  summary.appendChild(count);
  details.appendChild(summary);
  header.appendChild(details);
  if (canAdd) {
    header.appendChild(stakeRewardButton('ghost', '+ Reward', 'Add stake reward to ' + account.name,
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
      actions.appendChild(stakeRewardButton('debt-position-update stake-reward-claim', 'Claim', 'Claim ' + reward.name,
        function () { openStakeRewardClaimDialog(owner.id, reward.id); }));
      actions.appendChild(stakeRewardButton('debt-position-update', 'Update balance', 'Update the unclaimed balance of ' + reward.name,
        function () { openStakeRewardDialog(owner.id, reward.id); }));
      top.appendChild(actions);
      item.appendChild(top);
      // As of now, like the totals: a future-dated report never shows as current.
      var latest = latestDebtBalanceSnapshot(reward, Date.now());
      var amount = document.createElement('p');
      amount.className = 'debt-position-amount';
      var text = latest ? formatDebtPositionAmount(latest.amount, reward) : 'No reported balance';
      var val = latest ? debtPositionValuation(reward, mainCur, livePrices, null, owner) : null;
      if (val && val.known && val.value !== null && latest.amount > 0) text += ' (≈ ' + fmtMoney(val.value, mainCur) + ')';
      amount.textContent = text;
      amount.title = text;
      item.appendChild(amount);
      var reported = document.createElement('p');
      reported.className = 'debt-position-reported';
      reported.textContent = latest ? 'Unclaimed · last reported ' + new Date(latest.reportedAt).toLocaleString() : 'No report recorded';
      item.appendChild(reported);
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
      historySummary.textContent = 'Unclaimed history (' + reward.balanceSnapshots.length + ')';
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
        label.textContent = formatDebtPositionAmount(snapshot.amount, reward);
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
      item.appendChild(stakeRewardButton('debt-position-delete', 'Remove reward', 'Remove ' + reward.name,
        function () { removeStakeReward(owner.id, reward.id); }));
      body.appendChild(item);
    });
  });
  if (!totalCount) {
    var empty = document.createElement('p');
    empty.className = 'muted debt-empty';
    empty.textContent = 'No stake rewards recorded for this account.';
    body.appendChild(empty);
  }
  details.appendChild(body);
  section.appendChild(details);
  if (after && after.parentNode === host) host.insertBefore(section, after.nextSibling);
  else host.appendChild(section);
  return section;
}
