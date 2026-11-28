#!/usr/bin/env node
'use strict';
// Lendings: pending income entries with `lent: true`. The principal stays in
// the owning account's records; net worth adds only the interest, and the
// Available balance leaves the whole outstanding total out. Repayment pays
// interest first (Income record for that part); a write-off forgives
// interest first and books a lost principal as an Expense record.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const src = require('./app-source').appSource();
const noop = () => {};
function createApp() {
  const store = new Map();
  const C = {
    console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
    navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
    fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
    requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
    history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
  };
  C.window = C; C.self = C; C.globalThis = C;
  vm.createContext(C);
  vm.runInContext(src, C, { filename: 'app-scripts.js' });
  return C;
}
const C = createApp();
const acc = (id, ticker, kind, extra) => Object.assign({ id, name: id, ticker, kind, createdAt: '2026-01-01T00:00:00.000Z' }, extra || {});
const report = (id, principal, total, reportedAt, note) => ({
  id, amount: Math.max(0, Math.round((total - principal) * 1e8) / 1e8), total, pledged: principal,
  reportedAt, enteredAt: reportedAt, note
});
const lending = (owner, extra) => Object.assign({
  id: 'loan', name: 'Loan to Alex', assetKind: owner.kind, assetTicker: owner.ticker, createdAt: '2026-11-01T10:00:00.000Z',
  lent: true, borrower: 'Alex', dueDate: '2027-03-01',
  pledge: [{ accountId: owner.id, quantity: 1000 }],
  balanceSnapshots: [report('l1', 1000, 1000, '2026-11-01T10:00:00.000Z'), report('l2', 1000, 1050, '2026-11-20T10:00:00.000Z', 'Interest so far')]
}, extra || {});

// --- Validation ---
const eur = acc('eur', 'EUR', 'cash');
const other = acc('other', 'EUR', 'cash');
const accounts = [eur, other];
assert.equal(C.isValidStakeReward(lending(eur), eur, accounts), true);
assert.equal(C.isStakeLendingEntry(lending(eur)), true);
assert.equal(C.isStakePledgeEntry(lending(eur)), true, 'a lending is a pledge entry underneath');
assert.equal(C.isValidStakeReward(lending(eur, { borrower: undefined, dueDate: undefined }), eur, accounts), true, 'borrower and due date are optional');
assert.equal(C.isValidStakeReward(lending(eur, { pledge: [] }), eur, accounts), true, 'a repaid principal leaves no pledge row');
for (const [bad, why] of [
  [lending(eur, { assetKind: 'crypto', assetTicker: 'ETH' }), 'only the account own asset can be lent'],
  [lending(eur, { assetTicker: 'USD' }), 'not another currency either'],
  [lending(eur, { pledge: [{ accountId: 'other', quantity: 1000 }] }), 'the principal comes from the owning account'],
  [lending(eur, { pledge: undefined, balanceSnapshots: [{ id: 'x', amount: 5, reportedAt: '2026-11-01T10:00:00.000Z', enteredAt: '2026-11-01T10:00:00.000Z' }] }), 'a lending is always a pledge entry'],
  [lending(eur, { lent: 'yes' }), 'lent is a strict flag'],
  [lending(eur, { borrower: ' ' }), 'an empty borrower is not stored'],
  [lending(eur, { borrower: 'x'.repeat(121) }), 'borrower is capped'],
  [lending(eur, { dueDate: '2027-02-30' }), 'due dates are real dates'],
  [lending(eur, { lent: undefined, pledge: [{ accountId: 'eur', quantity: 1000 }] }), 'borrower and due date belong to lendings']
]) {
  assert.equal(C.isValidStakeReward(bad, eur, accounts), false, why);
}

// --- Normalization and storage keep the lending fields ---
eur.stakeRewards = [lending(eur)];
const norm = C.normalizeAccount(eur, accounts).stakeRewards[0];
assert.equal(norm.lent, true);
assert.equal(norm.borrower, 'Alex');
assert.equal(norm.dueDate, '2027-03-01');
assert.equal(norm.balanceSnapshots[1].pledged, 1000);
const exported = JSON.parse(C.exportState({ settings: { mainCurrency: 'EUR', costMethod: 'average', assetLedgers: true, dateFormat: 'DD/MM/YYYY' }, accounts, trades: [], priceOverrides: {} }));
assert.deepEqual(Object.keys(exported), ['app', 'version', 'exportedAt', 'settings', 'accounts', 'trades', 'priceOverrides']);
const imported = C.importState(JSON.stringify(exported));
assert.equal(imported.accounts[0].stakeRewards[0].lent, true, 'import keeps the lending');

