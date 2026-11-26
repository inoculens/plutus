'use strict';
// Stake rewards: rewards a stake has earned but the owner has not claimed yet.
// Same reported-balance model as debt positions (js/data/debt.js): the
// protocol shows a pending total, Plutus keeps it as a snapshot and never
// derives yield between reports. A pending reward is an asset: it adds to
// net worth, where a debt position subtracts.
//
// A reward is denominated in the token it pays out, which may differ from
// the staked asset (stake an LP token, earn CRV). One stake that pays
// several tokens is recorded as one reward per token. Fiat payouts are
// interest, not stake rewards: they are recorded as income on a cash account.

var STAKE_REWARD_KINDS = ['crypto', 'stock', 'commodity', 'custom'];

function accountStakeRewards(account) {
  return (account && Array.isArray(account.stakeRewards)) ? account.stakeRewards : [];
}

// Every reported-balance entry of an account (debt positions and stake
// rewards): for code that only needs their denominations, e.g. which live
// and historical prices to fetch.
function accountBalancePositions(account) {
  return accountDebtPositions(account).concat(accountStakeRewards(account));
}

// A stake account can pay its rewards out in its own asset only.
function stakeRewardsAllowedOn(account) {
  return !!account && !isCashKind(account.kind);
}

function isValidStakeReward(reward) {
  if (!reward || typeof reward !== 'object' || Array.isArray(reward)) return false;
  var allowed = Object.assign(Object.create(null), { id: true, name: true, assetKind: true, assetTicker: true, createdAt: true, balanceSnapshots: true, notes: true });
  if (Object.keys(reward).some(function (key) { return !allowed[key]; })) return false;
  if (!isValidDebtId(reward.id) || typeof reward.name !== 'string' ||
      reward.name.trim() === '' || reward.name.length > 120 ||
      !isValidDebtTimestamp(reward.createdAt)) return false;
  if (typeof reward.assetKind !== 'string' || typeof reward.assetTicker !== 'string') return false;
  if (STAKE_REWARD_KINDS.indexOf(reward.assetKind.trim().toLowerCase()) === -1) return false;
  if (!/^[A-Z0-9._-]{1,12}$/.test(reward.assetTicker.trim().toUpperCase())) return false;
  if (!isValidBalanceSnapshotList(reward.balanceSnapshots)) return false;
  if (reward.notes !== undefined && reward.notes !== null &&
      (typeof reward.notes !== 'string' || reward.notes.length > 280)) return false;
  return true;
}

function isValidStakeRewards(account) {
  if (!account || typeof account !== 'object') return false;
  if (account.stakeRewards === undefined || account.stakeRewards === null) return true;
  if (!Array.isArray(account.stakeRewards) || account.stakeRewards.length > 500) return false;
  var ids = Object.create(null);
  for (var i = 0; i < account.stakeRewards.length; i++) {
    var reward = account.stakeRewards[i];
    if (!isValidStakeReward(reward) || ids[reward.id]) return false;
    ids[reward.id] = true;
  }
  return true;
}

function normalizeStakeReward(reward) {
  var out = {
    id: reward.id,
    name: reward.name.trim(),
    assetKind: reward.assetKind.trim().toLowerCase(),
    assetTicker: reward.assetTicker.trim().toUpperCase(),
    createdAt: reward.createdAt,
    balanceSnapshots: normalizeBalanceSnapshots(reward.balanceSnapshots)
  };
  if (typeof reward.notes === 'string' && reward.notes !== '') out.notes = reward.notes;
  return out;
}

function findStakeReward(account, rewardId) {
  var found = null;
  accountStakeRewards(account).forEach(function (reward) { if (reward.id === rewardId) found = reward; });
  return found;
}

