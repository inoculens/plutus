#!/usr/bin/env node
'use strict';
// Debt scope and transport rules from the debt blueprint: a liability is
// counted exactly once however accounts are grouped, selected or filtered;
// multiple positions sum; a debt-only account may go negative; collateral
// links never touch holdings; and debt data survives the export/import round
// trip that sync uses, while changing a snapshot or a collateral link changes
// the sync hash. All figures are invented. Loads app.js in a stubbed vm
// context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
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
vm.runInContext(src, C, { filename: 'app.js' });

const REPORTED = '2026-11-01T10:00:00.000Z';
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const snap = (id, amount, at) => ({ id, amount, reportedAt: at || REPORTED, enteredAt: '2026-11-01T10:01:00.000Z' });
const position = (id, amount, extra) => Object.assign({
  id, name: 'Loan ' + id, createdAt: '2026-11-01T00:00:00.000Z', balanceSnapshots: [snap('s-' + id, amount)]
}, extra || {});
const acc = (id, ticker, kind, extra) => Object.assign(
  { id, name: id, ticker, kind, createdAt: '2026-01-01T00:00:00.000Z' }, extra || {});
const settings = { mainCurrency: 'EUR', costMethod: 'average', assetLedgers: true, dateFormat: 'DD/MM/YYYY' };

