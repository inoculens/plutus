'use strict';
// Lendings: money lent out of an account that is still yours (a loan to a
// person, a locked deposit). Stored as a pending income entry with
// `lent: true` (see js/data/stake-rewards.js), so reports, history, backup
// and sync are shared with pending income.
//
// Nothing moves the principal when the lending is created: it stays in the
// account's records. Each report keeps the principal outstanding
// (`pledged`), the total the borrower owes (`total`) and the interest earned
// (`amount` = total - principal, what net worth adds). Only real outcomes
// write records:
// - Repayment: interest is paid first; the interest part becomes an Income
//   record in the owning account, the principal part needs none (it never
//   left the records) and simply stops being lent out.
// - Write-off: forgiven interest goes first and needs no record (it was
//   never held); a lost principal becomes an Expense record in the owning
//   account, because that money is gone.

// The outstanding split of a lending as of `asOf` (ms), exact at the asset's
// precision: { principal, interest, total, snapshot } as Numbers.
function lendingParts(entry, asOf) {
  var snapshot = latestDebtBalanceSnapshot(entry, asOf === undefined || asOf === null ? Date.now() : asOf);
  if (!snapshot) return { principal: 0, interest: 0, total: 0, snapshot: null };
  var principal = typeof snapshot.pledged === 'number' ? snapshot.pledged : stakePledgeSum(entry.pledge, entry.assetTicker);
  var interest = Number(snapshot.amount) > 0 ? Number(snapshot.amount) : 0;
  var dec = qtyDecimals(entry.assetTicker);
  var pSc = exactScaledOf(principal, dec);
  var iSc = exactScaledOf(interest, dec);
  var total = (pSc !== null && iSc !== null) ? Number(exactToStringTrim(pSc + iSc, dec)) : principal + interest;
  return { principal: principal, interest: interest, total: total, snapshot: snapshot };
}

function lendingIsSettled(entry, asOf) {
  return !(lendingParts(entry, asOf).total > 0);
}

// 'overdue' once the due date has passed with something still owed, 'due'
// while it is ahead, '' without a due date or once settled. `today` is a
// local YYYY-MM-DD (the due date is a calendar date, like record dates).
function lendingDueState(entry, today) {
  if (!entry || typeof entry.dueDate !== 'string' || !entry.dueDate) return '';
  if (lendingIsSettled(entry)) return '';
  return String(today || '') > entry.dueDate ? 'overdue' : 'due';
}

// The pledge rows for a principal: the owning account, or none once repaid.
function lendingPledgeFor(owner, principal) {
  return Number(principal) > 0 ? [{ accountId: owner.id, quantity: Number(principal) }] : [];
}

function lendingQtyText(value, ticker) {
  return qtyUiText(String(value), ticker) || String(value);
}

// Shared by repayment and write-off: validates the typed amount and splits
// it, interest first. Returns { error } or
// { at, date, dec, parts, amountSc, interestSc, principalSc, principalLeft, interestLeft }.
function lendingSplit(entry, input, verb) {
  var ticker = String(entry.assetTicker || '').trim().toUpperCase();
  var at = Number(input.at);
  if (!isFinite(at)) return { error: 'Enter when it was ' + verb + '.' };
  var date = stakeRewardClaimDate(at);
  if (!isValidDateStr(date) || isFutureDateStr(date)) return { error: 'The time cannot be in the future.' };
  var raw = String(input.amount === undefined || input.amount === null ? '' : input.amount).trim();
  if (qtyOverPrecise(raw, ticker)) return { error: qtyPrecisionError(ticker) };
  var dec = qtyDecimals(ticker);
  var amountSc = raw === '' ? null : exactScaledOf(raw, dec);
  if (amountSc === null || amountSc <= 0n) return { error: 'Enter the amount (more than 0).' };
  var parts = lendingParts(entry, at);
  var pSc = exactScaledOf(parts.principal, dec);
  var iSc = exactScaledOf(parts.interest, dec);
  if (pSc === null || iSc === null) return { error: 'This lending has no valid report before that time.' };
  var interestSc = amountSc < iSc ? amountSc : iSc;
  var rest = amountSc - interestSc;
  var principalSc = rest < pSc ? rest : pSc;
  return {
    at: at, date: date, dec: dec, ticker: ticker, parts: parts, amountSc: amountSc,
    interestSc: interestSc, principalSc: principalSc, excessSc: rest - principalSc,
    principalLeft: pSc - principalSc, interestLeft: iSc - interestSc
  };
}

function lendingNextSnapshot(split, note) {
  var dec = split.dec;
  var snapshot = {
    id: uid(),
    amount: Number(exactToStringTrim(split.interestLeft, dec)),
    total: Number(exactToStringTrim(split.principalLeft + split.interestLeft, dec)),
    pledged: Number(exactToStringTrim(split.principalLeft, dec)),
    reportedAt: new Date(split.at).toISOString(),
    enteredAt: new Date().toISOString()
  };
  if (note) snapshot.note = String(note).slice(0, 280);
  return snapshot;
}