// --- Parts and due state ---
const parts = C.lendingParts(lending(eur));
assert.equal(parts.principal, 1000);
assert.equal(parts.interest, 50);
assert.equal(parts.total, 1050);
assert.equal(C.lendingDueState(lending(eur), '2027-01-10'), 'due');
assert.equal(C.lendingDueState(lending(eur), '2027-03-02'), 'overdue');
assert.equal(C.lendingDueState(lending(eur, { dueDate: undefined }), '2027-03-02'), '');

// --- Valuation: net worth adds the interest, lent out is the whole total ---
const at = Date.parse('2026-11-21T00:00:00.000Z');
assert.equal(C.currentStakeRewardValuation([eur], 'EUR', {}, at).value, 50, 'net worth adds only the interest (principal is in the records)');
const lent = C.currentLentOutValuation([eur], 'EUR', {}, at);
assert.equal(lent.hasLent, true);
assert.equal(lent.value, 1050, 'available leaves principal + interest out');
assert.equal(C.currentLentOutValuation([eur], 'EUR', {}, Date.parse('2026-10-01T00:00:00.000Z')).hasLent, false, 'nothing lent before the first report');
const ethAcc = acc('eth', 'ETH', 'crypto', { stakeRewards: [lending({ id: 'eth', kind: 'crypto', ticker: 'ETH' }, {
  pledge: [{ accountId: 'eth', quantity: 1 }],
  balanceSnapshots: [report('e1', 1, 1.05, '2026-11-01T10:00:00.000Z')]
})] });
assert.equal(C.currentLentOutValuation([ethAcc], 'EUR', { ETH: 2000 }, at).value, 2100);
assert.equal(C.currentLentOutValuation([ethAcc], 'EUR', {}, at).value, null, 'unknown price: unknown, never 0');
// Interest owed is not in the wallet: the account quantity does not add it.
assert.equal(C.stakeRewardOwnAssetPending([ethAcc], 'ETH', 'crypto', at).amount, 0);
// A settled lending is no longer lent out.
const settled = lending(eur, { pledge: [], balanceSnapshots: [report('s1', 0, 0, '2026-11-01T10:00:00.000Z')] });
assert.equal(C.currentLentOutValuation([acc('s', 'EUR', 'cash', { stakeRewards: [settled] })], 'EUR', {}, at).hasLent, false);
assert.equal(C.lendingDueState(settled, '2027-03-02'), '', 'a settled lending is never overdue');

// --- Repayment: interest first ---
const payAt = Date.parse('2026-11-25T09:00:00.000Z');
const partial = C.buildLendingRepayment(eur, lending(eur), { amount: '30', at: payAt }, 'EUR');
assert.equal(partial.error, undefined);
assert.equal(partial.interest, 30);
assert.equal(partial.principal, 0);
assert.equal(partial.trade.type, 'income', 'the interest part is income');
assert.equal(partial.trade.qty, 30);
assert.equal(partial.trade.accountId, 'eur');
assert.equal(partial.snapshot.pledged, 1000);
assert.equal(partial.snapshot.amount, 20);
assert.equal(partial.snapshot.total, 1020);
assert.deepEqual(JSON.parse(JSON.stringify(partial.pledge)), [{ accountId: 'eur', quantity: 1000 }]);
assert.equal(C.isValidStakeRewardSnapshot(partial.snapshot), true);

const mixed = C.buildLendingRepayment(eur, lending(eur), { amount: '450.5', at: payAt }, 'EUR');
assert.equal(mixed.interest, 50);
assert.equal(mixed.principal, 400.5);
assert.equal(mixed.trade.qty, 50, 'only the interest becomes a record');
assert.equal(mixed.snapshot.pledged, 599.5);
assert.equal(mixed.snapshot.amount, 0);
assert.equal(mixed.snapshot.total, 599.5);
assert.match(mixed.snapshot.note, /400\.5.*principal.*50.*interest/);

const full = C.buildLendingRepayment(eur, lending(eur), { amount: '1050', at: payAt }, 'EUR');
assert.equal(full.snapshot.total, 0);
assert.equal(full.pledge.length, 0, 'fully repaid: nothing lent any more');

const over = C.buildLendingRepayment(eur, lending(eur), { amount: '1060', at: payAt }, 'EUR');
assert.equal(over.interest, 60, 'paying more than the last report counts the excess as interest');
assert.equal(over.principal, 1000);

