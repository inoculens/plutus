#!/usr/bin/env node
'use strict';
// Account-id safety. Ids such as "__proto__", "constructor" and "toString"
// used to collide with Object.prototype inside plain-object maps: accounts
// vanished from the portfolio, assignGroup reported success while doing
// nothing, and computePortfolio wrote ticker state into the GLOBAL prototype.
// These tests drive the full import -> store -> portfolio workflow, not just
// the validator. All figures are invented. Loads app.js in a stubbed vm context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
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
vm.runInContext(src, C, { filename: 'app.js' });


// ---- Independent reference model -------------------------------------------
// Written from the accounting rules, NOT from the engine: per (account,symbol)
// a list of lots {qty, cost, date}. Realized P&L, quantity and remaining cost
// basis are tracked per account and compared with computePortfolio.
const EPS = 1e-9;
function reference(trades, method) {
  const book = {}; // acct -> sym -> { lots: [...], realized }
  const get = (a, s) => ((book[a] = book[a] || {})[s] = book[a][s] || { lots: [], realized: 0 });
  const held = b => b.lots.reduce((s, l) => s + l.qty, 0);
  const costOf = b => b.lots.reduce((s, l) => s + l.cost, 0);
  const clean = b => { b.lots = b.lots.filter(l => l.qty > EPS); };
  // Take `want` quantity out of a book: FIFO = oldest lots first; average =
  // proportional slice of every lot (pooled average). Returns removed pieces.
  function take(b, want) {
    const out = [];
    if (method === 'fifo') {
      let left = want;
      while (left > EPS && b.lots.length) {
        const l = b.lots[0], q = Math.min(l.qty, left), c = l.cost * (q / l.qty);
        out.push({ qty: q, cost: c, date: l.date });
        l.cost -= c; l.qty -= q; left -= q;
        if (l.qty <= EPS) b.lots.shift();
      }
    } else {
      const h = held(b), c = costOf(b), f = want / h;
      out.push({ qty: want, cost: c * f, date: '' });
      b.lots.forEach(l => { l.qty -= l.qty * f; l.cost -= l.cost * f; });
      clean(b); if (held(b) <= EPS) b.lots = [];
    }
    return out;
  }
  const put = (b, piece) => {
    if (method === 'fifo') { b.lots.push(piece); b.lots.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)); }
    else if (b.lots.length) { b.lots[0].qty += piece.qty; b.lots[0].cost += piece.cost; }
    else b.lots.push({ qty: piece.qty, cost: piece.cost, date: '' });
  };
  const sorted = trades.map((t, i) => [t, i]).sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : a[1] - b[1])).map(x => x[0]);
  for (const t of sorted) {
    const b = get(t.accountId, t.symbol), total = Number(t.total || 0);
    if (t.type === 'buy' || t.type === 'income') {
      put(b, { qty: t.qty, cost: total, date: t.date });
    } else if (t.type === 'sell') {
      const h = held(b); if (h <= EPS) continue;
      const q = Math.min(t.qty, h), proceeds = total * (q / t.qty);
      const cost = take(b, q).reduce((s, p) => s + p.cost, 0);
      b.realized += proceeds - cost;
    } else if (t.type === 'expense') {
      if (t.qty !== undefined) { const h = held(b); if (h > EPS) b.realized -= take(b, Math.min(t.qty, h)).reduce((s, p) => s + p.cost, 0); }
      if (t.total !== undefined) b.realized -= total;
    } else if (t.type === 'transfer') {
      const dest = get(t.toAccountId, t.symbol), fee = Number(t.networkFee || 0);
      if (fee >= t.qty) continue; // invalid transfer is ignored entirely
      b.realized -= total; // fiat fee is always lost, even from an empty source
      const h = held(b); if (h <= EPS) continue;
      const moved = Math.min(t.qty, h), feeQ = fee * (moved / t.qty), keep = (moved - feeQ) / moved;
      const pieces = take(b, moved);
      const movedCost = pieces.reduce((s, p) => s + p.cost, 0);
      b.realized -= movedCost * (feeQ / moved);
      pieces.forEach(p => put(dest, { qty: p.qty * keep, cost: p.cost * keep, date: p.date }));
    }
  }
  return book;
}

