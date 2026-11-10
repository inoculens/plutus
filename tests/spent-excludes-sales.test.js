#!/usr/bin/env node
'use strict';
// A sale (or either leg of a swap, which is stored as a linked sell + buy) turns
// one holding into fiat or another asset: it is not spending. Neither the home
// SPENT AMOUNT line nor the per-account "Spent amount" pill may count sell
// proceeds, while real spending (expenses) keeps counting. The sale shows up in
// Realized instead, and Average entry stays the cost per unit still held.
// All figures are invented. Loads app.js in a stubbed vm context with a minimal
// fake DOM.
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
  t.querySelector = () => fakeEl('div');
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
C.render = noop;
C.updateNetWorthHistory = noop;

const fx = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const mk = o => Object.assign({ total: 0, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '', fxLock: fx, createdAt: '2025-01-01T00:00:00Z' }, o);
const X = 'accX', Y = 'accY';
const accounts = [
  { id: X, name: 'Monero', ticker: 'XMR', kind: 'crypto' },
  { id: Y, name: 'Litecoin', ticker: 'LTC', kind: 'crypto' }
];
const settings = { mainCurrency: 'EUR', costMethod: 'average' };

const buy = mk({ id: 'b1', type: 'buy', symbol: 'XMR', qty: 3, total: 300, date: '2025-02-01', accountId: X });
const sell = mk({ id: 's1', type: 'sell', symbol: 'XMR', qty: 1, total: 150, date: '2025-02-10', accountId: X });
// A swap is stored as two linked legs: a sell in the source and a buy in the target.
const swapSell = mk({ id: 'sw-s', type: 'sell', symbol: 'XMR', qty: 1, total: 200, date: '2025-02-20', accountId: X, swapId: 'sw1' });
const swapBuy = mk({ id: 'sw-b', type: 'buy', symbol: 'LTC', qty: 4, total: 200, date: '2025-02-20', accountId: Y, swapId: 'sw1' });
const expense = mk({ id: 'e1', type: 'expense', symbol: 'XMR', total: 25, date: '2025-02-25', accountId: X });

// The per-account pill: the data-value of the rendered "Spent amount" line, or
// null when the account has no spending and the line is not rendered at all.
function accountSpent(trades, accountId) {
  const host = fakeEl('div');
  C.document.getElementById = id => (id === 'account-detail' ? host : null);
  C.renderAccountDetail({ accounts: accounts.map(a => Object.assign({}, a)), trades: trades.map(t => JSON.parse(JSON.stringify(t))), settings: Object.assign({}, settings) }, accountId);
  const found = [];
  (function walk(n) {
    if (!n || !n.children) return;
    n.children.forEach(c => { if (c && c.className === 'spent-line') found.push(c); walk(c); });
  })(host);
  assert.ok(found.length <= 1, 'at most one Spent amount line per account');
  return found.length ? Number(found[0].getAttribute('data-value')) : null;
}

// The home SPENT AMOUNT line text for a whole portfolio.
function homeSpent(trades) {
  const hero = fakeEl('p');
  const els = { 'hero-spent': hero, 'summary-cards': fakeEl('div') };
  C.document.getElementById = id => els[id] || null;
  const st = { accounts: accounts.map(a => Object.assign({}, a)), trades: trades.map(t => JSON.parse(JSON.stringify(t))), settings: Object.assign({}, settings) };
  const rows = [{ symbol: 'XMR', qtyHeld: 1, marketValue: null, unrealized: null, realized: 0, totalPL: 0 }];
  C.renderSummaryCards(st, rows, C.convertTrades(st.trades, 'EUR'), accounts.length, st.accounts);
  return String(hero.textContent);
}
const digits = s => Number(String(s).replace(/[^0-9.]/g, ''));

// --- 1. A plain sale is not spending --------------------------------------
assert.equal(accountSpent([buy, sell], X), null, 'a sale alone leaves the account Spent amount empty');
assert.equal(digits(homeSpent([buy, sell])), 0, 'a sale alone leaves the home SPENT AMOUNT at zero');

// --- 2. Either leg of a swap is not spending ------------------------------
assert.equal(accountSpent([buy, swapSell, swapBuy], X), null, 'the swap sell leg is not spending (source account)');
assert.equal(accountSpent([buy, swapSell, swapBuy], Y), null, 'the swap buy leg is not spending (target account)');
assert.equal(digits(homeSpent([buy, swapSell, swapBuy])), 0, 'a swap leaves the home SPENT AMOUNT at zero');

// --- 3. Real spending still counts, and only it ---------------------------
assert.equal(accountSpent([buy, sell, swapSell, swapBuy, expense], X), 25, 'only the expense counts in the account');
assert.equal(digits(homeSpent([buy, sell, swapSell, swapBuy, expense])), 25, 'only the expense counts on the home');

console.log('spent-excludes-sales: ok');