(async function run() {
  // --- Grouping: each liability once, whatever mix of ids is supplied.
  const main = acc('m', 'EUR', 'cash', { debtPositions: [position('a', 100)] });
  const member = acc('s', 'EUR', 'cash', { groupId: 'm', debtPositions: [position('b', 40)] });
  const other = acc('o', 'EUR', 'cash', { debtPositions: [position('c', 10)] });
  const grouped = { settings, accounts: [main, member, other], trades: [], priceOverrides: {} };
  const ids = list => list.map(a => a.id).sort().join(',');
  assert.equal(ids(C.debtAccountsForScope(grouped, [main, other])), 'm,o,s', 'a main brings its member once');
  assert.equal(ids(C.debtAccountsForScope(grouped, [main, member, other])), 'm,o,s',
    'a member listed next to its main is not counted twice');
  assert.equal(ids(C.debtAccountsForScope(grouped, [main, main, other])), 'm,o,s', 'repeated ids collapse');
  const groupedValue = C.currentDebtValuation(C.debtAccountsForScope(grouped, [main, member, other]), 'EUR', {}, NOW);
  assert.equal(groupedValue.value, 150, 'grouped liabilities sum exactly once');
  assert.equal(groupedValue.positionCount, 3);
  assert.equal(groupedValue.complete, true);

  // --- Several positions in one account sum.
  const many = acc('many', 'EUR', 'cash', { debtPositions: [position('p1', 100), position('p2', 25.5), position('p3', 0)] });
  assert.equal(C.accountDebtBalanceAt(many, NOW), 125.5, 'a paid-off position adds nothing and stays listed');
  assert.equal(C.currentDebtValuation([many], 'EUR', {}, NOW).value, 125.5);
  assert.equal(C.currentDebtValuation([many], 'EUR', {}, NOW).positionCount, 3);

  // --- A debt-only account has no holdings and a negative net value.
  const debtOnly = acc('d', 'EUR', 'cash', { debtPositions: [position('only', 50)] });
  const gross = C.currentAccountGrossValue([debtOnly], [], [], 'EUR');
  const debt = C.currentDebtValuation([debtOnly], 'EUR', {}, NOW);
  assert.equal(debt.value, 50);
  assert.equal(gross.value - debt.value, -50, 'net value goes negative and is never clamped to zero');

  // --- Collateral links never touch holdings, trades or cost basis.
  const btcTrades = [{ id: 't1', type: 'buy', symbol: 'BTC', qty: 2, total: 40000, currency: 'EUR', date: '2026-10-01', accountId: 'btc' }];
  const holdings = () => JSON.stringify(Array.from(C.computePortfolio(btcTrades.map(t => Object.assign({}, t)), { BTC: 30000 }, 'average').byAccount.btc || []));
  const before = holdings();
  const btc = acc('btc', 'BTC', 'crypto');
  const borrower = acc('usdc', 'USDC', 'crypto', {
    debtPositions: [position('x', 500, { collateral: [{ accountId: 'btc', quantity: 1.5 }] })]
  });
  const pledged = { settings, accounts: [btc, borrower], trades: btcTrades, priceOverrides: {} };
  const exportedPledged = JSON.parse(C.exportState(pledged));
  assert.deepEqual(exportedPledged.trades, btcTrades, 'recording a collateral link never edits a trade');
  assert.equal(holdings(), before, 'pledged quantity does not reduce BTC holdings or cost basis');
  const btcRows = C.computePositions(btcTrades, { BTC: 30000 }, 'average');
  assert.equal(btcRows[0].qtyHeld, 2, 'the collateral account keeps its full quantity');
  assert.equal(btcRows[0].marketValue, 60000, 'and its full gross value');

  // --- Account filter: only visible accounts' liabilities count in history.
  const eurDebt = acc('eur-debt', 'EUR', 'cash', { debtPositions: [position('e', 100)] });
  const btcDebt = acc('btc-debt', 'BTC', 'crypto', { debtPositions: [position('b1', 1)] });
  const at = Date.parse('2026-11-05T00:00:00.000Z');
  const valueWithFilter = async filter => {
    const st = { settings: Object.assign({}, settings, filter === null ? {} : { accountFilter: filter }), accounts: [eurDebt, btcDebt], trades: [], priceOverrides: {} };
    return (await C.netWorthHistoryPointValue({ at, prices: { BTC: 25000 } }, st, 'EUR', false)).value;
  };
  assert.equal(await valueWithFilter(null), -25100, 'no filter: both liabilities count');
  assert.equal(await valueWithFilter(['EUR']), -100, 'filtering to EUR leaves the BTC liability out');
  assert.equal(await valueWithFilter(['BTC']), -25000, 'filtering to BTC leaves the EUR liability out');
  // Grouped accounts under a filter: main and member each counted once.
  const stGrouped = { settings: Object.assign({}, settings, { accountFilter: ['EUR'] }), accounts: [main, member], trades: [], priceOverrides: {} };
  assert.equal((await C.netWorthHistoryPointValue({ at, prices: {} }, stGrouped, 'EUR', false)).value, -140,
    'a grouped main and its member are valued once in history');

  // --- Sync transport: export/import round trip keeps every debt field, and
  // the sync hash reacts to snapshots and collateral but not to the clock.
  const syncState = {
    settings,
    accounts: [btc, acc('xau', 'XAU', 'commodity'), acc('usdc2', 'USDC', 'crypto', {
      debtPositions: [position('sync', 1000, {
        notes: 'AAVE app balance',
        collateral: [{ accountId: 'btc', quantity: 0.05 }, { accountId: 'xau', quantity: 2 }]
      })]
    })],
    trades: [], priceOverrides: {}
  };
  const json = C.exportState(syncState);
  const restored = C.importState(json);
  const restoredPosition = restored.accounts.find(a => a.id === 'usdc2').debtPositions[0];
  assert.equal(restoredPosition.notes, 'AAVE app balance');
  assert.equal(JSON.stringify(restoredPosition.collateral),
    JSON.stringify([{ accountId: 'btc', quantity: 0.05 }, { accountId: 'xau', quantity: 2 }]));
  assert.equal(restoredPosition.balanceSnapshots[0].amount, 1000);
  assert.equal(restoredPosition.balanceSnapshots[0].reportedAt, REPORTED);
  const hash = C.syncHashOfExport(json);
  assert.ok(hash, 'the sync hash is computed');
  assert.equal(C.syncHashOfExport(C.exportState(syncState)), hash, 'unchanged debt data hashes identically');
  const withSnapshot = JSON.parse(JSON.stringify(syncState));
  withSnapshot.accounts[2].debtPositions[0].balanceSnapshots.push(snap('sync-2', 1001.4, '2026-11-09T10:00:00.000Z'));
  assert.notEqual(C.syncHashOfExport(C.exportState(withSnapshot)), hash, 'a new snapshot is detected as a change');
  const withCollateral = JSON.parse(JSON.stringify(syncState));
  withCollateral.accounts[2].debtPositions[0].collateral[0].quantity = 0.06;
  assert.notEqual(C.syncHashOfExport(C.exportState(withCollateral)), hash, 'a collateral change is detected as a change');

  console.log('debt-scope-and-sync: ok');
})().catch(error => { console.error(error); process.exit(1); });
