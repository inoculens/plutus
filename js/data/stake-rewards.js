'use strict';
// Pending income ("Pending income" in the UI; stored as account.stakeRewards,
// the name it was introduced under): income earned but not received yet.
// Unclaimed stake rewards, interest accrued on a deposit or on supplied
// collateral, invoices a client owes, dividends declared but not paid.
// Same reported-balance model as debt positions (js/data/debt.js): the
// payer shows a pending total, Plutus keeps it as a snapshot and never
// derives yield between reports. Pending income is an asset: it adds to
// net worth, where a debt position subtracts.
//
// An entry is denominated in what it pays out, which may differ from the
// account's own asset (stake an LP token, earn CRV). One source that pays
// several assets is recorded as one entry per asset. Fiat entries are paid
// into a cash account in that currency.

var STAKE_REWARD_KINDS = ['crypto', 'stock', 'commodity', 'custom', 'cash'];

function accountStakeRewards(account) {
  return (account && Array.isArray(account.stakeRewards)) ? account.stakeRewards : [];
}

// Every reported-balance entry of an account (debt positions and stake
// rewards): for code that only needs their denominations, e.g. which live
// and historical prices to fetch.
function accountBalancePositions(account) {
  return accountDebtPositions(account).concat(accountStakeRewards(account));
}

// Every account can carry pending income: assets for rewards and accrued
// yield, cash accounts for interest, receivables and declared dividends.
function stakeRewardsAllowedOn(account) {
  return !!account;
}

function isFiatStakeReward(reward) {
  return !!reward && isCashKind(reward.assetKind);
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
  // Fiat is paid as a cash record in that currency, so it must be a code a
  // record can carry.
  if (isCashKind(reward.assetKind) && !isValidCurrencyCode(reward.assetTicker)) return false;
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
// Assets: `value` is the optional value of the claimed amount in the main
// currency (its cost basis); empty records it at zero cost, like an Income
// record saved without a value.
// Fiat: the record matches a cash Income record from the record form: the
// amount is the value, in the account's own currency, and claim.fxLock is
// that currency's rate to the main currency on the claim date (callers
// fetch it; 1:1 when the currency is the main one).
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
  var fiat = isCashKind(target.kind);
  var value = claim.value === null || claim.value === undefined || String(claim.value).trim() === '' ? 0 : Number(claim.value);
  if (!fiat && (!isFinite(value) || value < 0)) return { error: 'The value at claim must be 0 or more.' };
  var lock = { pair: mainU + '/' + mainU, rate: 1, source: '1:1', interpolated: false };
  if (fiat) {
    if (ticker === mainU) lock = { pair: ticker + '/' + mainU, rate: 1, source: '1:1', interpolated: false };
    else if (claim.fxLock && isFinite(Number(claim.fxLock.rate)) && Number(claim.fxLock.rate) > 0) lock = claim.fxLock;
    else return { error: 'No ' + ticker + '/' + mainU + ' rate for that date — enter the exchange rate.' };
  }
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
    total: fiat ? qty : value,
    currency: fiat ? ticker : mainU,
    date: date,
    fee: 0,
    feeCurrency: fiat ? ticker : mainU,
    note: note || ((fiat ? 'Paid · ' : 'Claimed · ') + reward.name),
    fxLock: lock,
    accountId: target.id,
    createdAt: now
  };
  var claimedText = qtyUiText(String(qty), ticker) || String(qty);
  var snapshot = {
    id: uid(),
    amount: remaining,
    reportedAt: new Date(at).toISOString(),
    enteredAt: now,
    note: ((fiat ? 'Paid ' : 'Claimed ') + claimedText + ' ' + ticker + (target.id !== owner.id ? ' into ' + target.name : '')).slice(0, 280)
  };
  return { trade: trade, snapshot: snapshot, remaining: remaining };
}
