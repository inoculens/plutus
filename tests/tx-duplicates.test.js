#!/usr/bin/env node
'use strict';
// Duplicate transaction IDs: same asset + same hash on two records warns;
// different assets, cash accounts, a swap's own legs and the record being
// edited never do. Save anyway marks the whole group; ignore / bring back
// toggle that mark; normalization keeps only `true`.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const src = require('./app-source').appSource();
const noop = () => {};
function createApp() {
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
  vm.runInContext(src, C, { filename: 'app-scripts.js' });
  return C;
}
const C = createApp();
const acc = (id, ticker, kind) => ({ id, name: id, ticker, kind });
const rec = (id, accountId, symbol, txid, extra) => Object.assign({ id, type: 'buy', accountId, symbol, qty: 1, date: '2026-01-02', txid }, extra || {});
const HASH = 'AbCdEf0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const state = (trades) => ({
  accounts: [acc('ada1', 'ADA', 'crypto'), acc('ada2', 'ADA', 'crypto'), acc('btc', 'BTC', 'crypto'), acc('bch', 'BCH', 'crypto'), acc('eur1', 'EUR', 'cash'), acc('eur2', 'EUR', 'cash')],
  trades
});

// --- Normalization of the hash ---
assert.equal(C.txidDupNorm('  ' + HASH + ' '), HASH.toLowerCase(), 'hex hashes compare case-insensitively');
assert.equal(C.txidDupNorm('0xABC'), '0xabc', 'EVM hashes compare case-insensitively');
assert.equal(C.txidDupNorm('5KtPn1LGuxhFiwjxErkxTb7XxtLVYUBe6Cn33ej7ATNX'), '5KtPn1LGuxhFiwjxErkxTb7XxtLVYUBe6Cn33ej7ATNX', 'base58 keeps its case');
assert.equal(C.txidDupNorm(''), '');
assert.equal(C.txidDupNorm(null), '');

// --- Groups ---
let st = state([
  rec('a', 'ada1', 'ADA', HASH),
  rec('b', 'ada2', 'ADA', HASH.toLowerCase()),
  rec('c', 'btc', 'BTC', HASH),
  rec('d', 'bch', 'BCH', HASH),
  rec('e', 'eur1', 'EUR', 'REF1', { type: 'income' }),
  rec('f', 'eur2', 'EUR', 'REF1', { type: 'income' }),
  rec('g', 'ada1', 'ADA', '')
]);
let idx = C.txidDupIndex(st);
assert.deepEqual(Object.keys(idx.byId).sort(), ['a', 'b'], 'only same-asset records group: ADA on two accounts');
assert.equal(C.txidDupStatus(st, 'c'), null, 'BTC and BCH with one hash are different assets');
assert.equal(C.txidDupStatus(st, 'e'), null, 'cash (fiat) records are never checked');
assert.equal(C.txidDupStatus(st, 'a').open, true);

// A swap's legs count once (old swaps mirrored one hash on both legs).
const swapSt = state([
  rec('s1', 'ada1', 'ADA', HASH, { type: 'sell', swapId: 'sw' }),
  rec('s2', 'ada2', 'ADA', HASH, { type: 'buy', swapId: 'sw' })
]);
assert.equal(C.txidDupStatus(swapSt, 's1'), null, 'a swap never duplicates itself');

// An internal transfer is one record shown under both accounts: no group.
const xferSt = state([rec('t1', 'ada1', 'ADA', HASH, { type: 'transfer', outputs: [{ toAccountId: 'ada2', qty: 1 }] })]);
assert.equal(C.txidDupStatus(xferSt, 't1'), null, 'an internal transfer is one record');

