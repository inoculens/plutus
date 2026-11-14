#!/usr/bin/env node
'use strict';
// A record entered on a device whose calendar date is ahead of this device's
// (timezone travel, or sync between devices in different timezones) must
// never be treated as damaged: it has to survive load, export and import.
// Only a date later than today in UTC+14 (the furthest-ahead timezone on
// Earth) is a genuinely impossible future date. The device clock is forced
// to UTC-12 so the test is identical on every machine.
process.env.TZ = 'Etc/GMT+12';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
const store = new Map();
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); }
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

const dayIn = (tz, offsetDays) => {
  const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
};
const behindToday = dayIn('Etc/GMT+12');     // this device (UTC-12)
const aheadToday = dayIn('Pacific/Kiritimati'); // recorder device (UTC+14)
const impossible = dayIn('Pacific/Kiritimati', 2); // later than any timezone's today
assert.ok(aheadToday >= behindToday, 'fixture: UTC+14 date is not behind UTC-12 date');

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const mk = o => Object.assign({ total: 0, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '', fxLock: fx, createdAt: '2025-01-01T00:00:00Z' }, o);
const accounts = [{ id: 'accX', name: 'Monero', ticker: 'XMR', kind: 'crypto', createdAt: '2025-01-01T00:00:00Z' }];
const settings = { mainCurrency: 'EUR', costMethod: 'average' };
const aheadTrade = mk({ id: 'b1', type: 'buy', symbol: 'XMR', qty: 1, total: 100, date: aheadToday, accountId: 'accX' });
const okTrade = mk({ id: 'b2', type: 'buy', symbol: 'XMR', qty: 1, total: 100, date: '2025-02-01', accountId: 'accX' });
const badTrade = mk({ id: 'b3', type: 'buy', symbol: 'XMR', qty: 1, total: 100, date: impossible, accountId: 'accX' });

// Pure helpers.
assert.equal(C.isFutureEverywhereDateStr(aheadToday), false, 'a UTC+14 "today" exists on Earth right now');
assert.equal(C.isFutureEverywhereDateStr(impossible), true, 'a date later than every timezone\'s today is impossible');
assert.equal(C.isFutureEverywhereDateStr('not-a-date'), false, 'format errors are reported elsewhere');
// The strict check used by the record form is unchanged.
if (aheadToday > behindToday) assert.equal(C.isFutureDateStr(aheadToday), true, 'the form still blocks dates after the local today');

// Validator, export, import and load all accept the ahead-of-device date.
assert.equal(C.isValidImportTrade(aheadTrade, ['accX'], accounts), true);
assert.equal(C.isValidImportTrade(badTrade, ['accX'], accounts), false, 'impossible dates are still rejected');
const state = { settings, accounts, trades: [aheadTrade, okTrade], priceOverrides: {} };
assert.equal(JSON.parse(C.exportState(state)).trades.length, 2, 'export must not silently drop the record');
const envelope = JSON.stringify({ app: 'inoculens-plutus', version: 2, exportedAt: new Date().toISOString(), settings, accounts, trades: [aheadTrade, okTrade], priceOverrides: {} });
assert.equal(C.importState(envelope).trades.length, 2, 'import must accept the whole file');
assert.throws(() => C.importState(JSON.stringify({ app: 'inoculens-plutus', version: 2, exportedAt: new Date().toISOString(), settings, accounts, trades: [badTrade], priceOverrides: {} })), /invalid trade at index 0/);
store.set('inoculens.v2', JSON.stringify(state));
const loaded = C.loadState();
assert.equal(loaded.trades.length, 2, 'load must keep the record');
assert.equal(C.storageRecovery, null, 'no damage may be reported');
console.log('future-date-timezone: ok');
