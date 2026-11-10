#!/usr/bin/env node
'use strict';
// Validation must run BEFORE destructive normalization, and must agree with
// it. Covers: (1) account-group links removed by sanitizeGroups, (2) a
// malformed sourceFeeAuto deleted by trade normalization, (3) selfQty 0
// (valid, equivalent to absent: no false recovery), (4) blank accountFilter
// entries (ignored by normalization: no false recovery). Every damaged case
// is checked end to end: recovery triggered, exact original preserved, the
// next save and a reload leave it intact and add no duplicate copy. Valid and
// legacy shapes must stay clean. Invented data; real loadState/saveState.
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
const recoveryRaws = store => JSON.parse(store.get(REC) || '[]').map(c => c.raw);

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const mkAcc = (id, extra) => Object.assign({ id, name: 'Acc' + id, ticker: 'BTC', kind: 'crypto', createdAt: '2025-01-01T00:00:00Z' }, extra || {});
const mkTrade = o => Object.assign({
  id: 't1', total: 0, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '', fxLock: fx, createdAt: '2025-02-01T00:00:00Z',
  type: 'transfer', symbol: 'BTC', qty: 0.5, networkFee: 0.002, date: '2025-02-01', accountId: 'A'
}, o);
const baseSettings = { mainCurrency: 'EUR', costMethod: 'average' };
const store0 = (accounts, trades, settings) => JSON.stringify({
  settings: settings || baseSettings, accounts, trades: trades || [], priceOverrides: {}
});
const ACCS = [mkAcc('A'), mkAcc('B')];

// A valid multi-source transfer (two sources, one recipient).
const multi = extra => mkTrade(Object.assign({
  sources: [{ accountId: 'A', qty: 0.3, fee: 0.001 }, { accountId: 'B', qty: 0.2, fee: 0.001 }],
  outputs: [{ label: 'x', qty: 0.498, spend: true }]
}, extra || {}));
// A plain single-source transfer to one recipient.
const single = extra => mkTrade(Object.assign({ outputs: [{ label: 'x', qty: 0.498, spend: true }] }, extra || {}));
// A transfer with a received-back remainder (selfQty) alongside one recipient.
const withSelf = (selfQty, extra) => mkTrade(Object.assign({
  qty: 1, networkFee: 0.01, outputs: [{ label: 'x', qty: 0.69, spend: true }], selfQty
}, extra || {}));

// Full recovery contract for one damaged stored value.
function expectRecovery(label, stored, expect) {
  const e = expect || {};
  const { C, store } = createApp({ [KEY]: stored });
  const st = C.loadState();
  assert.ok(C.storageRecovery, label + ': recovery triggered');
  assert.equal(C.storageRecovery.saved, true, label + ': original preserved');
  assert.deepEqual(recoveryRaws(store), [stored], label + ': recovery copy is the exact original text');
  if (e.accounts !== undefined) assert.equal(st.accounts.length, e.accounts, label + ': accounts loaded');
  if (e.trades !== undefined) assert.equal(st.trades.length, e.trades, label + ': trades loaded');
  if (e.field) assert.ok(C.storageRecovery[e.field] > 0, label + ': reported as ' + e.field);
  if (e.check) e.check(C.storageRecovery, st);
  C.saveState(st);
  assert.deepEqual(recoveryRaws(store), [stored], label + ': survives the next save');
  C.loadState();
  assert.deepEqual(recoveryRaws(store), [stored], label + ': the repaired state reloads clean (no new copy)');
  // A fresh start on the repaired text finds nothing wrong (no recurring warning).
  const again = createApp({ [KEY]: store.get(KEY) });
  again.C.loadState();
  assert.equal(again.C.storageRecovery, null, label + ': repaired state is not damaged again');
}

// A valid value must raise nothing and keep saving normally.
function expectClean(label, stored, check) {
  const { C, store } = createApp({ [KEY]: stored });
  const st = C.loadState();
  assert.equal(C.storageRecovery, null, label + ': no recovery for valid data');
  assert.equal(store.has(REC), false, label);
  if (check) check(st);
  C.saveState(st);
  C.saveState(C.loadState());
  assert.equal(store.has(REC), false, label + ': normal saves create no recovery copy');
  assert.equal(C.storageRecovery, null);
}

