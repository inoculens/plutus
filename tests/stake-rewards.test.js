#!/usr/bin/env node
'use strict';
// Stake rewards are pending reported balances (the debt snapshot model with
// the opposite sign). This test covers validation, normalization, storage
// recovery, import/export, claim targets and the claim's two writes.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const src = require('./app-source').appSource();
const noop = () => {};
const KEY = 'inoculens.v2';
function createApp(initial) {
  const store = new Map(Object.entries(initial || {}));
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
  return { C, store };
}
const acc = (id, ticker, kind, extra) => Object.assign({ id, name: id, ticker, kind, createdAt: '2026-01-01T00:00:00.000Z' }, extra || {});
const snap = (id, amount, reportedAt, note) => ({ id, amount, reportedAt, enteredAt: '2026-11-10T12:01:00.000Z', note });
const reward = (extra) => Object.assign({
  id: 'rw-1', name: 'Validator rewards', assetKind: 'crypto', assetTicker: 'ETH',
  createdAt: '2026-11-01T10:00:00.000Z',
  balanceSnapshots: [snap('r1', 0.5, '2026-11-01T10:00:00.000Z'), snap('r2', 0.75, '2026-11-10T10:00:00.000Z', 'Dashboard total')]
}, extra || {});

const { C, store } = createApp();

// --- Validation ---
const eth = acc('eth', 'ETH', 'crypto', { stakeRewards: [reward()] });
assert.equal(C.isValidStakeRewards(eth), true);
assert.equal(C.isValidStakeRewards(acc('plain', 'BTC', 'crypto')), true, 'accounts without rewards stay valid');
assert.equal(C.isValidStakeReward(reward({ assetKind: 'crypto', assetTicker: 'CRV' })), true,
  'a reward can pay out in a token other than the staked one');
for (const [bad, why] of [
  [reward({ assetKind: 'cash', assetTicker: 'USD' }), 'fiat payouts are interest, not stake rewards'],
  [reward({ assetKind: undefined }), 'the denomination is required'],
  [reward({ assetTicker: 'not a ticker' }), 'tickers follow the account ticker rule'],
  [reward({ collateral: [] }), 'rewards carry no collateral'],
  [reward({ apr: 4 }), 'no yield model is stored'],
  [reward({ toString: 'x' }), 'inherited names are not schema keys'],
  [reward({ balanceSnapshots: [] }), 'a reward keeps at least one report'],
  [reward({ balanceSnapshots: [snap('n', -1, '2026-11-01T10:00:00.000Z')] }), 'pending balances are never negative'],
  [reward({ balanceSnapshots: [snap('d', 1, '2026-11-01T10:00:00Z'), snap('d', 2, '2026-11-02T10:00:00Z')] }), 'snapshot ids are unique'],
  [reward({ name: ' ' }), 'a name is required'],
  [reward({ notes: 'x'.repeat(281) }), 'notes are capped']
]) {
  assert.equal(C.isValidStakeReward(bad), false, why);
}
assert.equal(C.isValidStakeRewards(acc('dup', 'ETH', 'crypto', { stakeRewards: [reward(), reward()] })), false,
  'reward ids are unique per account');
assert.equal(C.isValidStakeRewards(acc('notarray', 'ETH', 'crypto', { stakeRewards: {} })), false);
assert.equal(C.isValidStakeReward(reward({ balanceSnapshots: [snap('z', 0, '2026-11-01T10:00:00.000Z')] })), true,
  'zero pending (everything claimed) is a valid report');

// --- Normalization keeps the list on the account, chronologically ---
const messy = acc('messy', 'ETH', 'crypto', { stakeRewards: [reward({
  name: '  Lido  ', assetKind: 'Crypto', assetTicker: 'eth',
  balanceSnapshots: [snap('late', 2, '2026-11-09T10:00:00.000Z'), snap('early', 1, '2026-11-02T10:00:00.000Z')]
})] });
const normalized = C.normalizeAccount(messy, [messy]);
assert.equal(normalized.stakeRewards.length, 1);
assert.equal(normalized.stakeRewards[0].name, 'Lido');
assert.equal(normalized.stakeRewards[0].assetKind, 'crypto');
assert.equal(normalized.stakeRewards[0].assetTicker, 'ETH');
assert.deepEqual(Array.from(normalized.stakeRewards[0].balanceSnapshots, s => s.id), ['early', 'late']);
assert.equal(C.normalizeAccount(acc('none', 'ETH', 'crypto', { stakeRewards: [] })).stakeRewards, undefined,
  'an empty list is not stored');
assert.equal(C.normalizeAccount(acc('bad', 'ETH', 'crypto', { stakeRewards: [reward({ apr: 1 })] })).stakeRewards, undefined,
  'an invalid list is dropped from the clean copy');

// --- Storage keeps them, and a damaged list is counted for recovery ---
const stored = C.defaultState();
stored.accounts = [eth];
store.set(KEY, JSON.stringify(stored));
const loaded = C.loadState();
assert.equal(loaded.accounts[0].stakeRewards[0].balanceSnapshots[1].amount, 0.75);
assert.equal(C.accountFieldIssues(acc('x', 'ETH', 'crypto', { stakeRewards: [reward({ apr: 1 })] }), []), 1);
assert.equal(C.accountFieldIssues(eth, [eth]), 0);

