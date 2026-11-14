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
let quotaFull = false;
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => { if (quotaFull) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); }, removeItem: k => store.delete(k) },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

const acc = (id, ticker) => ({ id, name: 'Acct ' + ticker, ticker, kind: 'crypto', createdAt: '2026-01-01T00:00:00.000Z' });
const H1 = 'a1b2c3d4e5f60718', H2 = '0f0e0d0c0b0a0908', H3 = 'deadbeefcafebabe';
const att = h => ({ name: 'invoice.pdf', mime: 'application/pdf', size: 1234, hash: h });
const trade = (id, hash) => Object.assign({ id, type: 'buy', accountId: 'btc-1', symbol: 'BTC', qty: 1, total: 100, date: '2026-01-02', currency: 'EUR' }, hash ? { attachment: att(hash) } : {});
const state = trades => ({ settings: { mainCurrency: 'EUR', costMethod: 'fifo', assetLedgers: true, dateFormat: 'YYYY-MM-DD' }, accounts: [acc('btc-1', 'BTC')], trades, priceOverrides: {} });
const released = [];
C.attDelete = h => { released.push(h); return Promise.resolve(true); };
const take = () => released.splice(0, released.length);

C.saveState(state([trade('t1', H1), trade('t2', H1), trade('t3', H2)]));
assert.deepEqual(take(), [], 'first save releases nothing');

// Two records share one file: deleting one must keep the blob.
C.saveState(state([trade('t2', H1), trade('t3', H2)]));
assert.deepEqual(take(), [], 'shared blob survives while another record references it');

// Deleting the last referencing record releases it (previously leaked forever).
C.saveState(state([trade('t3', H2)]));
assert.deepEqual(take(), [H1], 'blob released once nothing references it');

// Removing an attachment from a record that stays releases that blob only.
C.saveState(state([trade('t3', null)]));
assert.deepEqual(take(), [H2], 'attachment removal releases the blob after the save');

// Replacing a file releases the old blob, never the new one.
C.saveState(state([trade('t3', H1)]));
take();
C.saveState(state([trade('t3', H3)]));
assert.deepEqual(take(), [H1], 'replacement releases only the old blob');

// Unchanged saves and unrelated edits release nothing.
C.saveState(state([trade('t3', H3)]));
assert.deepEqual(take(), []);

// A save that fails (quota) must not release anything: metadata is unchanged.
const realSet = C.localStorage.setItem;
C.localStorage.setItem = () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; };
assert.throws(() => C.saveState(state([])), /storage-unavailable/);
C.localStorage.setItem = realSet;
assert.deepEqual(take(), [], 'failed save left every blob alone');
assert.equal(C.loadState().trades.length, 1, 'stored state intact after the failed save');

// Unreadable previous state: never delete on a guess.
store.set('inoculens.v2', '{"trades":[{"attachment":{"hash":"' + H3 + '"}}, BROKEN');
C.saveState(state([]), { replaceDamaged: true });
assert.deepEqual(take(), [], 'no release when the previous state could not be parsed');

// Hostile hash strings are never treated as references or deletion targets.
C.saveState(state([Object.assign(trade('t4', null), { attachment: { name: 'x.pdf', mime: 'application/pdf', size: 1, hash: '__proto__' } })]), { replaceDamaged: true });
C.saveState(state([]), { replaceDamaged: true });
assert.deepEqual(take(), [], 'invalid hashes are ignored');
console.log('attachment-release: OK');
