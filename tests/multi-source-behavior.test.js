#!/usr/bin/env node
'use strict';
// Behavioral checks for multi-source transfers: loads app.js in a stubbed
// vm context (no DOM, no network) and calls the pure helpers directly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const store = new Map();
const noop = () => {};
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'style' ? {} : k === 'classList' ? { add: noop, remove: noop, toggle: noop, contains: () => false } : k === 'querySelectorAll' ? () => [] : k === 'querySelector' ? () => null : noop,
  set: () => true, apply: () => el()
});
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), body: el(), documentElement: el(), readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
let n = 0;
const mk = o => Object.assign({ id: 't' + (++n), total: 0, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '', fxLock: fx, createdAt: '2026-01-01T00:00:00Z' }, o);
const buy = (acc, qty, date) => mk({ type: 'buy', symbol: 'BTC', qty, total: qty * 1000, date, accountId: acc });
const accounts = ['A', 'B', 'E'].map(i => ({ id: i, name: 'Acc' + i, ticker: i === 'E' ? 'ETH' : 'BTC', kind: 'crypto' }));
const ids = accounts.map(a => a.id);
const ms = (srcB, extra) => mk(Object.assign({
  id: 'ms', type: 'transfer', symbol: 'BTC', qty: 0.5, networkFee: 0.002, date: '2026-02-01', accountId: 'A',
  sources: [{ accountId: 'A', qty: 0.3, fee: 0.001 }, { accountId: srcB, qty: 0.2, fee: 0.001 }],
  outputs: [{ label: 'x', qty: 0.498, spend: true }]
}, extra || {}));

// Max by date: ignores later records and the record being edited.
const tr = [buy('B', 0.5, '2026-01-10'), mk({ id: 'sp', type: 'transfer', symbol: 'BTC', qty: 0.2, networkFee: 0, date: '2026-02-01', accountId: 'B', outputs: [{ label: 'x', qty: 0.2, spend: true }] })];
assert.equal(C.transferSourceMaxQty(tr, 'B', 'BTC', '2026-03-01', null), '0.3');
assert.equal(C.transferSourceMaxQty(tr, 'B', 'BTC', '2026-03-01', 'sp'), '0.5');
assert.equal(C.transferSourceMaxQty(tr, 'B', 'BTC', '2026-01-05', null), '');

// Validation: a source of another asset is rejected when the roster is given.
assert.equal(C.isValidImportTrade(ms('B'), ids, accounts), true);
assert.equal(C.isValidImportTrade(ms('E'), ids, accounts), false);

// Source legs: quantities and fees add up to the record totals.
const legs = C.transferSourceLegs(ms('B'));
assert.equal(legs.length, 2);
assert.ok(Math.abs(legs.reduce((a, l) => a + l.qty, 0) - 0.5) < 1e-12);
assert.ok(Math.abs(legs.reduce((a, l) => a + l.share, 0) - 1) < 1e-12);

// CSV breakdown and shared-delete count.
assert.equal(C.transferCsvSources(ms('B'), { A: 'Cold', B: 'Hot' }), 'Cold:0.3:0.001; Hot:0.2:0.001');
assert.equal(C.transferCsvSources(buy('A', 1, '2026-01-01'), {}), '');
const st = { accounts, trades: [ms('B')] };
assert.equal(C.sharedTransfersOutside(st, ['A']), 1);
assert.equal(C.sharedTransfersOutside(st, ['A', 'B']), 0);

// Oversell message names the short source account.
const d = ms('B');
assert.match(C.heldConflictMessage({ trade: d, accountId: 'B', available: '0.1' }, d, st), /AccB can spend at most 0\.1/);

console.log('multi-source behavior checks passed');
process.exit(0);
