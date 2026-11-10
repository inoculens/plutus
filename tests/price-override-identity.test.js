#!/usr/bin/env node
'use strict';
// Manual price overrides follow the same asset-identity rule as live prices:
// a crypto "W" and a stock "W" are different assets, so an override belongs to
// one kind ("crypto:W" / "stock:W"). Legacy bare-ticker entries migrate only
// when the ticker belongs to a single kind; a shared ticker's bare entry is
// preserved, applied to neither asset, and can be assigned by the user.
// Runs real loadState/saveState against an in-memory localStorage; all
// figures are invented.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const KEY = 'inoculens.v2';

function createApp(state) {
  const store = new Map();
  if (state) store.set(KEY, JSON.stringify(state));
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
const plain = o => JSON.parse(JSON.stringify(o));

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const buy = (id, accountId, symbol, qty, total) => ({
  id, type: 'buy', symbol, qty, total, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '',
  fxLock: fx, date: '2025-01-01', accountId, createdAt: '2025-01-01T00:00:00Z'
});
const cryptoAcc = { id: 'aC', name: 'W coin', ticker: 'W', kind: 'crypto' };
const stockAcc = { id: 'aS', name: 'W shares', ticker: 'W', kind: 'stock' };
const settings = { mainCurrency: 'EUR', costMethod: 'average' };
const bothTrades = [buy('t1', 'aC', 'W', 100, 100), buy('t2', 'aS', 'W', 2, 400)];
const mk = (accounts, trades, priceOverrides) => ({ settings, accounts, trades, priceOverrides });
const bothHeld = ov => mk([cryptoAcc, stockAcc], bothTrades, ov);

(async () => {
  // 1 + 2 + 3. Independent per-kind overrides, read through the real lookup.
  {
    const { C } = createApp(bothHeld({ 'crypto:W': { price: 0.5, vs: 'EUR' } }));
    assert.equal(C.priceOverrideFor('W', 'crypto'), 0.5);
    assert.equal(C.priceOverrideFor('W', 'stock'), null, 'crypto W override must not reach stock W');
    assert.equal(C.priceOverrideFor('W'), null, 'no kind on a shared ticker: never guess');
  }
  {
    const { C } = createApp(bothHeld({ 'stock:W': { price: 250, vs: 'EUR' } }));
    assert.equal(C.priceOverrideFor('W', 'stock'), 250);
    assert.equal(C.priceOverrideFor('W', 'crypto'), null, 'stock W override must not reach crypto W');
  }
  {
    const { C } = createApp(bothHeld({ 'crypto:W': { price: 0.5, vs: 'EUR' }, 'stock:W': { price: 250, vs: 'EUR' } }));
    assert.equal(C.priceOverrideFor('W', 'crypto'), 0.5);
    assert.equal(C.priceOverrideFor('W', 'stock'), 250);
  }

  // 4 + 5. Settings operations touch only the entry they name.
  {
    const { C } = createApp(bothHeld({}));
    C.loadState(); // the Settings handlers always load state first (builds the kind registry)
    const ov = {};
    assert.equal(C.overrideAdd(ov, 'W', 0.5, 'EUR', 'crypto').key, 'crypto:W');
    assert.equal(C.overrideAdd(ov, 'w', 250, 'EUR', 'stock').key, 'stock:W');
    assert.equal(C.overrideAdd({}, 'W', 1, 'EUR', 'auto').ok, false, 'Auto on a shared ticker asks the user to choose');
    assert.equal(C.overrideSetFiat(ov, 'stock:W', 'usd'), true);
    assert.deepEqual(plain(ov), { 'crypto:W': { price: 0.5, vs: 'EUR' }, 'stock:W': { price: 250, vs: 'USD' } }, 'only the stock entry changed');
    assert.equal(C.overrideSetFiat(ov, 'crypto:W', 'x'), false, 'invalid fiat rejected');
    assert.equal(C.overrideRemove(ov, 'crypto:W'), true);
    assert.deepEqual(plain(ov), { 'stock:W': { price: 250, vs: 'USD' } }, 'the other override survives deletion');
    assert.equal(C.overrideRemove(ov, 'crypto:W'), false);
  }

  // 6. Valuation: the live refresh and portfolio use each position's own override.
  {
    const { C } = createApp(bothHeld({ 'crypto:W': { price: 0.5, vs: 'EUR' }, 'stock:W': { price: 250, vs: 'EUR' } }));
    const st = C.loadState();
    const live = await C.refreshAllPrices(['CRYPTO:W', 'STOCK:W'], 'EUR', null);
    assert.deepEqual(plain(live), { 'CRYPTO:W': 0.5, 'STOCK:W': 250 });
    const p = C.computePortfolio(st.trades, live, 'average');
    assert.equal(p.byAccount.aC.get('W').marketValue, 100 * 0.5);
    assert.equal(p.byAccount.aS.get('W').marketValue, 2 * 250);
    const rows = C.computePositions(st.trades.filter(t => t.accountId === 'aS'), live, 'average');
    assert.equal(rows[0].marketValue, 500, 'account view uses the stock override too');
  }
  // Only one kind overridden: the other stays unknown, never borrows it.
  {
    const { C } = createApp(bothHeld({ 'crypto:W': { price: 0.5, vs: 'EUR' } }));
    const live = await C.refreshAllPrices(['CRYPTO:W'], 'EUR', null);
    assert.equal(live['CRYPTO:W'], 0.5);
    const st = C.loadState();
    const p = C.computePortfolio(st.trades, live, 'average');
    assert.equal(p.byAccount.aS.get('W').marketValue, null);
  }

  // 7. Historical resolution never reuses another kind's override.
  {
    const { C } = createApp(bothHeld({ 'crypto:W': { price: 0.5, vs: 'EUR' } }));
    assert.equal(C.getHistoricalExec('W', '2025-01-02', 'EUR', 'stock'), null, 'stock lookup ignores the crypto override');
    const hit = C.getHistoricalExec('W', '2025-01-02', 'EUR', 'crypto');
    assert.equal(hit.price, 0.5);
    assert.equal(hit.source, 'manual');
    assert.equal(await C.fetchHistoricalPrice('W', '2025-01-02', 'EUR', 'stock'), null, 'no override, no network: unknown, not 0.5');
    assert.equal(await C.fetchHistoricalPrice('W', '2025-01-02', 'EUR', 'crypto'), 0.5);
  }
  {
    const { C } = createApp(bothHeld({ 'stock:W': { price: 250, vs: 'EUR' } }));
    assert.equal(C.getHistoricalExec('W', '2025-01-02', 'EUR', 'crypto'), null);
    assert.equal(C.getHistoricalExec('W', '2025-01-02', 'EUR', 'stock').price, 250);
  }

  // 8. Legacy overrides migrate when the kind is unambiguous; price and fiat kept.
  {
    const legacy = { W: { price: 250, vs: 'USD' }, XMR: 150, BTC: { price: 60000, vs: 'EUR' } };
    const xmr = { id: 'aX', name: 'Monero', ticker: 'XMR', kind: 'crypto' };
    const only = mk([stockAcc, xmr], [bothTrades[1], buy('t3', 'aX', 'XMR', 1, 100)], legacy);
    const { C, store } = createApp(only);
    const st = C.loadState();
    assert.deepEqual(plain(st.priceOverrides), {
      'stock:W': { price: 250, vs: 'USD' },
      'crypto:XMR': 150,
      BTC: { price: 60000, vs: 'EUR' }
    }, 'W -> stock:W, XMR -> crypto:XMR; BTC is held nowhere so it stays as stored');
    assert.equal(C.priceOverrideEntry('W', 'stock').vs, 'USD');
    assert.equal(C.priceOverrideFor('BTC'), 60000, 'unheld bare entry still applies');
    C.saveState(st);
    assert.deepEqual(Object.keys(JSON.parse(store.get(KEY)).priceOverrides).sort(), ['BTC', 'crypto:XMR', 'stock:W']);
    // Idempotent: loading the migrated data changes nothing.
    assert.deepEqual(plain(C.loadState().priceOverrides), plain(st.priceOverrides));
  }
  // A legacy bare override on a crypto-only ticker keeps working as before.
  {
    const { C } = createApp(mk([cryptoAcc], [bothTrades[0]], { W: 0.75 }));
    assert.equal(C.priceOverrideFor('W', 'crypto'), 0.75);
    assert.equal(C.priceOverrideFor('W'), 0.75);
  }

  // 9. Ambiguous legacy override: preserved untouched, applied to neither
  //    asset, assignable by the user, never silently picked.
  {
    const { C, store } = createApp(bothHeld({ W: { price: 9, vs: 'EUR' } }));
    const st = C.loadState();
    assert.deepEqual(plain(st.priceOverrides), { W: { price: 9, vs: 'EUR' } }, 'kept exactly as stored');
    assert.equal(C.priceOverrideFor('W', 'crypto'), null);
    assert.equal(C.priceOverrideFor('W', 'stock'), null);
    assert.equal(C.getHistoricalExec('W', '2025-01-02', 'EUR', 'stock'), null);
    C.saveState(st);
    assert.deepEqual(JSON.parse(store.get(KEY)).priceOverrides, { W: { price: 9, vs: 'EUR' } }, 'survives a save and reload');
    assert.deepEqual(plain(C.loadState().priceOverrides), { W: { price: 9, vs: 'EUR' } });
    // Recovery path: the user assigns it to one kind.
    const ov = plain(st.priceOverrides);
    const moved = C.overrideAssignKind(ov, 'W', 'stock');
    assert.deepEqual(plain(moved), { ok: true, key: 'stock:W' });
    assert.deepEqual(ov, { 'stock:W': { price: 9, vs: 'EUR' } });
    assert.equal(C.overrideAssignKind({ W: 1, 'stock:W': 2 }, 'W', 'stock').ok, false, 'never overwrites an existing entry');
  }

  // Unaffected: ordinary single-kind portfolio with a kind-tagged override.
  {
    const { C } = createApp(mk([cryptoAcc], [bothTrades[0]], { 'crypto:W': { price: 2, vs: 'EUR' } }));
    assert.equal(C.priceOverrideFor('W', 'crypto'), 2);
    assert.equal(C.priceOverrideFor('W'), 2, 'unambiguous ticker resolves without a kind');
  }

  console.log('price override identity checks passed');
})().catch(e => { console.error(e); process.exit(1); });