// ---------- 1. Account groups: reported before sanitizeGroups removes the link.
// Valid parent/member structures stay clean and keep their link.
expectClean('valid group', store0([mkAcc('A'), mkAcc('B', { groupId: 'A' }), mkAcc('C', { groupId: 'A' })]), st => {
  assert.equal(st.accounts.find(a => a.id === 'B').groupId, 'A');
  assert.equal(st.accounts.find(a => a.id === 'C').groupId, 'A');
});
// Missing group reference is legacy-valid (the member renders standalone).
expectClean('dangling group link', store0([mkAcc('A', { groupId: 'deletedMain' }), mkAcc('B')]), st => {
  assert.equal(st.accounts.find(a => a.id === 'A').groupId, 'deletedMain', 'dangling link is kept');
});
// B belongs to main C and also has its own member A: nested.
{
  const stored = store0([mkAcc('A', { groupId: 'B' }), mkAcc('B', { groupId: 'C' }), mkAcc('C')]);
  expectRecovery('nested group', stored, {
    accounts: 3, field: 'groups',
    check: (r, st) => {
      assert.equal(r.groups, 1);
      assert.equal(st.accounts.find(a => a.id === 'B').groupId, undefined, 'the invalid link is removed in the repaired view');
      assert.equal(st.accounts.find(a => a.id === 'A').groupId, 'B', 'the valid member link stays');
    }
  });
  // The removed relationship survives in the recovery copy.
  const { C, store } = createApp({ [KEY]: stored });
  C.loadState();
  const kept = JSON.parse(recoveryRaws(store)[0]).accounts.find(a => a.id === 'B');
  assert.equal(kept.groupId, 'C');
}
// Conflicting relationships: two accounts grouped under each other.
expectRecovery('mutual group links', store0([mkAcc('A', { groupId: 'B' }), mkAcc('B', { groupId: 'A' })]), {
  accounts: 2, check: r => assert.equal(r.groups, 2)
});
// Self-referencing group is reported (account field).
expectRecovery('self group link', store0([mkAcc('A', { groupId: 'A' }), mkAcc('B')]), { accounts: 2, field: 'accountFields' });

// ---------- 2. sourceFeeAuto.
expectClean('valid sourceFeeAuto', store0(ACCS, [multi({ sourceFeeAuto: [true, false] })]), st => {
  assert.deepEqual(plain(st.trades[0].sourceFeeAuto), [true, false], 'kept as stored');
});
expectClean('multi-source without sourceFeeAuto', store0(ACCS, [multi()]));
expectClean('legacy single-source transfer', store0(ACCS, [single()]));
expectClean('single-source list with its own matching modes', store0(ACCS, [single({ sources: [{ accountId: 'A', qty: 0.5, fee: 0.002 }], sourceFeeAuto: [true] })]));
{
  const bad = {
    'not an array': 'yes',
    'object': { 0: true, 1: false },
    'strings': ['true', 'false'],
    'numbers': [1, 0],
    'mixed': [true, 'no'],
    'too few entries': [true],
    'too many entries': [true, false, true]
  };
  Object.keys(bad).forEach(k => {
    expectRecovery('sourceFeeAuto ' + k, store0(ACCS, [multi({ sourceFeeAuto: bad[k] })]), {
      accounts: 2, trades: 1, field: 'tradeFields',
      check: (r, st) => assert.equal(st.trades[0].sourceFeeAuto, undefined, 'repaired view drops the bad value')
    });
  });
  // The malformed value itself is preserved in the recovery copy.
  const stored = store0(ACCS, [multi({ sourceFeeAuto: ['true', 'false'] })]);
  const { C, store } = createApp({ [KEY]: stored });
  C.loadState();
  assert.deepEqual(JSON.parse(recoveryRaws(store)[0]).trades[0].sourceFeeAuto, ['true', 'false']);
}
// Orphans: modes without any sources, on a plain transfer, and on other record types.
// No sources list: normalization keeps a lone sourceFeeAuto as stored, so nothing is lost and nothing is reported.
expectClean('sourceFeeAuto without sources is kept, not flagged', store0(ACCS, [single({ sourceFeeAuto: [true, false] })]), st => {
  assert.deepEqual(plain(st.trades[0].sourceFeeAuto), [true, false]);
});
expectRecovery('single source with mismatched modes', store0(ACCS, [single({ sources: [{ accountId: 'A', qty: 0.5, fee: 0.002 }], sourceFeeAuto: [true, true] })]), { trades: 1, field: 'tradeFields' });
expectRecovery('sourceFeeAuto with sources on a buy', store0(ACCS, [{ id: 'b1', type: 'buy', symbol: 'BTC', qty: 1, total: 100, currency: 'EUR', fee: 0, feeCurrency: 'EUR', fxLock: fx, date: '2025-02-01', accountId: 'A', sources: [{ accountId: 'A', qty: 1 }], sourceFeeAuto: [true] }]), { trades: 1, field: 'tradeFields' });
expectRecovery('sources on a buy', store0(ACCS, [{ id: 'b1', type: 'buy', symbol: 'BTC', qty: 1, total: 100, currency: 'EUR', fee: 0, feeCurrency: 'EUR', fxLock: fx, date: '2025-02-01', accountId: 'A', sources: [{ accountId: 'A', qty: 1 }] }]), { trades: 1, field: 'tradeFields' });