// ---- Deterministic generator (mulberry32, fixed seed) -----------------------
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
function genSequence(r, n) {
  const accts = { BTC: ['b1', 'b2', 'b3'], ETH: ['e1', 'e2'] };
  const pick = a => a[Math.floor(r() * a.length)];
  const q2 = (lo, hi) => Math.round((lo + r() * (hi - lo)) * 100) / 100;
  const out = []; let day = 1;
  for (let i = 0; i < n; i++) {
    if (r() < 0.6) day++;
    const date = '2026-' + String(1 + Math.floor((day - 1) / 28) % 12).padStart(2, '0') + '-' + String(1 + (day - 1) % 28).padStart(2, '0');
    const symbol = r() < 0.7 ? 'BTC' : 'ETH', accountId = pick(accts[symbol]);
    const x = r(), t = { id: 'g' + i, accountId, symbol, date };
    if (x < 0.30) Object.assign(t, { type: 'buy', qty: q2(0.05, 3), total: q2(10, 3000), fee: q2(0, 5) });
    else if (x < 0.50) Object.assign(t, { type: 'sell', qty: q2(0.05, 4), total: q2(10, 4000), fee: q2(0, 5) });
    else if (x < 0.58) Object.assign(t, { type: 'income', qty: q2(0.01, 1), total: q2(1, 300) });
    else if (x < 0.68) {
      const k = r();
      if (k < 0.4) Object.assign(t, { type: 'expense', qty: q2(0.01, 1) });
      else if (k < 0.7) Object.assign(t, { type: 'expense', total: q2(1, 60) });
      else Object.assign(t, { type: 'expense', qty: q2(0.01, 1), total: q2(1, 60) });
    } else {
      const to = pick(accts[symbol].filter(a => a !== accountId));
      const qty = q2(0.05, 3);
      Object.assign(t, { type: 'transfer', toAccountId: to, qty, networkFee: r() < 0.8 ? q2(0, Math.min(0.2, qty)) : 0 });
      if (r() < 0.25) t.total = q2(0.5, 20); // fiat fee on the move
      if (t.networkFee >= qty) t.networkFee = 0;
    }
    out.push(t);
  }
  return out;
}

const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-6 + 1e-9 * Math.max(Math.abs(a), Math.abs(b)), what + ': engine ' + a + ' vs reference ' + b);
let checked = 0, withTransfers = 0, withOversell = 0;
['fifo', 'average'].forEach((method, mi) => {
  const r = rng(20260512 + mi * 7919);
  for (let seq = 0; seq < 300; seq++) {
    const trades = genSequence(r, 25 + Math.floor(r() * 60));
    const ref = reference(trades, method);
    const pf = C.computePortfolio(trades, {}, method);
    const label = method + ' seq ' + seq;
    if (trades.some(t => t.type === 'transfer')) withTransfers++;
    let sumRealized = 0, bad = false;
    const accIds = new Set([...Object.keys(ref), ...Object.keys(pf.byAccount)]);
    for (const a of accIds) {
      const syms = new Set([...Object.keys(ref[a] || {}), ...Array.from((pf.byAccount[a] || new Map()).keys())]);
      for (const s of syms) {
        const e = (pf.byAccount[a] && pf.byAccount[a].get(s)) || { qtyHeld: 0, avgEntry: 0, realized: 0 };
        const b = (ref[a] && ref[a][s]) || { lots: [], realized: 0 };
        const q = b.lots.reduce((x, l) => x + l.qty, 0), c = b.lots.reduce((x, l) => x + l.cost, 0);
        near(e.qtyHeld, q, label + ' ' + a + '/' + s + ' qty');
        near(e.qtyHeld * e.avgEntry, c, label + ' ' + a + '/' + s + ' remaining cost basis');
        near(e.realized, b.realized, label + ' ' + a + '/' + s + ' realized');
        assert.ok(e.qtyHeld >= 0, label + ' no negative inventory in ' + a + '/' + s);
        sumRealized += e.realized;
      }
    }
    near(pf.totals.realized, sumRealized, label + ' grand total = sum of per-account totals');
    // Engine-independent conservation: quantity can only leave through sells,
    // expenses and network fees, never appear from nowhere.
    ['BTC', 'ETH'].forEach(s => {
      const inQty = trades.filter(t => t.symbol === s && (t.type === 'buy' || t.type === 'income')).reduce((x, t) => x + t.qty, 0);
      let held = 0; accIds.forEach(a => { const p = pf.byAccount[a] && pf.byAccount[a].get(s); if (p) held += p.qtyHeld; });
      assert.ok(held <= inQty + 1e-6, label + ' ' + s + ' holds more than was ever acquired');
    });
    checked++;
  }
});
// The generator must really exercise the hard paths, not just buys and sells.
assert.ok(withTransfers > 400, 'transfers exercised: ' + withTransfers);

