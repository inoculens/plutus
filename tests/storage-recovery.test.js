#!/usr/bin/env node
'use strict';
// Damaged saved data must never be silently destroyed. A stored value that is
// unreadable (bad JSON) or that loses records in validation is first kept as
// a recovery copy before any later save replaces it. If the copy cannot be
// kept (storage full) the save is refused instead. Only an explicit wipe
// (replaceDamaged / Clear all data) drops recovery copies. All figures are
// invented. Loads app.js in a stubbed vm context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};

function createApp(initial, opts) {
  const store = new Map(Object.entries(initial || {}));
  const failRecovery = !!(opts && opts.failRecovery);
  const ctl = { failRead: false };
  const C = {
    console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
    localStorage: {
      getItem: k => { if (ctl.failRead) throw new Error('SecurityError'); return store.has(k) ? store.get(k) : null; },
      setItem: (k, v) => {
        if (failRecovery && k.endsWith('.recovery')) throw new Error('QuotaExceededError');
        store.set(k, String(v));
      },
      removeItem: k => store.delete(k)
    },
    document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
    navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
    fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
    requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
    history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
  };
  C.window = C; C.self = C; C.globalThis = C;
  vm.createContext(C);
  vm.runInContext(src, C, { filename: 'app.js' });
  return { C, store, ctl };
}

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const mk = o => Object.assign({ total: 0, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '', fxLock: fx, createdAt: '2025-01-01T00:00:00Z' }, o);
const accounts = [{ id: 'accX', name: 'Monero', ticker: 'XMR', kind: 'crypto' }];
const good1 = mk({ id: 'b1', type: 'buy', symbol: 'XMR', qty: 3, total: 300, date: '2025-02-01', accountId: 'accX' });
const good2 = mk({ id: 'b2', type: 'buy', symbol: 'XMR', qty: 1, total: 100, date: '2025-02-05', accountId: 'accX' });
const bad = mk({ id: 'b3', type: 'buy', symbol: 'XMR', qty: 'not-a-number', total: 50, date: '2025-02-06', accountId: 'accX' });
const settings = { mainCurrency: 'EUR', costMethod: 'average' };
const KEY = 'inoculens.v2';
const REC = KEY + '.recovery';
const stateOf = trades => JSON.stringify({ settings, accounts, trades, priceOverrides: {} });
const recoveryRaws = store => JSON.parse(store.get(REC) || '[]').map(c => c.raw);

// 1. Genuinely new install: empty state, nothing to recover.
{
  const { C, store } = createApp({});
  const st = C.loadState();
  assert.equal(st.trades.length, 0);
  assert.equal(C.storageRecovery, null);
  C.saveState(st);
  assert.equal(store.has(REC), false);
}

// 2. Valid data loads fully and creates no recovery copy, even after saves.
{
  const { C, store } = createApp({ [KEY]: stateOf([good1, good2]) });
  const st = C.loadState();
  assert.equal(st.trades.length, 2);
  assert.equal(C.storageRecovery, null);
  C.saveState(st);
  C.saveState(C.loadState());
  assert.equal(store.has(REC), false);
}

// 3. Malformed JSON: the app starts empty but the original text survives the
//    next save, and the user is told.
{
  const truncated = stateOf([good1, good2]).slice(0, 80);
  const { C, store } = createApp({ [KEY]: truncated });
  const st = C.loadState();
  assert.equal(st.trades.length, 0);
  assert.equal(C.storageRecovery.kind, 'unreadable');
  assert.equal(C.storageRecovery.saved, true);
  assert.deepEqual(recoveryRaws(store), [truncated]);
  C.saveState(st); // would previously have destroyed the only copy
  assert.notEqual(store.get(KEY), truncated);
  assert.deepEqual(recoveryRaws(store), [truncated]);
  // Reload after the save: the copy is still there, no second copy added.
  C.loadState();
  assert.deepEqual(recoveryRaws(store), [truncated]);
}

// 3b. Valid JSON of the wrong shape counts as unreadable too.
{
  const { C, store } = createApp({ [KEY]: '[1,2,3]' });
  C.loadState();
  assert.equal(C.storageRecovery.kind, 'unreadable');
  assert.deepEqual(recoveryRaws(store), ['[1,2,3]']);
}

// 4. One invalid trade is dropped from the loaded view, but the original
//    (including that trade) is preserved before a later save drops it.
{
  const raw = stateOf([good1, good2, bad]);
  const { C, store } = createApp({ [KEY]: raw });
  const st = C.loadState();
  assert.equal(st.trades.length, 2, 'the invalid trade is not loaded');
  assert.equal(C.storageRecovery.kind, 'rejected');
  assert.equal(C.storageRecovery.trades, 1);
  assert.deepEqual(recoveryRaws(store), [raw]);
  C.saveState(st);
  assert.equal(JSON.parse(store.get(KEY)).trades.length, 2);
  const kept = JSON.parse(recoveryRaws(store)[0]);
  assert.equal(kept.trades.length, 3, 'recovery copy still holds the rejected record');
  assert.ok(kept.trades.some(t => t.id === 'b3'));
}

// 5. Damaged original that cannot be preserved (storage full): refuse to save.
{
  const raw = stateOf([good1, good2, bad]);
  const { C, store } = createApp({ [KEY]: raw }, { failRecovery: true });
  const st = C.loadState();
  assert.equal(C.storageRecovery.saved, false);
  assert.throws(() => C.saveState(st), /storage-unavailable/);
  assert.equal(store.get(KEY), raw, 'original stays untouched');
}