// --- Import/export: same envelope, nested rewards survive, damage is refused ---
const state = {
  settings: { mainCurrency: 'EUR', costMethod: 'average', assetLedgers: true, dateFormat: 'DD/MM/YYYY' },
  accounts: [eth], trades: [], priceOverrides: {}
};
const exported = JSON.parse(C.exportState(state));
assert.deepEqual(Object.keys(exported), ['app', 'version', 'exportedAt', 'settings', 'accounts', 'trades', 'priceOverrides']);
assert.equal(exported.accounts[0].stakeRewards[0].assetTicker, 'ETH');
const imported = C.importState(JSON.stringify(exported));
assert.equal(imported.accounts[0].stakeRewards[0].balanceSnapshots.length, 2);
const badImport = JSON.parse(JSON.stringify(exported));
badImport.accounts[0].stakeRewards[0].balanceSnapshots[0].amount = -3;
assert.throws(() => C.importState(JSON.stringify(badImport)), /invalid stake rewards/);

// --- Claim targets: same ticker and kind, owner first, then its group ---
const lp = acc('lp', 'CRVLP', 'crypto', { groupId: 'main' });
const main = acc('main', 'ETH', 'crypto');
const crvOther = acc('crv-other', 'CRV', 'crypto');
const crvGroup = acc('crv-group', 'CRV', 'crypto', { groupId: 'main' });
const crvStock = acc('crv-stock', 'CRV', 'stock');
const st = { accounts: [crvOther, main, lp, crvGroup, crvStock], trades: [] };
const crvReward = reward({ assetTicker: 'CRV', balanceSnapshots: [snap('c1', 10, '2026-11-01T10:00:00.000Z')] });
assert.deepEqual(Array.from(C.stakeRewardClaimTargets(st, lp, crvReward), a => a.id), ['crv-group', 'crv-other'],
  'group accounts come before other accounts; another kind never matches');
const ethReward = reward();
assert.deepEqual(Array.from(C.stakeRewardClaimTargets(st, main, ethReward), a => a.id), ['main'],
  'a reward in the staked asset is claimed into its own account');
assert.equal(C.stakeRewardClaimTargets(st, lp, reward({ assetTicker: "GMX" })).length, 0,
  'no matching account means nothing to claim into yet');

// --- Remainder is exact at token precision and never negative ---
assert.equal(C.stakeRewardRemainder(0.3, '0.1', 'ETH'), 0.2, 'no float dust (0.3 - 0.1)');
assert.equal(C.stakeRewardRemainder(1.2, '0.2', 'ETH'), 1);
assert.equal(C.stakeRewardRemainder(1, '1.5', 'ETH'), 0, 'claiming more than the last report leaves 0');
assert.equal(C.stakeRewardRemainder(0, '1', 'ETH'), 0);
assert.equal(C.stakeRewardRemainder(5, '5', 'ETH'), 0);

// --- A claim builds one income record and one pending report ---
const claimAt = Date.parse('2026-11-12T09:30:00.000Z');
const built = C.buildStakeRewardClaim(main, ethReward, main, { amount: '0.25', at: claimAt, value: '600', note: '' }, 'eur');
assert.equal(built.error, undefined);
assert.equal(built.trade.type, 'income');
assert.equal(built.trade.symbol, 'ETH');
assert.equal(built.trade.qty, 0.25);
assert.equal(built.trade.total, 600);
assert.equal(built.trade.currency, 'EUR');
assert.equal(built.trade.accountId, 'main');
assert.equal(built.trade.date, C.stakeRewardClaimDate(claimAt));
assert.equal(built.trade.fxLock.rate, 1);
assert.match(built.trade.note, /Validator rewards/);
assert.equal(C.validateTrade(built.trade, 1e18), null, 'the record passes the record form validation');
assert.equal(C.isValidImportTrade(built.trade, ['main'], [main]), true, 'and survives export/import');
assert.equal(built.snapshot.amount, 0.5, '0.75 pending - 0.25 claimed');
assert.equal(built.snapshot.reportedAt, new Date(claimAt).toISOString());
assert.match(built.snapshot.note, /^Claimed 0\.25 ETH$/);
assert.equal(C.isValidDebtSnapshot(built.snapshot), true);

const noValue = C.buildStakeRewardClaim(main, ethReward, main, { amount: '1', at: claimAt, value: '' }, 'EUR');
assert.equal(noValue.trade.total, 0, 'no value means zero cost basis, like an Income record without a value');
assert.equal(noValue.snapshot.amount, 0, 'claiming everything (and more) leaves nothing pending');

const backdated = C.buildStakeRewardClaim(main, ethReward, main, { amount: '0.1', at: Date.parse('2026-11-05T10:00:00.000Z') }, 'EUR');
assert.equal(backdated.snapshot.amount, 0.4, 'a backdated claim reduces the report that was current then');

const crossToken = C.buildStakeRewardClaim(lp, crvReward, crvGroup, { amount: '4', at: claimAt }, 'EUR');
assert.equal(crossToken.trade.accountId, 'crv-group', 'a CRV reward on an LP stake is paid into the CRV account');
assert.equal(crossToken.trade.symbol, 'CRV');
assert.equal(crossToken.snapshot.amount, 6);
assert.match(crossToken.snapshot.note, /into crv-group$/);

for (const [claim, pattern] of [
  [{ amount: '0', at: claimAt }, /claimed amount/],
  [{ amount: '', at: claimAt }, /claimed amount/],
  [{ amount: 'abc', at: claimAt }, /claimed amount/],
  [{ amount: '0.0000000000000000001', at: claimAt }, /at most 18 decimals/],
  [{ amount: '1', at: Date.now() + 3 * 86400000 }, /future/],
  [{ amount: '1', at: NaN }, /when the reward was claimed/],
  [{ amount: '1', at: claimAt, value: '-5' }, /0 or more/]
]) {
  const res = C.buildStakeRewardClaim(main, ethReward, main, claim, 'EUR');
  assert.match(res.error || '', pattern, JSON.stringify(claim));
}
assert.match(C.buildStakeRewardClaim(main, ethReward, null, { amount: '1', at: claimAt }, 'EUR').error, /Choose the account/);

console.log('stake-rewards: ok');