const principalOnly = C.buildLendingRepayment(eur, lending(eur, { balanceSnapshots: [report('p', 1000, 1000, '2026-11-01T10:00:00.000Z')] }), { amount: '250', at: payAt }, 'EUR');
assert.equal(principalOnly.trade, null, 'no interest: no record (the principal never left the records)');
assert.equal(principalOnly.snapshot.pledged, 750);

assert.match(C.buildLendingRepayment(eur, lending(eur), { amount: '0', at: payAt }, 'EUR').error, /more than 0/);
assert.match(C.buildLendingRepayment(eur, lending(eur), { amount: '5', at: Date.now() + 3 * 864e5 }, 'EUR').error, /future/);
assert.match(C.buildLendingRepayment(eur, lending(eur), { amount: '5.123456789', at: payAt }, 'EUR').error, /decimal|precision|places/i);

// Foreign fiat: the income record needs the rate to the main currency.
const usd = acc('usd', 'USD', 'cash');
const usdLoan = lending(usd, { pledge: [{ accountId: 'usd', quantity: 1000 }] });
assert.match(C.buildLendingRepayment(usd, usdLoan, { amount: '50', at: payAt }, 'EUR').error, /rate/);
const usdPaid = C.buildLendingRepayment(usd, usdLoan, { amount: '50', at: payAt, fxLock: { pair: 'USD/EUR', rate: 0.9, source: 'manual', interpolated: false } }, 'EUR');
assert.equal(usdPaid.trade.currency, 'USD');
assert.equal(usdPaid.trade.fxLock.rate, 0.9);

// --- Write-off: forgiven interest first, lost principal is an expense ---
const forgive = C.buildLendingWriteOff(eur, lending(eur), { amount: '50', at: payAt }, 'EUR');
assert.equal(forgive.trade, null, 'forgiving interest writes no record: it was never held');
assert.equal(forgive.snapshot.total, 1000);
assert.equal(forgive.snapshot.pledged, 1000);

const lost = C.buildLendingWriteOff(eur, lending(eur), { amount: '1050', at: payAt }, 'EUR');
assert.equal(lost.trade.type, 'expense');
assert.equal(lost.trade.qty, 1000, 'the lost principal leaves the account');
assert.equal(lost.trade.total, 1000);
assert.equal(lost.trade.currency, 'EUR');
assert.equal(lost.trade.accountId, 'eur');
assert.equal(lost.snapshot.total, 0);
assert.equal(lost.pledge.length, 0);
assert.equal(C.validateTrade(lost.trade, 1e18), null, 'the expense is a valid record');
assert.match(C.buildLendingWriteOff(eur, lending(eur), { amount: '1051', at: payAt }, 'EUR').error, /at most what is owed/);

const ethLoan = ethAcc.stakeRewards[0];
const ethLost = C.buildLendingWriteOff(ethAcc, ethLoan, { amount: '0.55', at: payAt }, 'EUR');
assert.equal(ethLost.trade.qty, 0.5, 'interest 0.05 forgiven first, then 0.5 ETH principal lost');
assert.equal(ethLost.trade.total, 0, 'asset expenses carry the quantity, valued at the spend-date quote');
assert.equal(ethLost.trade.currency, 'EUR');
assert.equal(C.isCryptoQtyExpense(ethLost.trade), true);
assert.equal(ethLost.snapshot.pledged, 0.5);
assert.equal(ethLost.snapshot.total, 0.5);
assert.equal(C.validateTrade(ethLost.trade, 1e18), null);

// --- Principal out of the account's own asset (what the account view takes off) ---
const outEur = C.lendingPrincipalOut([eur], 'EUR', 'cash', at);
assert.equal(outEur.amount, 1000, 'principal only: interest owed was never in the account');
assert.equal(outEur.entries.length, 1);
assert.equal(C.lendingPrincipalOut([eur], 'EUR', 'cash', Date.parse('2026-10-01T00:00:00.000Z')).amount, 0, 'nothing out before the first report');
assert.equal(C.lendingPrincipalOut([eur], 'USD', 'cash', at).amount, 0, 'another asset is untouched');
assert.equal(C.lendingPrincipalOut([ethAcc], 'ETH', 'crypto', at).amount, 1);
const cashShown = C.cashAvailableAfterLending({ native: 5000, main: 5000, ticker: 'EUR' }, [eur], eur, at);
assert.equal(cashShown.native, 4000, 'the bank shows 5,000 - 1,000 lent');
assert.equal(cashShown.main, 4000);
assert.equal(cashShown.lent, 1000);
const usdShown = C.cashAvailableAfterLending({ native: 2000, main: 1800, ticker: 'USD' }, [usd, ], usd, at);
assert.equal(usdShown.native, 2000, 'no lending on this account: unchanged');

console.log('lendings: ok');
