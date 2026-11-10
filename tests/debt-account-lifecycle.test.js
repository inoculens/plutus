#!/usr/bin/env node
'use strict';
// Account deletion must never orphan debt data. An account that owns debt
// positions, or that an open position references as collateral, is blocked by
// one shared guard used by the single and the bulk delete paths. All figures
// are invented. Loads app.js in a stubbed vm context.
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

const acc = (id, ticker, kind, extra) => Object.assign(
  { id, name: id, ticker, kind, createdAt: '2026-01-01T00:00:00.000Z' }, extra || {});
const position = (collateral) => ({
  id: 'debt-1', name: 'Protocol borrow', createdAt: '2026-11-10T10:00:00.000Z',
  balanceSnapshots: [{ id: 's1', amount: 100, reportedAt: '2026-11-10T10:00:00.000Z', enteredAt: '2026-11-10T10:01:00.000Z' }],
  collateral
});
const st = {
  accounts: [
    acc('usdc', 'USDC', 'crypto', { debtPositions: [position([{ accountId: 'btc', quantity: 0.05 }])] }),
    acc('btc', 'BTC', 'crypto'),
    acc('eth', 'ETH', 'crypto'),
    acc('free', 'EUR', 'cash')
  ],
  trades: []
};

// Owner of a position: blocked, alone or inside a larger selection.
assert.match(C.debtAccountDeleteBlock(st, ['usdc']), /owns debt positions/);
assert.match(C.debtAccountDeleteBlock(st, ['free', 'usdc']), /owns debt positions/,
  'a bulk selection that contains a debt owner is blocked');
// Collateral source: blocked while referenced.
assert.match(C.debtAccountDeleteBlock(st, ['btc']), /referenced as collateral/);
assert.match(C.debtAccountDeleteBlock(st, ['eth', 'btc']), /referenced as collateral/,
  'a bulk selection that contains a collateral source is blocked');
// Unrelated accounts stay deletable, and bad input never throws.
assert.equal(C.debtAccountDeleteBlock(st, ['eth']), '');
assert.equal(C.debtAccountDeleteBlock(st, ['free', 'eth']), '');
assert.equal(C.debtAccountDeleteBlock(st, []), '');
assert.equal(C.debtAccountDeleteBlock(null, ['btc']), '');
assert.equal(C.debtAccountDeleteBlock(st, [null, 5, '']), '');
// Once the reference is cleared the source can go; the debt owner cannot.
st.accounts[0].debtPositions[0].collateral = [];
assert.equal(C.debtAccountDeleteBlock(st, ['btc']), '');
assert.match(C.debtAccountDeleteBlock(st, ['usdc']), /owns debt positions/);
// Once the position is removed the owner can go too.
delete st.accounts[0].debtPositions;
assert.equal(C.debtAccountDeleteBlock(st, ['usdc']), '');

// Both delete paths must call the guard before and after confirmation.
const uses = (src.match(/debtAccountDeleteBlock\(/g) || []).length;
assert.ok(uses >= 5, 'guard defined once and used by single + bulk delete, before and after confirm (found ' + uses + ')');

console.log('debt-account-lifecycle: ok');
