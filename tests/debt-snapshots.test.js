#!/usr/bin/env node
'use strict';
// Manual debt snapshots are immutable reported totals. This test verifies
// validation, collateral references, exact as-of lookup, account nesting,
// import/export and storage recovery without changing trade accounting.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const KEY = 'inoculens.v2';
const REC = KEY + '.recovery';
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
  vm.runInContext(src, C, { filename: 'app.js' });
  return { C, store };
}
const acc = (id, ticker, kind) => ({ id, name: id, ticker, kind, createdAt: '2026-01-01T00:00:00.000Z' });
const snap = (id, amount, reportedAt, note) => ({
  id, amount, reportedAt, enteredAt: '2026-11-10T12:01:00.000Z', note
});
const position = (extra) => Object.assign({
  id: 'debt-1', name: 'Protocol borrow', createdAt: '2026-11-10T10:00:00.000Z',
  balanceSnapshots: [
    snap('s1', 1000, '2026-11-10T10:00:00.000Z'),
    snap('s2', 1001.4, '2026-11-10T12:00:00.000Z', 'Latest reported total')
  ],
  collateral: [{ accountId: 'btc', quantity: 0.05 }, { accountId: 'xau', quantity: 2 }]
}, extra || {});
const accounts = [acc('usdc', 'USDC', 'cash'), acc('btc', 'BTC', 'crypto'), acc('xau', 'XAU', 'commodity')];
accounts[0].debtPositions = [position()];

const { C, store } = createApp();
assert.equal(C.isValidDebtPositions(accounts[0], accounts), true);
assert.equal(C.isValidDebtPosition(position(), accounts[0], accounts), true);
assert.equal(C.latestDebtBalanceSnapshot(position(), '2026-11-10T09:59:59.999Z'), null,
  'before the first report there is no liability');
assert.equal(C.latestDebtBalanceSnapshot(position(), '2026-11-10T10:01:00.000Z').amount, 1000,
  'a reported balance remains unchanged after the observation time');
assert.equal(C.latestDebtBalanceSnapshot(position(), '2026-11-10T11:59:59.999Z').amount, 1000,
  'no time-based accrual is performed between snapshots');
assert.equal(C.latestDebtBalanceSnapshot(position(), '2026-11-10T12:00:00.000Z').amount, 1001.4);
assert.equal(C.latestDebtBalanceSnapshot(position()).amount, 1001.4,
  'the latest manually entered total is the current balance');
assert.equal(C.accountDebtBalanceAt(accounts[0], '2026-11-10T11:00:00.000Z'), 1000);
assert.equal(C.accountDebtBalanceAt(accounts[0]), 1001.4);

// Current valuation subtracts the reported total using the owning account's
// asset identity. Collateral accounts are never treated as liabilities.
const btcDebt = acc('btc-debt', 'BTC', 'crypto');
btcDebt.debtPositions = [position({
  collateral: [],
  balanceSnapshots: [snap('btc-s1', 2, '2026-11-10T10:00:00.000Z')]
})];
const valuationAt = Date.parse('2026-11-10T13:00:00.000Z');
const btcValuation = C.currentDebtValuation([btcDebt], 'USD', { BTC: 25000 }, valuationAt);
assert.equal(btcValuation.hasDebt, true);
assert.equal(btcValuation.complete, true);
assert.equal(btcValuation.value, 50000,
  'crypto liability is valued using its owning account ticker/kind price');
const unknownValuation = C.currentDebtValuation([btcDebt], 'USD', {}, valuationAt);
assert.equal(unknownValuation.value, null,
  'an unavailable liability price remains unknown, not zero');
const eurDebt = acc('eur-debt', 'EUR', 'cash');
eurDebt.debtPositions = [position({
  collateral: [],
  balanceSnapshots: [snap('eur-s1', 100, '2026-11-10T10:00:00.000Z')]
})];
C.cacheRate(C.todayStr(), 'EUR', 'USD', 1.1, 'test');
const eurValuation = C.currentDebtValuation([eurDebt], 'USD', {}, valuationAt);
assert.ok(Math.abs(eurValuation.value - 110) < 1e-9,
  'fiat debt is converted using the main-currency FX rate');
