#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const store = new Map();
const noop = () => {};
const el = () => new Proxy(function () {}, {
  get: (target, key) => key === 'style' ? {} : key === 'classList'
    ? { add: noop, remove: noop, toggle: noop, contains: () => false }
    : key === 'querySelectorAll' ? () => [] : key === 'querySelector' ? () => null : noop,
  set: () => true,
  apply: () => el()
});
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  },
  document: {
    getElementById: () => null, addEventListener: noop, querySelector: () => null,
    querySelectorAll: () => [], createElement: () => el(), body: el(), documentElement: el(), readyState: 'loading'
  },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: value => value, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C;
C.self = C;
C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

const date = '2024-01-02';
const lock = (pair, rate) => ({ pair, rate, source: 'entry', interpolated: false });

async function run() {
  const transfer = {
    id: 'fx-transfer', type: 'transfer', symbol: 'EUR', qty: 100, currency: 'USD', total: 0,
    date, accountId: 'source', ledger: '6000', fxLock: lock('USD/USD', 1),
    fromFxLock: lock('EUR/USD', 1.1), toFxLock: lock('EUR/USD', 1.1),
    outputs: [{ toAccountId: 'destination', qty: 99, spend: false }]
  };
  C.clearFxCache();
  assert.ok(C.displayPairs([transfer], 'GBP').some(pair => pair.date === date && pair.from === 'EUR'));
  C.cacheRate(date, 'EUR', 'GBP', 0.9, 'ECB-2024-01-02');
  const converted = C.convertTrade(transfer, 'GBP');
  assert.equal(converted.fromFxLock.pair, 'EUR/GBP');
  assert.equal(converted.toFxLock.pair, 'EUR/GBP');
  const groupLedger = C.ledgerTreeMulti([converted], ['source', 'destination'], 'GBP', {}, { source: 'cash', destination: 'cash' });
  assert.equal(groupLedger.roots[0].total, -0.9);

  const cashState = {
    settings: { mainCurrency: 'EUR', costMethod: 'average' },
    accounts: [{ id: 'cash', name: 'Cash', ticker: 'EUR', kind: 'cash' }],
    trades: [{
      id: 'cash-income', type: 'income', symbol: 'EUR', qty: 100, total: 100, currency: 'EUR',
      date, accountId: 'cash', fxLock: lock('EUR/EUR', 1)
    }]
  };
  const cashPoint = await C.netWorthHistoryPointValue({
    at: Date.parse(date + 'T00:00:00Z'), prices: {}
  }, cashState, 'EUR', false);
  assert.deepEqual({ value: cashPoint.value, complete: cashPoint.complete }, { value: 100, complete: true });

  const transferTrades = [
    { id: 'buy-eur', type: 'buy', symbol: 'EUR', qty: 100, total: 100, currency: 'EUR', date: '2024-01-01', accountId: 'source', fxLock: lock('EUR/EUR', 1) },
    {
      id: 'convert-eur-usd', type: 'transfer', symbol: 'EUR', qty: 100, currency: 'EUR', total: 0,
      date, accountId: 'source', fxLock: lock('EUR/EUR', 1),
      outputs: [{ toAccountId: 'destination', qty: 100, toSymbol: 'USD', toQty: 110, spend: false }]
    },
    { id: 'spend-usd', type: 'expense', symbol: 'USD', qty: 11, total: 0, currency: 'USD', date: '2024-01-03', accountId: 'destination', fxLock: lock('USD/USD', 1) }
  ];
  const fifo = C.computePortfolio(transferTrades, {}, 'fifo');
  const destination = fifo.states.destination.USD;
  assert.ok(Math.abs(destination.qty - 99) < 1e-10);
  assert.equal(destination.lots.length, 1);
  assert.ok(Math.abs(destination.lots[0].qty - 11) < 1e-10);
  assert.ok(Math.abs(destination.lots[0].cost - 10) < 1e-10);
  assert.ok(Math.abs(destination.cost - 90) < 1e-10);

  const groupedState = {
    settings: { mainCurrency: 'EUR', costMethod: 'average' },
    accounts: [
      { id: 'group-main', name: 'Group', ticker: 'BTC', kind: 'crypto' },
      { id: 'group-member', name: 'Member', ticker: 'BTC', kind: 'crypto', groupId: 'group-main' },
      { id: 'hidden', name: 'Hidden', ticker: 'BTC', kind: 'crypto' }
    ]
  };
  const returnRows = [{ symbol: 'BTC', marketValue: 400, unrealized: 100, realized: 0 }];
  const returnTrades = [
    { type: 'buy', symbol: 'BTC', qty: 1, total: 100, currency: 'EUR', accountId: 'group-main', fxLock: lock('EUR/EUR', 1) },
    { type: 'buy', symbol: 'BTC', qty: 1, total: 200, currency: 'EUR', accountId: 'group-member', fxLock: lock('EUR/EUR', 1) },
    { type: 'buy', symbol: 'BTC', qty: 1, total: 900, currency: 'EUR', accountId: 'hidden', fxLock: lock('EUR/EUR', 1) }
  ];
  assert.equal(C.summaryLifetimeCost(groupedState, returnRows, returnTrades, [groupedState.accounts[0]]), 300);
  assert.equal(C.summaryLifetimeCost(groupedState, [], returnTrades, []), 0);

  const csvState = {
    settings: { mainCurrency: 'EUR', costMethod: 'fifo', dateFormat: 'YYYY-MM-DD' },
    accounts: [{ id: 'account-real', name: 'Renamed Account', ticker: 'BTC', kind: 'crypto' }],
    trades: [
      { id: 'csv-buy', type: 'buy', symbol: 'BTC', qty: 1, total: 4.006, currency: 'EUR', date: '2024-01-01', accountId: 'account-real', fxLock: lock('EUR/EUR', 1) },
      { id: 'csv-sell', type: 'sell', symbol: 'BTC', qty: 1, total: 10.004, currency: 'EUR', date: '2024-01-02', accountId: 'account-real', fxLock: lock('EUR/EUR', 1) }
    ],
    priceOverrides: {}
  };
  C.localStorage.setItem(C.STORAGE_KEY, JSON.stringify(csvState));
  let taxLotsCsv = '';
  C.downloadTextFile = (name, text) => { taxLotsCsv = text; };
  C.downloadLotsCsv();
  const csvColumns = taxLotsCsv.trim().split(/\r?\n/)[1].split(',');
  assert.equal(csvColumns[4], '10');
  assert.equal(csvColumns[5], '4.01');
  assert.equal(csvColumns[6], '5.99');
  assert.equal(csvColumns[8], 'account-real');

  console.log('accounting audit regression checks passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