// ---------- 3. selfQty.
expectClean('selfQty 0 (number)', store0(ACCS, [mkTrade({ qty: 1, networkFee: 0.01, outputs: [{ label: 'x', qty: 0.99, spend: true }], selfQty: 0 })]));
expectClean('selfQty "0" (string)', store0(ACCS, [mkTrade({ qty: 1, networkFee: 0.01, outputs: [{ label: 'x', qty: 0.99, spend: true }], selfQty: '0' })]));
expectClean('selfQty absent', store0(ACCS, [single()]));
expectClean('selfQty positive', store0(ACCS, [withSelf(0.3)]), st => assert.equal(st.trades[0].selfQty, 0.3));
expectClean('selfQty positive string', store0(ACCS, [withSelf('0.3')]), st => assert.equal(Number(st.trades[0].selfQty), 0.3));
// Invalid quantities are rejected by validation: counted as damage, original kept.
for (const [label, v] of [['negative', -0.3], ['non-numeric', 'abc'], ['Infinity', 'Infinity'], ['NaN', 'NaN'], ['boolean', true], ['object', { x: 1 }]]) {
  expectRecovery('selfQty ' + label, store0(ACCS, [withSelf(v)]), {
    accounts: 2, trades: 0, check: r => assert.equal(r.trades, 1, 'the record is reported, not silently dropped')
  });
}
// selfQty only means something with recipients: elsewhere it would be deleted.
expectRecovery('selfQty without outputs', store0(ACCS, [mkTrade({ selfQty: 0.3 })]), { trades: 1, field: 'tradeFields' });

// Single-destination fields beside outputs: the validator already rejects the
// record, so it is counted as damage and preserved (never silently dropped).
for (const extra of [{ toSymbol: 'BTC' }, { toQty: 0.4 }, { toAccountId: 'B' }]) {
  expectRecovery('single-destination field beside outputs ' + Object.keys(extra)[0], store0(ACCS, [single(extra)]), {
    accounts: 2, trades: 0, check: r => assert.equal(r.trades, 1)
  });
}

// ---------- 4. accountFilter.
const withFilter = f => store0(ACCS, [], Object.assign({}, baseSettings, { accountFilter: f }));
expectClean('empty filter', withFilter([]), st => assert.deepEqual(plain(st.settings.accountFilter), []));
expectClean('blank filter entries', withFilter(['']), st => assert.deepEqual(plain(st.settings.accountFilter), []));
expectClean('whitespace filter entries', withFilter(['  ', '\t']));
expectClean('valid tickers with blanks', withFilter(['xmr', '', ' BTC ', 'XMR']), st => assert.deepEqual(plain(st.settings.accountFilter), ['XMR', 'BTC']));
expectClean('null filter (show all)', withFilter(null));
for (const [label, v] of [
  ['invalid code', ['!!bad!!']],
  ['non-string number', [5]],
  ['non-string null entry', ['XMR', null]],
  ['non-string object', [{ a: 1 }]],
  ['mixed valid, blank and invalid', ['XMR', '', '!!bad!!']],
  ['not an array', 'XMR']
]) {
  expectRecovery('accountFilter ' + label, withFilter(v), { accounts: 2, check: r => assert.equal(r.settings, true) });
}
{
  const stored = withFilter(['XMR', '!!bad!!']);
  const { C, store } = createApp({ [KEY]: stored });
  C.loadState();
  assert.deepEqual(JSON.parse(recoveryRaws(store)[0]).settings.accountFilter, ['XMR', '!!bad!!'], 'invalid entry preserved');
}

// ---------- Existing behavior stays intact.
{
  // An account field problem, a trade field problem and an override problem still report.
  const stored = JSON.stringify({
    settings: baseSettings,
    accounts: [mkAcc('A', { color: 'red' }), mkAcc('B')],
    trades: [mkTrade({ color: 'blue', outputs: [{ label: 'x', qty: 0.498, spend: true }] })],
    priceOverrides: { BTC: 'bad' }
  });
  const { C, store } = createApp({ [KEY]: stored });
  C.loadState();
  assert.deepEqual(recoveryRaws(store), [stored]);
  assert.equal(C.storageRecovery.accountFields, 1);
  assert.equal(C.storageRecovery.tradeFields, 1);
  assert.equal(C.storageRecovery.overrides, 1);
}

console.log('storage recovery integrity checks passed');
