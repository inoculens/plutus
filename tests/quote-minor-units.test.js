#!/usr/bin/env node
'use strict';
// Quotes reported in a minor currency unit (London pence "GBp"/"GBX", South
// African cents "ZAc", Israeli agorot "ILA") must be converted to the main
// unit. Upper-casing "GBp" to "GBP" used to make pence read as pounds, a
// 100x overstated price. Loads app.js in a stubbed vm context. All figures
// are invented.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
let fetchImpl = () => Promise.reject(new Error('unset'));
const C = {
  console, setTimeout, clearTimeout, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: (u, o) => fetchImpl(u, o), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

const plain = o => JSON.parse(JSON.stringify(o));
const yq = (currency, price) => ({ chart: { result: [{ meta: { currency, regularMarketPrice: price } }] } });

// Pure helper.
assert.deepEqual(plain(C.normalizeQuoteUnit('GBp', 7250)), { price: 72.5, currency: 'GBP', divisor: 100 });
assert.deepEqual(plain(C.normalizeQuoteUnit('GBX', 7250)), { price: 72.5, currency: 'GBP', divisor: 100 });
assert.deepEqual(plain(C.normalizeQuoteUnit('GBP', 72.5)), { price: 72.5, currency: 'GBP', divisor: 1 }, 'pounds stay pounds');
assert.deepEqual(plain(C.normalizeQuoteUnit('ZAc', 1850)), { price: 18.5, currency: 'ZAR', divisor: 100 });
assert.deepEqual(plain(C.normalizeQuoteUnit('ILA', 1250)), { price: 12.5, currency: 'ILS', divisor: 100 });
assert.deepEqual(plain(C.normalizeQuoteUnit('usd', 10)), { price: 10, currency: 'USD', divisor: 1 });
assert.deepEqual(plain(C.normalizeQuoteUnit(undefined, 10)), { price: 10, currency: 'USD', divisor: 1 });

// Live quote parsers.
assert.deepEqual(plain(C.parseYahooQuote(yq('GBp', 7250))), { price: 72.5, currency: 'GBP' });
assert.deepEqual(plain(C.parseYahooQuote(yq('USD', 250))), { price: 250, currency: 'USD' });
assert.deepEqual(plain(C.parseYahooQuote(yq('GBP', 72.5))), { price: 72.5, currency: 'GBP' });
assert.deepEqual(plain(C.parseYahooQuote({ chart: { result: [{ meta: { currency: 'GBX' }, indicators: { quote: [{ close: [null, 7000, 7250] }] } }] } })), { price: 72.5, currency: 'GBP' }, 'close fallback is scaled too');
const cnbc = C.parseCnbcQuotes({ FormattedQuoteResult: { FormattedQuote: [
  { code: 0, symbol: 'VOD-GB', last: '7250', currencyCode: 'GBp' },
  { code: 0, symbol: 'AAPL', last: '190', currencyCode: 'USD' }] } });
assert.deepEqual(plain(cnbc['VOD-GB']), { price: 72.5, currency: 'GBP' });
assert.deepEqual(plain(cnbc.AAPL), { price: 190, currency: 'USD' });

// Historical day price (fetchYahooHistory) is scaled before it is returned.
const day = Date.UTC(2026, 10, 9) / 1000;
const chart = currency => ({ chart: { result: [{ meta: { currency }, timestamp: [day], indicators: { quote: [{ close: [7250] }] } }] } });
fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve(chart('GBp')) });

async function main() {
  const hist = await C.fetchYahooHistory('VOD.L', '2026-11-10', 'GBP', fetchImpl);
  assert.equal(hist.price, 72.5, 'GBp history close must be converted to pounds');
  fetchImpl = () => Promise.resolve({ ok: true, json: () => Promise.resolve(chart('GBP')) });
  const histPounds = await C.fetchYahooHistory('VOD.L', '2026-11-10', 'GBP', fetchImpl);
  assert.equal(histPounds.price, 7250, 'a GBP-denominated series is left alone');
  console.log('quote-minor-units: ok');
}
main().catch(e => { console.error(e); process.exit(1); });
