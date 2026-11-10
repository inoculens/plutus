#!/usr/bin/env node
'use strict';
// Optional fields must not be silently dropped or defaulted by normalization.
// A stored account / trade / settings value whose OPTIONAL field is invalid
// (bad colour, ledger map, group link, group fiat, address, note, createdAt,
// assetLedgers, accountFilter, ledgerLabels, trade colour, outputs ...) must
// trigger recovery: the exact original text is kept as a recovery copy, the
// record still loads, and a later save cannot destroy the original. Absent /
// blank / legitimately normalizable values must NOT trigger recovery. Runs
// real loadState/saveState against an in-memory localStorage; invented data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const KEY = 'inoculens.v2';
const REC = KEY + '.recovery';

function createApp(initial) {
  const store = new Map(Object.entries(initial || {}));
  const ctl = { failRead: false };
  const C = {
    console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
    localStorage: {
      getItem: k => { if (ctl.failRead) throw new Error('SecurityError'); return store.has(k) ? store.get(k) : null; },
      setItem: (k, v) => store.set(k, String(v)),
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
const plain = o => JSON.parse(JSON.stringify(o));
const recoveryRaws = store => JSON.parse(store.get(REC) || '[]').map(c => c.raw);

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const trade = (id, extra) => Object.assign({
  id, type: 'buy', symbol: 'XMR', qty: 3, total: 300, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '',
  fxLock: fx, date: '2025-02-01', accountId: 'accX', createdAt: '2025-02-01T00:00:00Z'
}, extra || {});
const baseAccount = { id: 'accX', name: 'Monero', ticker: 'XMR', kind: 'crypto', createdAt: '2025-01-01T00:00:00Z' };
const baseSettings = { mainCurrency: 'EUR', costMethod: 'average' };
const raw = (over) => JSON.stringify(Object.assign({
  settings: baseSettings, accounts: [baseAccount], trades: [trade('t1')], priceOverrides: {}
}, over || {}));
const withAccount = extra => raw({ accounts: [Object.assign({}, baseAccount, extra)] });
const withSettings = extra => raw({ settings: Object.assign({}, baseSettings, extra) });

// Asserts the full recovery contract for one damaged stored value.
function expectRecovery(label, stored, check) {
  const { C, store } = createApp({ [KEY]: stored });
  const st = C.loadState();
  assert.ok(C.storageRecovery, label + ': recovery triggered');
  assert.equal(C.storageRecovery.kind, 'rejected', label);
  assert.equal(C.storageRecovery.saved, true, label + ': original preserved');
  assert.deepEqual(recoveryRaws(store), [stored], label + ': recovery copy is the exact original text');
  assert.equal(st.accounts.length, 1, label + ': the account still loads (no data hidden)');
  assert.equal(st.trades.length, 1, label + ': its records still load');
  if (check) check(C.storageRecovery, st);
  // A later save must not destroy the original.
  C.saveState(st);
  assert.deepEqual(recoveryRaws(store), [stored], label + ': survives the next save');
  assert.notEqual(store.get(KEY), stored, label + ': active data is the repaired version');
  C.loadState(); // reload: still exactly one copy, no duplicates
  assert.deepEqual(recoveryRaws(store), [stored], label + ': reload adds nothing');
}

// Asserts a valid value loads without any recovery noise and saves normally.
function expectClean(label, stored, check) {
  const { C, store } = createApp({ [KEY]: stored });
  const st = C.loadState();
  assert.equal(C.storageRecovery, null, label + ': no recovery for valid data');
  assert.equal(store.has(REC), false, label);
  if (check) check(st, C);
  C.saveState(st);
  C.saveState(C.loadState());
  assert.equal(store.has(REC), false, label + ': normal saves create no recovery copy');
}

// ---- Accounts: every invalid optional field triggers recovery.
expectRecovery('account color', withAccount({ color: 'red' }), r => assert.equal(r.accountFields, 1));
expectRecovery('account color (not a string)', withAccount({ color: 12 }));
expectRecovery('account color (bad hex length)', withAccount({ color: '#12345' }));
expectRecovery('account ledgers (not an object)', withAccount({ ledgers: 'x' }));
expectRecovery('account ledgers (invalid entries)', withAccount({ ledgers: { '1100': 'Cash', '': 'bad', '2000': 5 } }));
expectRecovery('account groupId (not a string)', withAccount({ groupId: 7 }));
expectRecovery('account groupId (self link)', withAccount({ groupId: 'accX' }));
expectRecovery('account groupCurrency', withAccount({ groupCurrency: 'XXX' }));
expectRecovery('account groupCurrency (not a string)', withAccount({ groupCurrency: 3 }));
expectRecovery('account address (too long)', withAccount({ address: 'a'.repeat(129) }));
expectRecovery('account address (not a string)', withAccount({ address: { x: 1 } }));
expectRecovery('account note (too long)', withAccount({ note: 'n'.repeat(281) }));
expectRecovery('account note (not a string)', withAccount({ note: ['x'] }));
expectRecovery('account createdAt (not a date)', withAccount({ createdAt: 'yesterday-ish' }));
expectRecovery('account createdAt (wrong type)', withAccount({ createdAt: 12345 }));
expectRecovery('account createdAt (empty)', withAccount({ createdAt: '' }));

// The invalid field is reported, not silently defaulted: the original date is
// in the recovery copy even though the loaded account has a fresh one.
{
  const stored = withAccount({ createdAt: 'yesterday-ish' });
  const { C, store } = createApp({ [KEY]: stored });
  C.loadState();
  assert.equal(JSON.parse(recoveryRaws(store)[0]).accounts[0].createdAt, 'yesterday-ish');
}

// ---- Accounts: valid, absent and legacy shapes stay clean.
expectClean('account with no optional fields', raw({ accounts: [{ id: 'accX', name: 'Monero', ticker: 'XMR' }] }), st => {
  assert.equal(st.accounts[0].kind, 'crypto', 'legacy account without kind defaults quietly');
});
expectClean('account with every optional field valid', withAccount({
  color: '#aabbcc', ledgers: { '1100': 'Cash' }, groupId: 'someMain', groupCurrency: 'usd', address: '  bc1qexample  ', note: 'my note'
}), st => {
  assert.equal(st.accounts[0].color, '#AABBCC');
  assert.equal(st.accounts[0].groupCurrency, 'USD');
  assert.equal(st.accounts[0].address, 'bc1qexample');
});
expectClean('benign blanks and nulls', withAccount({ color: '', note: '   ', address: null, groupId: '', groupCurrency: null, ledgers: {}, createdAt: undefined }));
expectClean('short hex colour, dangling group link', withAccount({ color: '#abc', groupId: 'deletedMain' }));
expectClean('account without createdAt (older data)', raw({ accounts: [{ id: 'accX', name: 'Monero', ticker: 'XMR', kind: 'crypto' }] }));

// ---- Trades: invalid optional metadata.
{
  const bad = { accounts: [baseAccount], trades: [trade('t1', { color: 'blue' })] };
  expectRecovery('trade color', raw(bad), r => assert.equal(r.tradeFields, 1));
  expectRecovery('trade outputs (not an array)', raw({ trades: [trade('t1', { outputs: 'x' })] }));
  expectClean('trade with valid color', raw({ trades: [trade('t1', { color: '#112233' })] }));
  expectClean('trade with no optional metadata', raw({ trades: [trade('t1')] }));
}

// ---- Settings: every invalid optional field triggers recovery.
{
  const settingsCheck = (r, st) => {
    assert.equal(r.settings, true);
    assert.equal(st.settings.mainCurrency, 'EUR');
  };
  expectRecovery('assetLedgers (string)', withSettings({ assetLedgers: 'false' }), settingsCheck);
  expectRecovery('assetLedgers (number)', withSettings({ assetLedgers: 0 }), settingsCheck);
  expectRecovery('accountFilter (not an array)', withSettings({ accountFilter: 'XMR' }), settingsCheck);
  expectRecovery('accountFilter (invalid code)', withSettings({ accountFilter: ['XMR', '!!bad!!'] }), settingsCheck);
  expectRecovery('ledgerLabels (not an object)', withSettings({ ledgerLabels: 'x' }), settingsCheck);
  expectRecovery('ledgerLabels (invalid entries)', withSettings({ ledgerLabels: { '1100': 'Cash', '': 'bad' } }), settingsCheck);
  // Original filter survives in the recovery copy even though the app shows all assets.
  const stored = withSettings({ accountFilter: 'XMR' });
  const { C, store } = createApp({ [KEY]: stored });
  C.loadState();
  assert.equal(JSON.parse(recoveryRaws(store)[0]).settings.accountFilter, 'XMR');
}

// ---- Settings: valid, absent and legacy shapes stay clean.
expectClean('settings with only the required fields', raw());
expectClean('settings with every optional field valid', withSettings({
  assetLedgers: false, dateFormat: 'YYYY-MM-DD', accountFilter: ['xmr', ' XMR ', 'BTC'], ledgerLabels: { '1100': 'Cash' }
}), st => {
  assert.equal(st.settings.assetLedgers, false);
  assert.deepEqual(plain(st.settings.accountFilter), ['XMR', 'BTC'], 'case/duplicates normalized quietly');
  assert.equal(st.settings.dateFormat, 'YYYY-MM-DD');
});
expectClean('legacy settings with null optionals', withSettings({ accountFilter: null, ledgerLabels: null, assetLedgers: null }));
expectClean('legacy state with no settings key at all', JSON.stringify({ accounts: [baseAccount], trades: [trade('t1')], priceOverrides: {} }));

// ---- General protection.
// Valid kind-qualified and legacy overrides stay intact.
expectClean('valid overrides', raw({
  accounts: [baseAccount, { id: 'accS', name: 'W shares', ticker: 'W', kind: 'stock' }, { id: 'accC', name: 'W coin', ticker: 'W', kind: 'crypto' }],
  trades: [trade('t1'), trade('t2', { symbol: 'W', accountId: 'accS' }), trade('t3', { symbol: 'W', accountId: 'accC' })],
  priceOverrides: { 'crypto:W': { price: 0.5, vs: 'EUR' }, 'stock:W': { price: 250, vs: 'EUR' }, XMR: 150 }
}), (st) => {
  assert.deepEqual(plain(st.priceOverrides), { 'crypto:W': { price: 0.5, vs: 'EUR' }, 'stock:W': { price: 250, vs: 'EUR' }, 'crypto:XMR': 150 });
});

// A failed read blocks saving, even while the stored data is damaged; retry works.
{
  const stored = withAccount({ color: 'red' });
  const { C, store, ctl } = createApp({ [KEY]: stored });
  const st = C.loadState();
  ctl.failRead = true;
  assert.throws(() => C.saveState(st), /storage-unreadable/);
  assert.equal(store.get(KEY), stored, 'nothing was written while the read failed');
  ctl.failRead = false;
  C.saveState(st);
  assert.deepEqual(recoveryRaws(store), [stored], 'retry preserves the original first, then saves');
}

// A save cannot overwrite damaged data before it is preserved (storage full).
{
  const stored = withAccount({ color: 'red' });
  const { C, store } = createApp({ [KEY]: stored });
  const real = C.localStorage.setItem;
  C.localStorage.setItem = (k, v) => { if (k === REC) throw new Error('QuotaExceededError'); return real(k, v); };
  const st = C.loadState();
  assert.equal(C.storageRecovery.saved, false);
  assert.throws(() => C.saveState(st), /storage-unavailable/);
  assert.equal(store.get(KEY), stored, 'original left untouched');
}

// Existing recovery download keeps working and delivers the exact original text.
{
  const stored = withAccount({ color: 'red' });
  const { C } = createApp({ [KEY]: stored });
  C.loadState();
  const got = [];
  C.downloadTextFile = (name, text, mime) => got.push({ name, text, mime });
  C.downloadRecoveryCopy();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, stored, 'download is byte-identical to what was stored');
  assert.match(got[0].name, /recovery/);
}

// Several invalid fields at once are still ONE preserved original.
{
  const stored = raw({
    settings: Object.assign({}, baseSettings, { assetLedgers: 'x' }),
    accounts: [Object.assign({}, baseAccount, { color: 'red', note: 7 })],
    trades: [trade('t1', { color: 'blue' })],
    priceOverrides: { XMR: 'bad' }
  });
  const { C, store } = createApp({ [KEY]: stored });
  C.loadState();
  assert.deepEqual(recoveryRaws(store), [stored]);
  assert.equal(C.storageRecovery.accountFields, 1);
  assert.equal(C.storageRecovery.tradeFields, 1);
  assert.equal(C.storageRecovery.settings, true);
  assert.equal(C.storageRecovery.overrides, 1);
}

console.log('storage recovery field checks passed');
