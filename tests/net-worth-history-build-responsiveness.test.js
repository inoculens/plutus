#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = app.indexOf('var NET_WORTH_HELD_GAP_MS =');
const end = app.indexOf('function buildNetWorthHistory(', start);
assert(start >= 0 && end > start, 'held-period history implementation not found');

const scheduled = [];
let replayCount = 0;
const context = {
  Promise,
  Date,
  String,
  Object,
  Math,
  isFinite,
  setTimeout: function (callback) { scheduled.push(callback); },
  convertTrades: function (trades) { return trades; },
  computePortfolio: function () {
    replayCount++;
    return { byAccount: { account: [{ qtyHeld: 1 }] } };
  },
  PRICE_KIND_BY_ACCOUNT: {},
  PRICE_COLLISIONS: {},
  priceKeyOf: function (symbol) { return String(symbol).toUpperCase(); }
};
vm.createContext(context);
vm.runInContext(app.slice(start, end), context, { filename: 'app-history.js' });

async function main() {
  const trades = Array.from({ length: 4 }, function (_, index) {
    return {
      date: '2026-01-0' + (index + 1),
      accountId: 'account'
    };
  });
  const state = { trades, settings: { costMethod: 'average' } };
  const included = { account: true };
  const pending = context.netWorthHistoryHeldPeriods(state, included, 'EUR', 'signature');
  assert.equal(replayCount, 1, 'held-period replay should start with one date');
  assert.equal(scheduled.length, 1, 'remaining dates should wait for later tasks');
  while (scheduled.length) scheduled.shift()();
  const periods = await pending;
  assert.equal(replayCount, 4);
  assert.equal(periods['0'].length, 1);

  const beforeCache = replayCount;
  await context.netWorthHistoryHeldPeriods(state, included, 'EUR', 'signature');
  assert.equal(replayCount, beforeCache, 'same-signature held periods should be reused');

  const largeTrades = Array.from({ length: 250 }, function (_, index) {
    return {
      date: '2025-' + String(Math.floor(index / 28) + 1).padStart(2, '0') + '-' +
        String((index % 28) + 1).padStart(2, '0'),
      accountId: 'account'
    };
  });
  const large = await context.netWorthHistoryHeldPeriods(
    { trades: largeTrades, settings: { costMethod: 'average' } },
    included,
    'EUR',
    'large-signature'
  );
  assert.equal(large, null, 'large ledger scans should skip the expensive optimization');
  assert.equal(scheduled.length, 0, 'skipped scans should not schedule background work');

  console.log('net worth history build responsiveness checks passed');
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