const collateralOnly = C.currentDebtValuation([accounts[1], accounts[2]], 'USD', { BTC: 25000, XAU: 2000 }, valuationAt);
assert.equal(collateralOnly.hasDebt, false,
  'collateral account balances are not deducted as liabilities');
const zero = position({ balanceSnapshots: [snap('z1', 0, '2026-11-10T13:00:00.000Z')] });
assert.equal(C.isValidDebtPosition(zero, accounts[0], accounts), true, 'zero represents a valid paid-off snapshot');
for (const invalid of [
  position({ balanceSnapshots: [snap('bad', -1, '2026-11-10T10:00:00.000Z')] }),
  position({ balanceSnapshots: [snap('bad', Infinity, '2026-11-10T10:00:00.000Z')] }),
  position({ apr: 5 }),
  position({ collateral: [{ accountId: 'missing', quantity: 1 }] }),
  position({ collateral: [{ accountId: 'btc', quantity: 0 }] }),
  position({ balanceSnapshots: [snap('s1', 100, 'not-a-date')] }),
  position({ balanceSnapshots: [snap('same', 100, '2026-11-10T10:00:00Z'), snap('same', 101, '2026-11-10T11:00:00Z')] })
]) {
  assert.equal(C.isValidDebtPosition(invalid, accounts[0], accounts), false);
}
const normalized = C.normalizeAccount(accounts[0], accounts);
assert.equal(normalized.ticker, 'USDC');
assert.equal(normalized.debtPositions[0].balanceSnapshots.length, 2);
assert.equal(normalized.debtPositions[0].collateral.length, 2);
const legacy = C.defaultState();
legacy.accounts = [acc('old', 'BTC', 'crypto')];
assert.equal(C.isValidDebtPositions(legacy.accounts[0], legacy.accounts), true,
  'legacy accounts without debt positions remain valid');

// Import/export retains the unchanged top-level envelope and nested snapshots.
const state = {
  settings: { mainCurrency: 'EUR', costMethod: 'average', assetLedgers: true, dateFormat: 'DD/MM/YYYY' },
  accounts, trades: [], priceOverrides: {}
};
const exported = JSON.parse(C.exportState(state));
assert.deepEqual(Object.keys(exported), ['app', 'version', 'exportedAt', 'settings', 'accounts', 'trades', 'priceOverrides']);
assert.equal(exported.accounts[0].debtPositions[0].balanceSnapshots[1].amount, 1001.4);
const imported = C.importState(JSON.stringify(exported));
assert.equal(imported.accounts[0].debtPositions[0].balanceSnapshots[0].amount, 1000);
const badImport = JSON.parse(JSON.stringify(exported));
badImport.accounts[0].debtPositions[0].apr = 0.05;
const before = store.get(KEY);
assert.throws(() => C.importState(JSON.stringify(badImport)), /invalid debt positions/);
assert.equal(store.get(KEY), before, 'invalid import does not replace saved state');

// Invalid nested state is reported and the raw original preserved, not silently lost.
const damagedRaw = JSON.stringify({
  settings: state.settings,
  accounts: [Object.assign({}, accounts[0], { debtPositions: [position({ apr: 5 })] }), accounts[1], accounts[2]],
  trades: [], priceOverrides: {}
});
const damaged = createApp({ [KEY]: damagedRaw });
const repaired = damaged.C.loadState();
assert.ok(damaged.C.storageRecovery, 'malformed debt data triggers storage recovery');
assert.equal(damaged.C.storageRecovery.accountFields, 1);
assert.equal(repaired.accounts[0].debtPositions, undefined, 'invalid debt nested field is not loaded');
assert.equal(JSON.parse(damaged.store.get(REC))[0].raw, damagedRaw, 'the exact source is preserved');
damaged.C.saveState(repaired);
assert.equal(JSON.parse(damaged.store.get(REC))[0].raw, damagedRaw, 'a later save keeps the recovery copy');