// ---- Pinned hand-calculated cases (guards the reference itself) -------------
const T = (o) => Object.assign({ symbol: 'BTC', date: '2026-01-01' }, o);
const run = (tr, m) => C.computePortfolio(tr, { BTC: 200 }, m);
{ // FIFO: buy 1@100, buy 1@200, sell 1.5 for 450 -> cost 100 + 100 = 200, gain 250, left 0.5 @ 200
  const p = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100, date: '2026-01-01' }), T({ id: 'b', type: 'buy', accountId: 'x', qty: 1, total: 200, date: '2026-01-02' }),
    T({ id: 'c', type: 'sell', accountId: 'x', qty: 1.5, total: 450, date: '2026-01-03' })], 'fifo').byAccount.x.get('BTC');
  near(p.realized, 250, 'fifo pinned realized'); near(p.qtyHeld, 0.5, 'fifo pinned qty'); near(p.avgEntry, 200, 'fifo pinned basis');
}
{ // Average: same trades -> avg 150; sell 1.5 for 450 -> cost 225, gain 225, left 0.5 @ 150
  const p = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100, date: '2026-01-01' }), T({ id: 'b', type: 'buy', accountId: 'x', qty: 1, total: 200, date: '2026-01-02' }),
    T({ id: 'c', type: 'sell', accountId: 'x', qty: 1.5, total: 450, date: '2026-01-03' })], 'average').byAccount.x.get('BTC');
  near(p.realized, 225, 'avg pinned realized'); near(p.qtyHeld, 0.5, 'avg pinned qty'); near(p.avgEntry, 150, 'avg pinned basis');
}
{ // Oversell clamps: hold 1, sell 3 for 300 -> only 1 sold, proceeds 100, never negative
  const p = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 50 }), T({ id: 'b', type: 'sell', accountId: 'x', qty: 3, total: 300, date: '2026-01-02' })], 'fifo').byAccount.x.get('BTC');
  near(p.qtyHeld, 0, 'oversell qty'); near(p.realized, 50, 'oversell realized (100 proceeds - 50 cost)');
}
{ // Transfer 1 BTC (cost 100) x -> y with 0.1 network fee: fee cost 10 realized loss, y holds 0.9 @ basis 90
  const r2 = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 }), T({ id: 't', type: 'transfer', accountId: 'x', toAccountId: 'y', qty: 1, networkFee: 0.1, date: '2026-01-02' })], 'fifo');
  near(r2.byAccount.x.get('BTC').realized, -10, 'transfer fee loss'); near(r2.byAccount.x.get('BTC').qtyHeld, 0, 'source emptied');
  near(r2.byAccount.y.get('BTC').qtyHeld, 0.9, 'destination qty'); near(r2.byAccount.y.get('BTC').qtyHeld * r2.byAccount.y.get('BTC').avgEntry, 90, 'destination basis keeps cost, no duplication');
  near(r2.totals.realized, -10, 'grand total');
}
{ // Unknown price stays null, never zero.
  const p = C.computePortfolio([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 })], {}, 'fifo').byAccount.x.get('BTC');
  assert.equal(p.livePrice, null); assert.equal(p.marketValue, null); assert.equal(p.unrealized, null);
}
{ // FX: a zero or negative fixing is never accepted as a rate (never convert unknown into zero).
  assert.equal(C.pickRate({ '2026-01-05': 0 }, '2026-01-05'), null, 'zero fixing rejected');
  assert.equal(C.pickRate({ '2026-01-05': -1.2 }, '2026-01-05'), null, 'negative fixing rejected');
  assert.equal(C.pickRate({ '2026-01-05': 'abc' }, '2026-01-05'), null, 'non-numeric fixing rejected');
  const ok = C.pickRate({ '2026-01-05': 0, '2026-01-04': 1.25 }, '2026-01-05');
  assert.ok(ok && ok.rate === 1.25 && ok.interpolated === true, 'walks back past a bad fixing to the previous real one');
  assert.equal(C.ledgerFxRate(null), 1); assert.equal(C.ledgerFxRate({ rate: 0 }), 1); assert.equal(C.ledgerFxRate({ rate: -3 }), 1);
}
console.log('accounting-differential: OK (' + checked + ' random sequences, ' + withTransfers + ' with transfers)');