// 6. Explicit wipe may replace damaged data; clearing recovery copies removes them.
{
  const truncated = stateOf([good1]).slice(0, 60);
  const { C, store } = createApp({ [KEY]: truncated });
  C.loadState();
  assert.deepEqual(recoveryRaws(store), [truncated]);
  C.saveState(C.defaultState(), { replaceDamaged: true });
  C.clearRecoveryCopies();
  assert.equal(store.has(REC), false);
  assert.equal(C.storageRecovery, null);
  assert.equal(C.loadState().trades.length, 0);
  assert.equal(C.storageRecovery, null);
}

// 7. Another tab replaces clean data with damaged text between our load and
//    save: the guard notices and preserves it.
{
  const { C, store } = createApp({ [KEY]: stateOf([good1]) });
  const st = C.loadState();
  const damaged = '{"settings":';
  store.set(KEY, damaged);
  C.saveState(st);
  assert.deepEqual(recoveryRaws(store), [damaged]);
}

// 8. Invalid priceOverrides are damage: detected, original preserved, valid
//    entries kept, and a later save cannot destroy the original.
{
  const withOv = ov => JSON.stringify({ settings, accounts, trades: [good1], priceOverrides: ov });
  const raw = withOv({ XMR: { price: 150, vs: 'EUR' }, BTC: 'oops', ETH: { price: -3, vs: 'EUR' }, LTC: { price: 5 } });
  const { C, store } = createApp({ [KEY]: raw });
  const st = C.loadState();
  assert.equal(C.storageRecovery.kind, 'rejected');
  assert.equal(C.storageRecovery.overrides, 3, 'three invalid entries counted');
  assert.deepEqual(JSON.parse(JSON.stringify(st.priceOverrides)), { 'crypto:XMR': { price: 150, vs: 'EUR' } }, 'valid entry survives (legacy key migrated to its kind)');
  assert.deepEqual(recoveryRaws(store), [raw]);
  C.saveState(st);
  assert.deepEqual(Object.keys(JSON.parse(store.get(KEY)).priceOverrides), ['crypto:XMR']);
  const kept = JSON.parse(recoveryRaws(store)[0]).priceOverrides;
  assert.deepEqual(Object.keys(kept).sort(), ['BTC', 'ETH', 'LTC', 'XMR'], 'recovery copy still holds every override');
}

// 8b. priceOverrides of the wrong shape (array / string) are damage too.
for (const bad of [[1, 2], 'x', 5]) {
  const raw = JSON.stringify({ settings, accounts, trades: [good1], priceOverrides: bad });
  const { C, store } = createApp({ [KEY]: raw });
  C.loadState();
  assert.equal(C.storageRecovery && C.storageRecovery.kind, 'rejected');
  assert.deepEqual(recoveryRaws(store), [raw]);
}

// 9. Valid legacy overrides (bare numbers and {price,vs}) keep their prices and
//    fiat, raise no recovery; the held ticker's key migrates to its kind.
{
  const ov = { XMR: 150, BTC: { price: 60000, vs: 'USD' } };
  const raw = JSON.stringify({ settings, accounts, trades: [good1], priceOverrides: ov });
  const { C, store } = createApp({ [KEY]: raw });
  const st = C.loadState();
  assert.equal(C.storageRecovery, null);
  assert.deepEqual(JSON.parse(JSON.stringify(st.priceOverrides)), { 'crypto:XMR': 150, BTC: { price: 60000, vs: 'USD' } });
  assert.equal(store.has(REC), false);
}

// 10. A localStorage.getItem exception blocks the save; retry works once readable.
{
  const { C, store, ctl } = createApp({ [KEY]: stateOf([good1]) });
  const st = C.loadState();
  const before = store.get(KEY);
  ctl.failRead = true;
  assert.throws(() => C.saveState(st), /storage-unreadable/);
  assert.equal(store.get(KEY), before, 'nothing was written');
  ctl.failRead = false;
  C.saveState(st); // storage readable again: the retry goes through
  assert.equal(JSON.parse(store.get(KEY)).trades.length, 1);
}

// 11. Invalid settings are reported and preserved, not silently defaulted.
for (const badSettings of [{ mainCurrency: 'XXX', costMethod: 'average' }, { mainCurrency: 'EUR', costMethod: 'bogus' }, 'nope', [1]]) {
  const raw = JSON.stringify({ settings: badSettings, accounts, trades: [good1], priceOverrides: {} });
  const { C, store } = createApp({ [KEY]: raw });
  const st = C.loadState();
  assert.equal(C.storageRecovery.kind, 'rejected');
  assert.equal(C.storageRecovery.settings, true);
  assert.equal(st.settings.mainCurrency, 'EUR', 'defaults shown');
  assert.deepEqual(recoveryRaws(store), [raw]);
  C.saveState(st);
  assert.deepEqual(recoveryRaws(store), [raw], 'original settings survive the save in the recovery copy');
}

// 11b. Invalid ledger labels inside otherwise valid settings are reported.
{
  const s2 = Object.assign({}, settings, { ledgerLabels: { '1100': 'Cash', '': 'bad', 'zz zz': 5 } });
  const raw = JSON.stringify({ settings: s2, accounts, trades: [good1], priceOverrides: {} });
  const { C, store } = createApp({ [KEY]: raw });
  C.loadState();
  assert.equal(C.storageRecovery && C.storageRecovery.settings, true);
  assert.deepEqual(recoveryRaws(store), [raw]);
}

// 12. Valid existing state still loads and saves normally, no recovery noise.
{
  const raw = JSON.stringify({ settings, accounts, trades: [good1, good2], priceOverrides: { XMR: { price: 1, vs: 'EUR' } } });
  const { C, store } = createApp({ [KEY]: raw });
  const st = C.loadState();
  assert.equal(C.storageRecovery, null);
  assert.equal(st.trades.length, 2);
  C.saveState(st);
  C.saveState(C.loadState());
  assert.equal(store.has(REC), false);
}

console.log('storage recovery checks passed');
