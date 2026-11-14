#!/usr/bin/env node
'use strict';
// Account-id safety. Ids such as "__proto__", "constructor" and "toString"
// used to collide with Object.prototype inside plain-object maps: accounts
// vanished from the portfolio, assignGroup reported success while doing
// nothing, and computePortfolio wrote ticker state into the GLOBAL prototype.
// These tests drive the full import -> store -> portfolio workflow, not just
// the validator. All figures are invented. Loads app.js in a stubbed vm context.
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

const APP_ID = vm.runInContext('APP_ID', C);
const STORE_VERSION = vm.runInContext('STORE_VERSION', C);
const protoKeys = () => vm.runInContext('Object.getOwnPropertyNames(Object.prototype).sort().join(",")', C);
const PROTO_BEFORE = protoKeys();

const acc = (id, ticker, extra) => Object.assign(
  { id, name: 'Acct ' + ticker, ticker, kind: 'crypto', createdAt: '2026-01-01T00:00:00.000Z' }, extra || {});
const buy = (id, accountId, symbol, qty, price) => (
  { id, type: 'buy', accountId, symbol, qty, total: qty * price, date: '2026-01-02', currency: 'EUR' });
const envelope = (accounts, trades) => JSON.stringify({
  app: APP_ID, version: STORE_VERSION,
  exportedAt: '2026-01-10T00:00:00.000Z',
  settings: { mainCurrency: 'EUR', costMethod: 'fifo' },
  accounts, trades, priceOverrides: {}
});
const persisted = () => JSON.stringify(Array.from(store.entries()).sort());
const rejects = (json, re, label) => assert.throws(() => C.importState(json), re, label);

// --- validator: every hostile id is refused, every legitimate shape accepted
const hostile = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype',
  '', '   ', 'a'.repeat(129), 'has space', 'semi;colon', '<script>x</script>', 'quo"te', "ap'os",
  'new\nline', 'bidi‮id', 'emoji-\u{1F600}', 5, null, undefined, {}, []];
hostile.forEach(id => {
  assert.equal(C.isValidAccount(acc(id, 'BTC')), false, 'rejected: ' + JSON.stringify(id));
  assert.equal(C.isValidAccountId(id), false, 'id rejected: ' + JSON.stringify(id));
});
['btc', 'acc-1', 'A_b.c:d', 'a'.repeat(128), C.uid(), C.uid()].forEach(id =>
  assert.equal(C.isValidAccount(acc(id, 'BTC')), true, 'accepted: ' + id));

// --- import: a baseline good state to compare against after failed imports
const good = envelope(
  [acc('btc-main', 'BTC'), acc('eth-main', 'ETH')],
  [buy('t1', 'btc-main', 'BTC', 2, 100), buy('t2', 'eth-main', 'ETH', 3, 50)]);
const imported = C.importState(good);
assert.equal(imported.accounts.length, 2);
assert.equal(imported.trades.length, 2);
const baseline = persisted();

// --- each hostile import fails without throwing anything but the controlled
// import error, and leaves the complete persisted state byte-identical.
hostile.filter(id => typeof id === 'string').forEach(id => {
  rejects(envelope([acc(id, 'BTC')], []), /import failed/, 'import id ' + JSON.stringify(id));
  assert.equal(persisted(), baseline, 'failed import left state untouched for ' + JSON.stringify(id));
});
rejects(envelope([acc('__proto__', 'BTC'), acc('__proto__', 'ETH')], []), /import failed/, 'duplicate special ids');
rejects(envelope([acc('x1', 'BTC'), acc('x1', 'ETH')], []), /duplicate account id x1/, 'duplicate ordinary ids');
rejects(envelope([acc('constructor', 'BTC'), acc('toString', 'ETH')], []), /import failed/, 'special ids together');
assert.equal(persisted(), baseline, 'duplicates left state untouched');

// --- transfers / trades referencing invalid or missing accounts
const transferTo = (to) => ({ id: 'tr1', type: 'transfer', accountId: 'btc-main', symbol: 'BTC', qty: 1, toAccountId: to, date: '2026-01-03', currency: 'EUR' });
['__proto__', 'constructor', 'toString', 'ghost'].forEach(to => {
  rejects(envelope([acc('btc-main', 'BTC'), acc('eth-main', 'ETH')], [buy('t1', 'btc-main', 'BTC', 2, 100), transferTo(to)]),
    /invalid trade at index 1/, 'transfer to ' + to);
});
rejects(envelope([acc('btc-main', 'BTC')], [buy('t1', '__proto__', 'BTC', 1, 100)]), /import failed/, 'trade on special account');
rejects(envelope([acc('btc-main', 'BTC')], [buy('t1', 'ghost', 'BTC', 1, 100)]), /import failed/, 'trade on missing account');
assert.equal(persisted(), baseline, 'rejected trades left state untouched');

// --- collateral may not reference a missing or special account
const debtOn = (collateralId) => acc('debt-acc', 'USDC', { debtPositions: [{
  id: 'debt-1', name: 'Loan', createdAt: '2026-01-05T00:00:00.000Z',
  balanceSnapshots: [{ id: 's1', amount: 10, reportedAt: '2026-01-05T00:00:00.000Z', enteredAt: '2026-01-05T00:01:00.000Z' }],
  collateral: [{ accountId: collateralId, quantity: 1 }] }] });
