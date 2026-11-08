#!/usr/bin/env node
'use strict';
// A multi-source transfer used to show its drag grip only under the account
// it was created from, and the reorder only permuted records of that primary
// account. Seen from any other account it touches, the record now carries the
// grip like every other card and can be moved among that account's same-date
// records, with the unfunded-outflow failsafe still deciding. All figures are
// invented. Loads app.js in a stubbed vm context with a minimal fake DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const store = new Map();
const noop = () => {};

function fakeEl(tag) {
  const t = { tag, children: [], className: '', attrs: {}, style: {}, dataset: {}, textContent: '', hidden: false, parentNode: null };
  t.classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
  t.appendChild = c => { t.children.push(c); try { c.parentNode = t; } catch (e) { /* ignore */ } return c; };
  t.append = (...cs) => cs.forEach(c => t.appendChild(c));
  t.insertBefore = c => t.appendChild(c);
  t.removeChild = c => c;
  t.setAttribute = (k, v) => { t.attrs[k] = String(v); };
  t.getAttribute = k => (k in t.attrs ? t.attrs[k] : null);
  t.removeAttribute = k => { delete t.attrs[k]; };
  t.querySelector = () => null;
  t.querySelectorAll = () => [];
  t.cloneNode = () => fakeEl(tag);
  return new Proxy(t, { get: (o, k) => (k in o ? o[k] : (typeof k === 'symbol' ? undefined : noop)), set: (o, k, v) => { o[k] = v; return true; } });
}

const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: fakeEl, createTextNode: s => ({ textContent: String(s) }), body: fakeEl('body'), documentElement: fakeEl('html'), readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const mk = o => Object.assign({ total: 0, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '', fxLock: fx, createdAt: '2025-01-01T00:00:00Z' }, o);
const X = 'accX', Y = 'accY', D = '2025-03-01';
const accounts = [X, Y].map(id => ({ id, name: id, ticker: 'XMR', kind: 'crypto' }));

// X holds 3 and Y holds 0.5 the day before. On D (store order): Y buys 1,
// a two-source transfer created from X moves 1 (net 0.9998) from X and 1.5
// from Y and sends 1.5 back to Y, then Y buys 0.1. Y needs the 1 it bought
// before the transfer to fund its leg.
const bx = mk({ id: 'bx', type: 'buy', symbol: 'XMR', qty: 3, total: 300, date: '2025-02-28', accountId: X });
const by0 = mk({ id: 'by0', type: 'buy', symbol: 'XMR', qty: 0.5, total: 60, date: '2025-02-28', accountId: Y });
const by1 = mk({ id: 'by1', type: 'buy', symbol: 'XMR', qty: 1, total: 120, date: D, accountId: Y });
const tr = mk({
  id: 'tr', type: 'transfer', symbol: 'XMR', qty: 2.5, networkFee: 0.0002, date: D, accountId: X,
  sources: [{ accountId: X, qty: 1, fee: 0.0002 }, { accountId: Y, qty: 1.5, fee: '' }],
  outputs: [{ toAccountId: Y, qty: 1.5, spend: false }], selfQty: 0.9998
});
const by2 = mk({ id: 'by2', type: 'buy', symbol: 'XMR', qty: 0.1, total: 12, date: D, accountId: Y });
const single = mk({
  id: 'one', type: 'transfer', symbol: 'XMR', qty: 0.5, networkFee: 0.0001, date: '2025-03-02', accountId: X,
  sources: [{ accountId: X, qty: 0.5, fee: 0.0001 }], outputs: [{ toAccountId: Y, qty: 0.4999, spend: false }]
});
assert.equal(C.isValidImportTrade(tr, [X, Y], accounts), true, 'the two-source transfer is valid');
const initial = () => [bx, by0, by1, tr, by2, single].map(t => JSON.parse(JSON.stringify(t)));

// --- 1. The grip renders under every account the record appears under -------
const hasGrip = (t, scope) => {
  const box = C.tradeBlock(t, 'EUR', id => id, undefined, null, {}, scope);
  return box.children.some(c => c && c.className === 'drag-handle');
};
assert.equal(hasGrip(tr, [X]), true, 'grip on the account it was created from');
assert.equal(hasGrip(tr, [Y]), true, 'grip on the account it only propagates to');
assert.equal(hasGrip(tr, [X, Y]), true, 'grip when both accounts are in scope');
assert.equal(hasGrip(single, [Y]), true, 'single-source transfer keeps its grip on the recipient');
assert.equal(hasGrip(by1, [Y]), true, 'plain record keeps its grip');