// Repayment: { amount, at, value, note, fxLock } like a pending income claim
// (value = worth of the interest part in the main currency, assets only;
// fxLock = the fiat's rate to the main currency on that date). Paying more
// than the last report counts the excess as interest (it kept accruing).
// Returns { trade (null without interest), snapshot, pledge, interest,
// principal } or { error }.
function buildLendingRepayment(owner, entry, input, main) {
  if (!owner || !isStakeLendingEntry(entry)) return { error: 'This lending no longer exists. Refresh and try again.' };
  var split = lendingSplit(entry, input, 'repaid');
  if (split.error) return split;
  var dec = split.dec;
  var interestPaidSc = split.interestSc + split.excessSc;
  var interestText = exactToStringTrim(interestPaidSc, dec);
  var principalText = exactToStringTrim(split.principalSc, dec);
  var trade = null;
  if (interestPaidSc > 0n) {
    var claim = buildStakeRewardClaim(owner, entry, owner, {
      amount: interestText,
      at: split.at,
      value: input.value,
      note: String(input.note || '').trim() || ('Interest · ' + entry.name),
      fxLock: input.fxLock
    }, main);
    if (claim.error) return { error: claim.error };
    trade = claim.trade;
  }
  var t = split.ticker;
  var note = 'Repaid ' + lendingQtyText(exactToStringTrim(split.amountSc, dec), t) + ' ' + t +
    (interestPaidSc > 0n && split.principalSc > 0n
      ? ' (' + lendingQtyText(principalText, t) + ' principal, ' + lendingQtyText(interestText, t) + ' interest)'
      : (interestPaidSc > 0n ? ' (interest)' : ' (principal)'));
  var snapshot = lendingNextSnapshot(split, note);
  return {
    trade: trade,
    snapshot: snapshot,
    pledge: lendingPledgeFor(owner, snapshot.pledged),
    interest: Number(interestText),
    principal: Number(principalText)
  };
}

// Write-off: { amount, at, note, fxLock }. Cannot exceed what is owed.
// Returns { trade (null when only interest is forgiven), snapshot, pledge,
// interest, principal } or { error }. The expense is in the owning account:
// cash carries its amount in its own currency (fxLock to the main one),
// assets carry the quantity (valued at the spend-date quote, like any asset
// expense).
function buildLendingWriteOff(owner, entry, input, main) {
  if (!owner || !isStakeLendingEntry(entry)) return { error: 'This lending no longer exists. Refresh and try again.' };
  var split = lendingSplit(entry, input, 'written off');
  if (split.error) return split;
  var dec = split.dec;
  var t = split.ticker;
  if (split.excessSc > 0n) {
    return { error: 'You can write off at most what is owed: ' + lendingQtyText(split.parts.total, t) + ' ' + t + '.' };
  }
  var principalText = exactToStringTrim(split.principalSc, dec);
  var interestText = exactToStringTrim(split.interestSc, dec);
  var mainU = String(main || '').trim().toUpperCase();
  var fiat = isCashKind(owner.kind);
  var trade = null;
  if (split.principalSc > 0n) {
    var lock = { pair: mainU + '/' + mainU, rate: 1, source: '1:1', interpolated: false };
    if (fiat && t !== mainU) {
      if (input.fxLock && isFinite(Number(input.fxLock.rate)) && Number(input.fxLock.rate) > 0) lock = input.fxLock;
      else return { error: 'No ' + t + '/' + mainU + ' rate for that date — enter the exchange rate.' };
    } else if (fiat) {
      lock = { pair: t + '/' + mainU, rate: 1, source: '1:1', interpolated: false };
    }
    var qty = exactQtyValue(principalText, t);
    var currency = fiat ? t : mainU;
    trade = {
      id: uid(),
      type: 'expense',
      symbol: t,
      qty: qty,
      total: fiat ? qty : 0,
      currency: currency,
      date: split.date,
      fee: 0,
      feeCurrency: currency,
      note: String(input.note || '').trim() || ('Written off · ' + entry.name),
      fxLock: lock,
      accountId: owner.id,
      createdAt: new Date().toISOString()
    };
  }
  var note = 'Wrote off ' + lendingQtyText(exactToStringTrim(split.amountSc, dec), t) + ' ' + t +
    (split.interestSc > 0n && split.principalSc > 0n
      ? ' (' + lendingQtyText(principalText, t) + ' principal, ' + lendingQtyText(interestText, t) + ' interest)'
      : (split.interestSc > 0n ? ' (interest)' : ' (principal)'));
  var snapshot = lendingNextSnapshot(split, note);
  return {
    trade: trade,
    snapshot: snapshot,
    pledge: lendingPledgeFor(owner, snapshot.pledged),
    interest: Number(interestText),
    principal: Number(principalText)
  };
}

// Principal lent out of `accounts` in their own asset (`ticker` + `kind`),
// as of `asOf`, exact: { scaled (BigInt at the asset's precision), amount,
// entries: [{ owner, entry, principal }] }. The account view takes it off
// the quantity and value it shows, so they match the wallet or bank (the
// records still hold it: it is still yours).
function lendingPrincipalOut(accounts, ticker, kind, asOf) {
  var t = String(ticker || '').trim().toUpperCase();
  var k = String(kind || 'crypto').trim().toLowerCase();
  var dec = qtyDecimals(t);
  var sum = 0n;
  var entries = [];
  (accounts || []).forEach(function (owner) {
    accountStakeRewards(owner).forEach(function (entry) {
      if (!isStakeLendingEntry(entry)) return;
      if (String(entry.assetTicker || '').toUpperCase() !== t || String(entry.assetKind || '').toLowerCase() !== k) return;
      var principal = lendingParts(entry, asOf).principal;
      var sc = exactScaledOf(principal, dec);
      if (sc === null || sc <= 0n) return;
      sum += sc;
      entries.push({ owner: owner, entry: entry, principal: principal });
    });
  });
  return { scaled: sum, amount: Number(exactToStringTrim(sum, dec)), entries: entries };
}