(async function runHistoricalDebtChecks() {
  // Positive-debt windows split at zero snapshots and resume at later
  // positive reports. They are price-fetch windows, not accrued balances.
  const windowPosition = position({
    balanceSnapshots: [
      snap('w1', 2, '2026-11-10T10:00:00.000Z'),
      snap('w2', 0, '2026-11-10T11:00:00.000Z'),
      snap('w3', 1, '2026-11-10T12:00:00.000Z')
    ]
  });
  const windows = C.debtPositionPositiveBalanceWindows(windowPosition);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], {
    from: Date.parse('2026-11-10T10:00:00.000Z'),
    to: Date.parse('2026-11-10T11:00:00.000Z')
  });
  assert.equal(windows[1].from, Date.parse('2026-11-10T12:00:00.000Z'));
  assert.equal(windows[1].to, Infinity, 'the last positive snapshot remains effective until another report');

  const historyState = {
    settings: state.settings,
    accounts: [btcDebt],
    trades: [],
    priceOverrides: {}
  };
  const beforeReport = await C.netWorthHistoryPointValue({
    at: Date.parse('2026-11-10T09:59:00.000Z'), prices: {}
  }, historyState, 'USD', false);
  assert.equal(beforeReport.value, 0, 'a future debt snapshot must not leak backward');

  const firstReport = await C.netWorthHistoryPointValue({
    at: Date.parse('2026-11-10T11:00:00.000Z'), prices: { BTC: 25000 }
  }, historyState, 'USD', false);
  assert.equal(firstReport.value, -50000,
    'historical net worth subtracts the first reported balance at and after its timestamp');

  btcDebt.debtPositions[0].balanceSnapshots.push(
    snap('btc-s2', 1.5, '2026-11-10T12:00:00.000Z')
  );
  const betweenReports = await C.netWorthHistoryPointValue({
    at: Date.parse('2026-11-10T11:59:59.000Z'), prices: { BTC: 25000 }
  }, historyState, 'USD', false);
  assert.equal(betweenReports.value, -50000,
    'the previous reported total remains unchanged between snapshots');
  const afterSecondReport = await C.netWorthHistoryPointValue({
    at: Date.parse('2026-11-10T13:00:00.000Z'), prices: { BTC: 25000 }
  }, historyState, 'USD', false);
  assert.equal(afterSecondReport.value, -37500,
    'a later report replaces the outstanding total for later historical points');
  const missingHistoricalPrice = await C.netWorthHistoryPointValue({
    at: Date.parse('2026-11-10T13:00:00.000Z'), prices: {}
  }, historyState, 'USD', false);
  assert.equal(missingHistoricalPrice.value, null,
    'historical liability prices remain unknown rather than zero');

  const cashDebt = acc('historical-eur-debt', 'EUR', 'cash');
  cashDebt.debtPositions = [position({
    collateral: [],
    balanceSnapshots: [snap('eur-h1', 100, '2026-11-10T10:00:00.000Z')]
  })];
  C.cacheRate('2026-11-10', 'EUR', 'USD', 1.1, 'test-history');
  const historicalCash = await C.netWorthHistoryPointValue({
    at: Date.parse('2026-11-10T13:00:00.000Z'), prices: {}
  }, { settings: state.settings, accounts: [cashDebt], trades: [], priceOverrides: {} }, 'USD', false);
  assert.ok(Math.abs(historicalCash.value + 110) < 1e-9,
    'fiat liabilities use historical FX for the chart date');

  const earliestDebtState = {
    settings: state.settings,
    accounts: [btcDebt],
    trades: [],
    priceOverrides: {}
  };
  assert.equal(C.netWorthHistoryStart(earliestDebtState, { 'btc-debt': true }),
    Date.parse('2026-11-10T10:00:00.000Z'),
    'debt-only accounts establish the historical chart start');
  const signature = JSON.parse(C.netWorthHistorySignature(earliestDebtState));
  assert.equal(signature.debtSnapshotModel, 1,
    'historical cache signatures explicitly identify debt snapshot valuation');

  console.log('debt snapshot and historical valuation checks passed');
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