['__proto__', 'ghost'].forEach(cid =>
  rejects(envelope([acc('btc-main', 'BTC'), debtOn(cid)], []), /import failed/, 'collateral -> ' + cid));
assert.equal(persisted(), baseline, 'rejected collateral left state untouched');

// --- groups: special / unknown / self members never "succeed" silently
const gst = { accounts: [acc('main1', 'BTC'), acc('m2', 'ETH')], trades: [] };
['__proto__', 'constructor', 'toString', 'ghost'].forEach(id =>
  assert.match(String(C.assignGroup(gst, [id], 'main1')), /not found/i, 'group member ' + id));
assert.match(String(C.assignGroup(gst, ['m2'], '__proto__')), /not found/i, 'group main __proto__');
assert.equal(gst.accounts.some(a => a.groupId !== undefined), false, 'no partial group links');
assert.equal(C.assignGroup(gst, ['m2', 'm2', 'main1'], 'main1'), null, 'duplicates and self are skipped');
assert.equal(gst.accounts[1].groupId, 'main1');
// cycles: a main cannot become a sub-account, a sub-account cannot become a main
assert.match(String(C.assignGroup(gst, ['main1'], 'm2')), /already|grouped/i, 'no cycle main1 <- m2');

// --- state loaded back from storage: valid accounts and totals preserved
const loaded = C.loadState();
assert.deepEqual(Array.from(loaded.accounts.map(a => a.id).sort()), ['btc-main', 'eth-main'], 'no account silently omitted');
const pf = C.computePortfolio(loaded.trades, { BTC: 150, ETH: 60 }, 'fifo');
const btc = pf.byAccount['btc-main'].get('BTC');
const eth = pf.byAccount['eth-main'].get('ETH');
assert.equal(btc.qtyHeld, 2);
assert.equal(btc.marketValue, 300);
assert.equal(eth.qtyHeld, 3);
assert.equal(eth.marketValue, 180);
const grand = Array.from(Object.keys(pf.byAccount)).reduce((s, id) => {
  let t = 0; pf.byAccount[id].forEach(p => { t += p.marketValue; }); return s + t;
}, 0);
assert.equal(grand, 480, 'grand total = sum of per-account totals');

// --- defense in depth: even if a hostile id reaches the engine directly it
// must not throw, must keep its own entry, and must not touch Object.prototype
const hostileTrades = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].map((id, i) =>
  buy('h' + i, id, 'BTC', 1, 100));
let hpf;
assert.doesNotThrow(() => { hpf = C.computePortfolio(hostileTrades, { BTC: 150 }, 'fifo'); });
['__proto__', 'constructor', 'toString', 'hasOwnProperty'].forEach(id => {
  assert.ok(Object.keys(hpf.byAccount).includes(id), 'engine kept account ' + id);
  assert.equal(hpf.byAccount[id].get('BTC').qtyHeld, 1, 'engine position for ' + id);
  assert.equal(hpf.byAccount[id].get('BTC').marketValue, 150);
});
['average', 'fifo'].forEach(method =>
  assert.doesNotThrow(() => C.computePortfolio(hostileTrades, {}, method), 'method ' + method));
assert.equal(vm.runInContext('({}).BTC', C), undefined, 'no inherited BTC on plain objects');
assert.equal(protoKeys(), PROTO_BEFORE, 'Object.prototype is unchanged');

// --- id-keyed helpers tolerate special ids without throwing or inheriting
assert.doesNotThrow(() => C.cashAccountIds({ accounts: [acc('__proto__', 'EUR', { kind: 'cash' })] }));
assert.equal(C.cashAccountIds({ accounts: [] }).constructor, undefined, 'cash id map has no inherited keys');
assert.deepEqual(Array.from(C.expandDeleteIds({ accounts: [acc('btc-main', 'BTC')], trades: [] }, ['__proto__', 'btc-main'])), ['btc-main']);

// --- legacy v1 import (ids generated by uid()) keeps working
const v1 = JSON.stringify({ app: APP_ID, version: 1, exportedAt: '2026-01-10T00:00:00.000Z',
  settings: { mainCurrency: 'EUR', costMethod: 'fifo' },
  trades: [{ id: 'v1t', type: 'buy', symbol: 'BTC', qty: 1, total: 100, date: '2026-01-02', currency: 'EUR' }], priceOverrides: {} });
const fromV1 = C.importState(v1);
assert.equal(fromV1.accounts.length, 1);
assert.equal(C.isValidAccountId(fromV1.accounts[0].id), true, 'generated ids pass the validator');

// --- an existing valid export round-trips
const round = C.importState(C.exportState(C.loadState()));
assert.equal(round.accounts.length, 1);
assert.equal(round.trades.length, 1);
assert.equal(protoKeys(), PROTO_BEFORE, 'Object.prototype still unchanged at the end');

console.log('identifier-security: OK');