// Accounts a claim can be paid into: same ticker and kind as the reward.
// The owning account comes first, then its group (main and sub-accounts),
// then every other matching account in list order.
function stakeRewardClaimTargets(st, owner, reward) {
  if (!st || !owner || !reward) return [];
  var ticker = String(reward.assetTicker || '').trim().toUpperCase();
  var kind = String(reward.assetKind || '').trim().toLowerCase();
  function matches(account) {
    if (!account || !account.id) return false;
    var accountKind = String(account.kind || 'crypto').trim().toLowerCase();
    return String(account.ticker || '').trim().toUpperCase() === ticker && accountKind === kind;
  }
  var mainAccount = groupMainOf(st, owner.id) || owner;
  var family = [owner, mainAccount].concat(groupMembers(st, mainAccount.id));
  var out = [];
  var seen = Object.create(null);
  function add(account) {
    if (!matches(account) || seen[account.id]) return;
    seen[account.id] = true;
    out.push(account);
  }
  family.forEach(add);
  (st.accounts || []).forEach(add);
  return out;
}

// What is left pending after claiming `claimed` out of `pending`, exact at
// the token's precision. Claiming more than the last report (rewards kept
// accruing since) leaves nothing pending, never a negative balance.
function stakeRewardRemainder(pending, claimed, ticker) {
  var dec = qtyDecimals(ticker);
  var p = exactScaledOf(Number(pending) > 0 ? pending : 0, dec);
  var c = exactScaledOf(claimed, dec);
  if (p === null || c === null) return null;
  var left = p - c;
  if (left <= 0n) return 0;
  return Number(exactToStringTrim(left, dec));
}

// Local calendar date (YYYY-MM-DD) of a claim timestamp: income records are
// dated by the owner's calendar, exactly like the record form's date field.
function stakeRewardClaimDate(ms) {
  var d = new Date(ms);
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

// The two writes of one claim, built together so they are saved together:
// an income record in the receiving account and a new pending report on
// the reward. Returns { trade, snapshot } or { error }.
// `value` is the optional value of the claimed tokens in the main currency
// (their cost basis); null records them at zero cost, like an Income record
// saved without a value.
function buildStakeRewardClaim(owner, reward, target, claim, main) {
  if (!owner || !reward) return { error: 'This stake reward no longer exists. Refresh and try again.' };
  if (!target) return { error: 'Choose the account that received the claimed tokens.' };
  var ticker = String(target.ticker || '').trim().toUpperCase();
  var mainU = String(main || '').trim().toUpperCase();
  var at = Number(claim.at);
  if (!isFinite(at)) return { error: 'Enter when the reward was claimed.' };
  var date = stakeRewardClaimDate(at);
  if (!isValidDateStr(date) || isFutureDateStr(date)) return { error: 'The claim time cannot be in the future.' };
  var raw = String(claim.amount === undefined || claim.amount === null ? '' : claim.amount).trim();
  if (qtyOverPrecise(raw, ticker)) return { error: qtyPrecisionError(ticker) };
  var qty = exactQtyValue(raw, ticker);
  if (!(Number(qty) > 0)) return { error: 'Enter the claimed amount (more than 0).' };
  var value = claim.value === null || claim.value === undefined || String(claim.value).trim() === '' ? 0 : Number(claim.value);
  if (!isFinite(value) || value < 0) return { error: 'The value at claim must be 0 or more.' };
  var pendingSnapshot = latestDebtBalanceSnapshot(reward, at);
  var pending = pendingSnapshot ? Number(pendingSnapshot.amount) : 0;
  var remaining = stakeRewardRemainder(pending, raw, ticker);
  if (remaining === null) return { error: 'Enter the claimed amount (more than 0).' };
  var now = new Date().toISOString();
  var note = String(claim.note || '').trim();
  var trade = {
    id: uid(),
    type: 'income',
    symbol: ticker,
    qty: qty,
    total: value,
    currency: mainU,
    date: date,
    fee: 0,
    feeCurrency: mainU,
    note: note || ('Stake reward claim · ' + reward.name),
    fxLock: { pair: mainU + '/' + mainU, rate: 1, source: '1:1', interpolated: false },
    accountId: target.id,
    createdAt: now
  };
  var claimedText = qtyUiText(String(qty), ticker) || String(qty);
  var snapshot = {
    id: uid(),
    amount: remaining,
    reportedAt: new Date(at).toISOString(),
    enteredAt: now,
    note: ('Claimed ' + claimedText + ' ' + ticker + (target.id !== owner.id ? ' into ' + target.name : '')).slice(0, 280)
  };
  return { trade: trade, snapshot: snapshot, remaining: remaining };
}
