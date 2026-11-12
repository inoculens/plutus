#!/usr/bin/env node
'use strict';
// A visitor who accepted analytics must be able to withdraw: the footer
// "Cookie settings" button reopens the banner, and Decline stops analytics
// (disable flag + consent update) and expires the Google Analytics cookies.
// Loads app.js in a stubbed vm context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const noop = () => {};
const store = new Map();
const written = [];
const gtagCalls = [];
function el() {
  const attrs = {}; const handlers = {};
  return { hidden: false, getAttribute: k => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); }, addEventListener: (t, f) => { handlers[t] = f; }, click: () => handlers.click && handlers.click(), handlers };
}
const els = { 'cookie-banner': el(), 'cookie-accept': el(), 'cookie-decline': el(), 'cookie-settings': el() };
const doc = { getElementById: id => els[id] || null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ setAttribute: noop }), body: {}, documentElement: {}, head: { appendChild: noop }, readyState: 'loading' };
Object.defineProperty(doc, 'cookie', { get: () => 'theme=dark; _ga=GA1.1.1; _ga_ABC123=GS1.1.1; _gid=x; keep=1', set: v => { written.push(v); } });
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } },
  document: doc, navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/', hostname: 'plutus.inoculens.com' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 },
  dataLayer: [], gtag: function () { gtagCalls.push(Array.from(arguments)); }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

// Footer markup carries the button.
assert.match(html, /<button type="button" id="cookie-settings" class="foot-link foot-btn">Cookie settings<\/button>/);

// Previously accepted: banner hidden, button wired.
store.set('inoculens.consent.v1', JSON.stringify({ choice: 'accepted', at: '2026-01-01T00:00:00Z' }));
C.consentInitBanner();
assert.equal(els['cookie-banner'].hidden, true, 'accepted visitors do not see the banner on load');
assert.ok(els['cookie-settings'].handlers.click, 'footer button is wired even when a choice exists');

// Cookie settings reopens the banner with working Accept/Decline.
els['cookie-settings'].click();
assert.equal(els['cookie-banner'].hidden, false, 'Cookie settings reopens the banner');
assert.ok(els['cookie-decline'].handlers.click && els['cookie-accept'].handlers.click, 'both buttons wired after reopening');

// Decline withdraws consent.
els['cookie-decline'].click();
assert.equal(JSON.parse(store.get('inoculens.consent.v1')).choice, 'declined');
assert.equal(els['cookie-banner'].hidden, true);
assert.equal(C['ga-disable-G-0JEDV505S7'], true, 'GA disable flag set');
const upd = gtagCalls.filter(c => c[0] === 'consent' && c[1] === 'update').pop();
assert.equal(upd[2].analytics_storage, 'denied');
const expired = written.filter(w => /expires=Thu, 01 Jan 1970/.test(w));
for (const name of ['_ga', '_ga_ABC123', '_gid']) {
  assert.ok(expired.some(w => w.startsWith(name + '=;') && /path=\//.test(w)), name + ' expired');
  assert.ok(expired.some(w => w.startsWith(name + '=;') && /domain=\.inoculens\.com/.test(w)), name + ' expired on the parent domain');
}
assert.ok(!written.some(w => w.startsWith('theme=') || w.startsWith('keep=')), 'unrelated cookies are untouched');

// Accept again re-enables.
els['cookie-settings'].click();
els['cookie-accept'].click();
assert.equal(C['ga-disable-G-0JEDV505S7'], false);
assert.equal(JSON.parse(store.get('inoculens.consent.v1')).choice, 'accepted');
console.log('consent-withdraw: ok');