// --- 2. The reorder scope is exactly what the account's list shows ----------
assert.equal(C.tradeInReorderScope(tr, Y, D), true);
assert.equal(C.tradeInReorderScope(by1, Y, D), true);
assert.equal(C.tradeInReorderScope(by1, X, D), false, 'a record of another account is not in scope');
assert.equal(C.tradeInReorderScope(tr, X, D), true);
assert.equal(C.tradeInReorderScope(single, Y, D), false, 'other dates are never in scope');
const listedInY = C.accountTrades({ trades: initial() }, Y).filter(t => t.date === D).map(t => t.id);
assert.deepEqual(Array.from(listedInY), ['by1', 'tr', 'by2'], 'the list for Y on D');
assert.deepEqual(Array.from(initial().filter(t => C.tradeInReorderScope(t, Y, D)).map(t => t.id)), ['by1', 'tr', 'by2'], 'scope matches the list');

// --- 3. Pointer drags from the non-primary account --------------------------
function session(viewAccount) {
  let state = { accounts: accounts.map(a => Object.assign({}, a)), trades: initial(), settings: { mainCurrency: 'EUR', costMethod: 'average' } };
  const cards = {};
  const listeners = {};
  const host = {
    attrs: { 'data-view-account': viewAccount },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelector(sel) { const m = /data-trade="([^"]*)"/.exec(sel); return m ? (cards[m[1]] || null) : null; },
    querySelectorAll() { return []; }
  };
  ['by1', 'tr', 'by2'].forEach(id => {
    const card = fakeEl('article');
    card.setAttribute('data-trade', id);
    card.closest = sel => (sel === '.trade-block' ? card : null);
    card.getBoundingClientRect = () => ({ top: 0, height: 100, left: 0, width: 300 });
    const grip = { closest: sel => (sel === '.drag-handle' ? grip : (sel === '.trade-block' ? card : null)) };
    card.grip = grip;
    cards[id] = card;
  });
  const banners = [];
  C.loadState = () => state;
  C.saveStateGuarded = st => { state = st; return true; };
  C.render = noop;
  C.showBanner = m => { banners.push(m); };
  C.clearBanner = noop;
  C.document.getElementById = id => (id === 'account-detail' ? host : null);
  vm.runInContext('tradeDrag = null;', C); // fresh drag state
  C.wireTradeDnDEvents(host);
  const drag = (fromId, overId, clientY) => {
    const under = { closest: sel => (sel === '.trade-block' ? cards[overId] : null) };
    C.document.elementFromPoint = () => under;
    listeners.pointerdown({ target: cards[fromId].grip, pointerType: 'mouse', button: 0, clientX: 10, clientY: 50, pointerId: 1 });
    listeners.pointermove({ clientX: 40, clientY: clientY, pointerId: 1 });
    listeners.pointerup({ clientX: 40, clientY: clientY, pointerId: 1 });
  };
  const order = () => state.trades.filter(t => t.date === D).map(t => t.id);
  return { drag, order, banners, state: () => state };
}

// Displayed from Y: [by2, tr, by1] (top = latest). Drop tr ABOVE by2 so it
// books later in the day: execution order becomes [by1, by2, tr], all funded.
let s = session(Y);
assert.deepEqual(s.order(), ['by1', 'tr', 'by2']);
s.drag('tr', 'by2', 10);
assert.deepEqual(s.order(), ['by1', 'by2', 'tr'], 'the transfer moved among Y\'s same-date records');
assert.equal(s.banners.length, 0, 'an allowed move raises no banner');
assert.equal(s.state().trades.length, 6, 'no record is lost or duplicated');
assert.deepEqual(Array.from(s.state().trades.filter(t => t.date !== D).map(t => t.id)), ['bx', 'by0', 'one'], 'other dates keep their place');

// Drop tr BELOW by1 so it books before by1: Y would send 1.5 while holding
// only 0.5, so the failsafe refuses and nothing changes.
s = session(Y);
s.drag('tr', 'by1', 90);
assert.deepEqual(s.order(), ['by1', 'tr', 'by2'], 'a move that would spend missing funds is refused');
assert.equal(s.banners.length, 1, 'the refusal is explained');

// A record of Y can also be dragged past the transfer (used to snap back
// silently: the transfer was not part of its primary account's records).
s = session(Y);
s.drag('by2', 'tr', 90);
assert.deepEqual(s.order(), ['by1', 'by2', 'tr'], 'a Y record moved below the transfer in the list');

// Dropping a record onto itself changes nothing.
s = session(Y);
s.drag('tr', 'tr', 10);
assert.deepEqual(s.order(), ['by1', 'tr', 'by2']);

console.log('transfer grip / reorder-from-any-account checks passed');