// --- Save-time matching ---
let hits = C.txidDupMatches(st, [{ symbol: 'ADA', txid: HASH, accountId: 'ada2' }], []);
assert.equal(hits.length, 1);
assert.deepEqual(hits[0].matches.map(t => t.id).sort(), ['a', 'b']);
assert.equal(C.txidDupMatches(st, [{ symbol: 'ETH', txid: HASH, accountId: 'x' }], []).length, 0, 'new asset, no match');
assert.equal(C.txidDupMatches(st, [{ symbol: 'EUR', txid: 'REF1', accountId: 'eur1' }], []).length, 0, 'fiat skipped');
const one = state([rec('a', 'ada1', 'ADA', HASH)]);
assert.equal(C.txidDupMatches(one, [{ symbol: 'ADA', txid: HASH, accountId: 'ada1', prevId: 'a' }], ['a']).length, 0,
  'editing a record never matches itself');
assert.equal(C.txidDupMatches(st, [{ symbol: 'ADA', txid: HASH, accountId: 'ada1', prevId: 'a' }], ['a']).length, 0,
  'an edit that keeps its hash is not asked again');
const sig1 = C.txidDupSignature(hits);
assert.equal(sig1, C.txidDupSignature(C.txidDupMatches(st, [{ symbol: 'ada', txid: ' ' + HASH, accountId: 'ada2' }], [])), 'signature is stable');

// --- Save anyway marks the whole group ---
let st2 = state([rec('a', 'ada1', 'ADA', HASH)]);
const newRec = rec('n', 'ada2', 'ADA', HASH);
st2.trades.push(newRec);
C.txidDupStamp(st2, [newRec], { ['ADA\n' + HASH.toLowerCase()]: true }, {});
assert.equal(st2.trades.every(t => t.txidDupOk === true), true, 'Save anyway marks every record of the group');
assert.equal(C.txidDupStatus(st2, 'a').open, false);
// A third copy without confirmation reopens the warning for the group.
st2 = { accounts: st2.accounts, trades: st2.trades.concat([rec('z', 'ada1', 'ADA', HASH)]) };
assert.equal(C.txidDupStatus(st2, 'a').open, true, 'a new unconfirmed copy warns again');
// An edit that keeps its key keeps the mark; one that changes it drops it.
const kept = rec('a', 'ada1', 'ADA', HASH, { qty: 2 });
C.txidDupStamp(st2, [kept], {}, { a: rec('a', 'ada1', 'ADA', HASH, { txidDupOk: true }) });
assert.equal(kept.txidDupOk, true);
const moved = rec('a', 'ada1', 'ADA', 'other', { txidDupOk: true });
C.txidDupStamp(st2, [moved], {}, { a: rec('a', 'ada1', 'ADA', HASH, { txidDupOk: true }) });
assert.equal(moved.txidDupOk, undefined);

// --- Ignore / bring back ---
const st3 = state([rec('a', 'ada1', 'ADA', HASH), rec('b', 'ada2', 'ADA', HASH)]);
const key = 'ADA\n' + HASH.toLowerCase();
assert.equal(C.txidDupSetIgnored(st3, key, true), 2);
assert.equal(C.txidDupStatus(st3, 'a').open, false, 'ignored');
const st3b = { accounts: st3.accounts, trades: st3.trades.map(t => Object.assign({}, t)) };
assert.equal(C.txidDupSetIgnored(st3b, key, false), 2);
assert.equal(C.txidDupStatus(st3b, 'b').open, true, 'brought back');

// --- Stored shape ---
assert.equal(C.normalizeTradeForStore(rec('a', 'ada1', 'ADA', HASH, { txidDupOk: true })).txidDupOk, true);
assert.equal('txidDupOk' in C.normalizeTradeForStore(rec('a', 'ada1', 'ADA', HASH, { txidDupOk: 'yes' })), false, 'only true is kept');
assert.equal(C.isValidImportTrade(rec('a', 'ada1', 'ADA', HASH, { txidDupOk: true, total: 1, currency: 'EUR' }), ['ada1'], st.accounts), true,
  'the mark never makes a record invalid');

console.log('tx-duplicates: OK');
