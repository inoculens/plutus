#!/usr/bin/env node
'use strict';
// A ticker is not a unique asset: the same symbol can be a coin in one account
// and a stock in another. When a ticker is held under several asset kinds,
// every price for it is keyed KIND:SYM so the two can never share or overwrite
// a price. Unshared tickers keep their plain key. Loads app.js in a stubbed vm
// context; all figures are invented.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
function load() {
  const C = {
    console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
    navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
    fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
    requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
    history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
  };
  C.window = C; C.self = C; C.globalThis = C;
  vm.createContext(C);
  vm.runInContext(src, C, { filename: 'app.js' });
  return C;
}
const C = load();

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const buy = (id, accountId, symbol, qty, total) => ({
  id, type: 'buy', symbol, qty, total, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '',
  fxLock: fx, date: '2025-01-01', accountId
});
const cryptoAcc = { id: 'aC', name: 'W coin', ticker: 'W', kind: 'crypto' };
const stockAcc = { id: 'aS', name: 'W shares', ticker: 'W', kind: 'stock' };
const otherAcc = { id: 'aX', name: 'Monero', ticker: 'XMR', kind: 'crypto' };
const trades = [buy('t1', 'aC', 'W', 100, 100), buy('t2', 'aS', 'W', 2, 400), buy('t3', 'aX', 'XMR', 1, 150)];

// Keys.
C.noteSymbolKinds([cryptoAcc, stockAcc, otherAcc], trades);
assert.equal(C.priceKeyOf('W', 'crypto'), 'CRYPTO:W');
assert.equal(C.priceKeyOf('w', 'stock'), 'STOCK:W');
assert.equal(C.priceKeyOf('XMR', 'crypto'), 'XMR', 'unshared ticker keeps its plain key');
assert.deepEqual(JSON.parse(JSON.stringify(C.splitPriceKey('STOCK:W'))), { sym: 'W', kind: 'stock' });
assert.equal(C.splitPriceKey('W'), null);

// Valuation: each position uses its own price.
const live = { 'CRYPTO:W': 0.5, 'STOCK:W': 250, XMR: 200 };
{
  const p = C.computePortfolio(trades, live, 'average');
  const c = p.byAccount.aC.get('W');
  const s = p.byAccount.aS.get('W');
  assert.equal(c.livePrice, 0.5);
  assert.equal(c.marketValue, 50);
  assert.equal(s.livePrice, 250);
  assert.equal(s.marketValue, 500);
  assert.equal(p.byAccount.aX.get('XMR').marketValue, 200, 'ordinary ticker still works');
}

// Same result when the trades are discovered in the opposite order.
{
  const p = C.computePortfolio(trades.slice().reverse(), live, 'average');
  assert.equal(p.byAccount.aC.get('W').marketValue, 50);
  assert.equal(p.byAccount.aS.get('W').marketValue, 500);
}

// A missing kind-qualified price stays unknown: never borrows the other asset's.
{
  const p = C.computePortfolio(trades, { 'STOCK:W': 250, XMR: 200, W: 999 }, 'average');
  assert.equal(p.byAccount.aC.get('W').marketValue, null, 'crypto W must not read the stock price or the bare key');
  assert.equal(p.byAccount.aS.get('W').marketValue, 500);
}

// computePositions (per-account detail) follows the same rule.
{
  const rows = C.computePositions(trades.filter(t => t.accountId === 'aC'), live, 'average');
  assert.equal(rows[0].livePrice, 0.5);
  const rows2 = C.computePositions(trades.filter(t => t.accountId === 'aS'), live, 'average');
  assert.equal(rows2[0].livePrice, 250);
}

// Without a collision nothing changes: bare keys, no qualification.
{
  C.noteSymbolKinds([cryptoAcc, otherAcc], [trades[0], trades[2]]);
  assert.equal(C.priceKeyOf('W', 'crypto'), 'W');
  const p = C.computePortfolio([trades[0], trades[2]], { W: 0.5, XMR: 200 }, 'average');
  assert.equal(p.byAccount.aC.get('W').marketValue, 50);
}

// Refresh: shared tickers are fetched per kind, results come back kind-keyed;
// plain tickers go straight through to the existing pipeline.
(async () => {
  const D = load();
  const calls = [];
  D.refreshAllPricesCore = (symbols, vs, kinds) => {
    const kind = typeof kinds === 'function' ? kinds(symbols[0]) : 'plain';
    calls.push(symbols.join(',') + '@' + kind);
    D.lastPriceErrors = {};
    const out = {};
    symbols.forEach(s => { out[s] = kind === 'stock' ? 250 : 0.5; });
    return Promise.resolve(out);
  };
  const out = await D.refreshAllPrices(['CRYPTO:W', 'STOCK:W'], 'EUR', null);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { 'CRYPTO:W': 0.5, 'STOCK:W': 250 });
  assert.deepEqual(calls.slice().sort(), ['W@crypto', 'W@stock']);

  calls.length = 0;
  const mixed = await D.refreshAllPrices(['XMR', 'STOCK:W'], 'EUR', null);
  assert.deepEqual(JSON.parse(JSON.stringify(mixed)), { XMR: 0.5, 'STOCK:W': 250 });
  assert.deepEqual(calls, ['XMR@plain', 'W@stock']);

  calls.length = 0;
  await D.refreshAllPrices(['XMR', 'ETH'], 'EUR', null);
  assert.deepEqual(calls, ['XMR,ETH@plain'], 'no qualified keys: one untouched pass');
  console.log('price identity checks passed');
})().catch(e => { console.error(e); process.exit(1); });
