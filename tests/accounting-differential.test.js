#!/usr/bin/env node
'use strict';
// Differential accounting test. An independent reference model (written from
// the accounting rules, not from the engine) is run against computePortfolio
// over seeded random sequences of buys, sells (with fees), income, expenses,
// transfers and swaps, in both cost methods. All figures are invented.
// Loads app.js in a stubbed vm context.
//
// FEE SEMANTICS (read from the application, implemented independently below):
//  * buy/sell `total` is ALL-IN: the fee is inside it. `fee` never changes cost basis,
//    proceeds, realized P&L or quantity; it is a display-only tally per account/symbol and in
//    totals.feesFiat, converted at the trade's fxLock rate (fee 5 at rate 1.1 tallies 5.5).
//  * A sell with nothing held is ignored by the engine (no realized P&L, no fee tally). The app
//    refuses to create one: validateTrade() / heldTimelineConflict() answer "oversell".
//  * There is no asset-denominated fee on buy/sell. The asset-denominated fee is `networkFee` on
//    transfers: it reduces the quantity that arrives, the destination keeps the moved cost
//    pro-rata minus the fee share, and the fee share's cost is a realized loss at the source.
//    A fiat `total` on a transfer is a fee that is always lost (realized).
//  * A swap is two ordinary legs (sell + buy, shared swapId); each leg follows the rules above.
//  * Quantities in generated sequences are exact binary fractions, so holdings carry no float
//    residue. Production float residue (observed for 18-decimal symbols, whose epsilon is 0,
//    after transfer splitting) is tolerated for fee tallies ONLY through residualFeeAllowance().
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
// Residual tolerance (units: relative to the largest single quantity moved in that
// account/symbol, so it scales with the position). Float error per operation is ~1e-16
// relative; 1e-12 leaves room for ~10^4 operations. Money tolerance is separate (near()).
const RESIDUAL_REL = 1e-12;
// Fee allowance for a sell the reference ignored because it holds nothing. It is granted ONLY
// when the engine's actual quantity immediately before that sell is a positive residual within
// RESIDUAL_REL of the position scale. An exactly-empty or genuinely funded position gets none.
function residualFeeAllowance(sorted, b, a, s, method) {
  let allowed = 0;
  for (const ig of b.ignored || []) {
    const before = C.computePortfolio(sorted.slice(0, ig.n), {}, method);
    const pos = before.byAccount[a] && before.byAccount[a].get(s);
    const resid = pos ? pos.qtyHeld : 0;
    const scale = Math.max(...sorted.slice(0, ig.n).filter(t => t.symbol === s && (t.accountId === a || t.toAccountId === a)).map(t => Number(t.qty) || 0), 1);
    if (resid > 0 && resid <= RESIDUAL_REL * scale) allowed += ig.fee;
  }
  return allowed;
}
function reference(trades, method) {
  // Fee rule (app semantics): a buy/sell `total` is ALL-IN. The fee is already
  // inside it, so it never changes cost basis, proceeds or realized P&L; it is
  // only tallied (display-only) per account/symbol. A buy/income with a valid
  // qty always tallies its fee; a sell tallies it only when inventory exists to
  // sell (a sell with nothing held is ignored entirely, fee included).
  const book = {}; // acct -> sym -> { lots: [...], realized, fees }
  const get = (a, s) => ((book[a] = book[a] || {})[s] = book[a][s] || { lots: [], realized: 0, fees: 0 });
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
  const sortedIndex = new Map(sorted.map((t, i) => [t, i]));
  Object.defineProperty(book, '__sorted', { value: sorted, enumerable: false });
  for (const t of sorted) {
    const b = get(t.accountId, t.symbol), total = Number(t.total || 0);
    const fee = Number(t.fee || 0);
    if (t.type === 'buy' || t.type === 'income') {
      if (!(t.qty > 0)) continue;
      b.fees += fee;
      put(b, { qty: t.qty, cost: total, date: t.date });
    } else if (t.type === 'sell') {
      const h = held(b);
      if (h <= EPS) { (b.ignored = b.ignored || []).push({ n: sortedIndex.get(t), fee }); continue; }
      b.fees += fee;
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
      const h = held(b);
      if (h <= EPS) continue;
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
  const q2 = (lo, hi) => Math.round((lo + r() * (hi - lo)) * 100) / 100; // money: 2 decimals
  // Quantities are multiples of 1/1024 (exact binary fractions): sums and differences are exact, so no
  // floating-point residue can appear in holdings and NO dust tolerance is needed or allowed anywhere.
  const qd = (lo, hi) => Math.round((lo + r() * (hi - lo)) * 1024) / 1024;
  const out = []; let day = 1;
  for (let i = 0; i < n; i++) {
    if (r() < 0.6) day++;
    const date = '2026-' + String(1 + Math.floor((day - 1) / 28) % 12).padStart(2, '0') + '-' + String(1 + (day - 1) % 28).padStart(2, '0');
    const symbol = r() < 0.7 ? 'BTC' : 'ETH', accountId = pick(accts[symbol]);
    const x = r(), t = { id: 'g' + i, accountId, symbol, date };
    if (x > 0.93) { // swap: a sell leg and a buy leg of another symbol, same account and date, shared swapId
      const other = symbol === 'BTC' ? 'ETH' : 'BTC', sid = 'sw' + i;
      out.push({ id: 'g' + i + 's', accountId, symbol, date, type: 'sell', qty: qd(0.05, 3), total: q2(10, 3000), fee: q2(0, 5), swapId: sid });
      out.push({ id: 'g' + i + 'b', accountId, symbol: other, date, type: 'buy', qty: qd(0.05, 3), total: q2(10, 3000), swapId: sid });
      continue;
    }
    if (x < 0.30) Object.assign(t, { type: 'buy', qty: qd(0.05, 3), total: q2(10, 3000), fee: q2(0, 5) });
    else if (x < 0.50) Object.assign(t, { type: 'sell', qty: qd(0.05, 4), total: q2(10, 4000), fee: q2(0, 5) });
    else if (x < 0.58) Object.assign(t, { type: 'income', qty: qd(0.01, 1), total: q2(1, 300), fee: r() < 0.5 ? q2(0, 1) : 0 });
    else if (x < 0.68) {
      const k = r();
      if (k < 0.4) Object.assign(t, { type: 'expense', qty: qd(0.01, 1) });
      else if (k < 0.7) Object.assign(t, { type: 'expense', total: q2(1, 60) });
      else Object.assign(t, { type: 'expense', qty: qd(0.01, 1), total: q2(1, 60) });
    } else {
      const to = pick(accts[symbol].filter(a => a !== accountId));
      const qty = qd(0.05, 3);
      Object.assign(t, { type: 'transfer', toAccountId: to, qty, networkFee: r() < 0.8 ? qd(0, Math.min(0.2, qty)) : 0 });
      if (r() < 0.25) t.total = q2(0.5, 20); // fiat fee on the move
      if (t.networkFee >= qty) t.networkFee = 0;
    }
    out.push(t);
  }
  return out;
}

const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-6 + 1e-9 * Math.max(Math.abs(a), Math.abs(b)), what + ': engine ' + a + ' vs reference ' + b);
let checked = 0, withTransfers = 0, withSwaps = 0, withFees = 0, withResidual = 0;
['fifo', 'average'].forEach((method, mi) => {
  const r = rng(20260512 + mi * 7919);
  for (let seq = 0; seq < 300; seq++) {
    const trades = genSequence(r, 25 + Math.floor(r() * 60));
    try {
    const ref = reference(trades, method);
    const pf = C.computePortfolio(trades, {}, method);
    const label = method + ' seq ' + seq;
    if (trades.some(t => t.type === 'transfer')) withTransfers++;
    if (trades.some(t => t.swapId)) withSwaps++;
    if (trades.some(t => t.fee > 0)) withFees++;
    let sumRealized = 0, sumFees = 0, sumFeeRef = 0, sumAllow = 0;
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
        const ef = e.fees || 0;
        // Strict: an empty-inventory sell must not tally its fee. The only exception is a sell that
        // the engine saw funded by a genuine float residual (see residualFeeAllowance).
        const allow = Math.abs(ef - b.fees) > 1e-6 ? residualFeeAllowance(ref.__sorted, b, a, s, method) : 0;
        near(ef, b.fees + allow, label + ' ' + a + '/' + s + ' fees tally');
        sumFees += ef; sumFeeRef += b.fees || 0; sumAllow += allow;
        assert.ok(e.qtyHeld >= 0, label + ' no negative inventory in ' + a + '/' + s);
        sumRealized += e.realized;
      }
    }
    near(pf.totals.realized, sumRealized, label + ' grand total = sum of per-account totals');
    if (sumAllow > 0) withResidual++;
    near(pf.totals.feesFiat, sumFeeRef + sumAllow, label + ' total fees = reference fee tally (+ residual-funded sells)');
    near(pf.totals.feesFiat, sumFees, label + ' total fees = sum of per-position fees');
    // Metamorphic: fees are inside the all-in total, so removing every fee must
    // not change quantity, cost basis or realized P&L anywhere.
    const nofee = C.computePortfolio(trades.map(t => { const c = Object.assign({}, t); delete c.fee; return c; }), {}, method);
    near(nofee.totals.realized, pf.totals.realized, label + ' realized is fee-independent');
    for (const a of Object.keys(pf.byAccount)) pf.byAccount[a].forEach((e, sym) => {
      const z = nofee.byAccount[a].get(sym);
      near(z.qtyHeld, e.qtyHeld, label + ' qty fee-independent'); near(z.qtyHeld * z.avgEntry, e.qtyHeld * e.avgEntry, label + ' basis fee-independent');
    });
    // Engine-independent conservation: quantity can only leave through sells,
    // expenses and network fees, never appear from nowhere.
    ['BTC', 'ETH'].forEach(s => {
      const inQty = trades.filter(t => t.symbol === s && (t.type === 'buy' || t.type === 'income')).reduce((x, t) => x + t.qty, 0);
      let held = 0; accIds.forEach(a => { const p = pf.byAccount[a] && pf.byAccount[a].get(s); if (p) held += p.qtyHeld; });
      assert.ok(held <= inQty + 1e-6, label + ' ' + s + ' holds more than was ever acquired');
    });
    checked++;
    } catch (e) {
      // Reproduce with: seed = 20260512 + methodIndex * 7919, generate sequences in order up to `seq`.
      console.error('--- failing sequence: method=' + method + ' seq=' + seq + ' seed=' + (20260512 + mi * 7919) + '\n' +
        trades.map(t => JSON.stringify(t)).join('\n'));
      throw e;
    }
  }
});
// The generator must really exercise the hard paths, not just buys and sells.
assert.ok(withTransfers > 400, 'transfers exercised: ' + withTransfers);
assert.ok(withSwaps > 400, 'swaps exercised: ' + withSwaps);
assert.ok(withFees > 500, 'fees exercised: ' + withFees);

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
{ // Fees are all-in: buy 1 @ total 100 (fee 5) keeps basis 100; sell 1 for 150 (fee 3) realizes 50; fees tally 8, never reduce proceeds.
  ['fifo', 'average'].forEach(m => {
    const r3 = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100, fee: 5 }), T({ id: 'b', type: 'sell', accountId: 'x', qty: 1, total: 150, fee: 3, date: '2026-01-02' })], m);
    const p = r3.byAccount.x.get('BTC');
    near(p.realized, 50, m + ' fee pinned realized (fee not deducted twice)'); near(p.fees, 8, m + ' fee pinned tally'); near(r3.totals.feesFiat, 8, m + ' fee pinned total');
    const q = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100, fee: 5 })], m).byAccount.x.get('BTC');
    near(q.avgEntry, 100, m + ' fee pinned basis stays at the all-in total');
  });
  // A sell with nothing held is ignored entirely, fee included.
  const none = run([T({ id: 's', type: 'sell', accountId: 'x', qty: 1, total: 150, fee: 3 })], 'fifo');
  near(none.totals.feesFiat, 0, 'ignored sell contributes no fee'); near(none.totals.realized, 0, 'ignored sell realizes nothing');
}
{ // Swap: sell 1 BTC (cost 100) for 300 + buy 3 ETH for 300 (shared swapId). BTC realizes 200 (fee 2 is inside), ETH basis 300.
  ['fifo', 'average'].forEach(m => {
    const r4 = C.computePortfolio([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 }),
      T({ id: 'sw1s', type: 'sell', accountId: 'x', qty: 1, total: 300, fee: 2, swapId: 'sw1', date: '2026-01-02' }),
      T({ id: 'sw1b', type: 'buy', accountId: 'x', symbol: 'ETH', qty: 3, total: 300, swapId: 'sw1', date: '2026-01-02' })], {}, m);
    near(r4.byAccount.x.get('BTC').realized, 200, m + ' swap realized'); near(r4.byAccount.x.get('BTC').qtyHeld, 0, m + ' swap sold leg qty');
    const eth = r4.byAccount.x.get('ETH'); near(eth.qtyHeld, 3, m + ' swap bought qty'); near(eth.qtyHeld * eth.avgEntry, 300, m + ' swap bought basis');
    near(r4.totals.realized, 200, m + ' swap grand total');
  });
}

// ---- Pinned fee cases (hand-calculated from the rules above; both cost methods) -------------
const both = (fn) => ['fifo', 'average'].forEach(fn);
const sellDraft = (qty, total, fee) => ({ id: 'draft', type: 'sell', accountId: 'x', symbol: 'BTC', qty, total, fee, date: '2026-02-01' });
both(m => { // 1. buy, then sell the entire position with a fee
  const r1 = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100, fee: 5 }), T({ id: 'b', type: 'sell', accountId: 'x', qty: 1, total: 150, fee: 3, date: '2026-01-02' })], m);
  const p = r1.byAccount.x.get('BTC');
  near(p.qtyHeld, 0, m + ' 1 qty'); near(p.realized, 50, m + ' 1 realized'); near(p.fees, 8, m + ' 1 fees'); near(r1.totals.feesFiat, 8, m + ' 1 total fees');
  // 2. same without fees
  const r2n = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 }), T({ id: 'b', type: 'sell', accountId: 'x', qty: 1, total: 150, date: '2026-01-02' })], m);
  near(r2n.byAccount.x.get('BTC').realized, 50, m + ' 2 realized'); near(r2n.totals.feesFiat, 0, m + ' 2 fees');
  // 3. sell again after inventory is empty with a nonzero fee: the app rejects it; if legacy data
  //    contains it anyway the engine ignores it entirely - the fee is NOT absorbed as dust.
  const booked = [T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100, fee: 5 }), T({ id: 'b', type: 'sell', accountId: 'x', qty: 1, total: 150, fee: 3, date: '2026-01-02' })];
  assert.equal(C.validateTrade(sellDraft(1, 150, 3), 0), 'oversell: max sellable is 0', m + ' 3 production validation');
  const conflict = C.heldTimelineConflict(booked, T(sellDraft(1, 150, 3)), null);
  assert.ok(conflict && conflict.shortfall > 0, m + ' 3 timeline conflict on a sell with nothing held');
  const legacy = run(booked.concat([T({ id: 'c', type: 'sell', accountId: 'x', qty: 1, total: 150, fee: 3, date: '2026-01-03' })]), m);
  near(legacy.byAccount.x.get('BTC').fees, 8, m + ' 3 empty-inventory fee is not tallied'); near(legacy.totals.feesFiat, 8, m + ' 3 total'); near(legacy.totals.realized, 50, m + ' 3 realized unchanged');
  // 4. sell slightly less than everything: a legitimate tiny residual (8-decimal BTC: 1e-8 left)
  const r4 = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 }), T({ id: 'b', type: 'sell', accountId: 'x', qty: 0.99999999, total: 99.999999, fee: 1, date: '2026-01-02' })], m);
  const rp = r4.byAccount.x.get('BTC');
  near(rp.qtyHeld, 1e-8, m + ' 4 residual kept'); near(rp.qtyHeld * rp.avgEntry, 1e-6, m + ' 4 residual basis'); near(rp.realized, 0, m + ' 4 realized');
  assert.equal(C.validateTrade(sellDraft(1e-8, 0.000002, 0.000001), rp.qtyHeld), null, m + ' 4 the residual itself is sellable');
  const r4b = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 }), T({ id: 'b', type: 'sell', accountId: 'x', qty: 0.99999999, total: 99.999999, fee: 1, date: '2026-01-02' }),
    T({ id: 'c', type: 'sell', accountId: 'x', qty: 1e-8, total: 0.000002, fee: 0.000001, date: '2026-01-03' })], m);
  near(r4b.byAccount.x.get('BTC').qtyHeld, 0, m + ' 4 residual sold'); near(r4b.byAccount.x.get('BTC').fees, 1.000001, m + ' 4 both fees tallied'); near(r4b.totals.realized, 1e-6, m + ' 4 residual realized');
  // 4b. 18-decimal asset: engine epsilon is 0, so a 1e-15 residual is real inventory
  const eth = [T({ id: 'a', type: 'buy', accountId: 'x', symbol: 'ETH', qty: 1, total: 2000 }), T({ id: 'b', type: 'sell', accountId: 'x', symbol: 'ETH', qty: 0.999999999999999, total: 1999, fee: 2, date: '2026-01-02' })];
  const re = C.computePortfolio(eth, { ETH: 2000 }, m).byAccount.x.get('ETH');
  assert.ok(re.qtyHeld > 0 && re.qtyHeld < 2e-15, m + ' 4b residual ' + re.qtyHeld);
  assert.equal(C.validateTrade({ type: 'sell', symbol: 'ETH', qty: re.qtyHeld, total: 0.000001 }, re.qtyHeld), null, m + ' 4b residual sellable');
  assert.equal(C.validateTrade({ type: 'sell', symbol: 'ETH', qty: re.qtyHeld * 2, total: 0.000001 }, re.qtyHeld), 'oversell: max sellable is ' + re.qtyHeld, m + ' 4b more than the residual is refused');
});
{ // 5/6. several partial sells with fees. buy A 2 @200 (100 each), buy B 2 @400 (200 each); sells: 1 for 150, 2 for 500, 1 for 250
  const buys = [T({ id: 'a', type: 'buy', accountId: 'x', qty: 2, total: 200, fee: 1, date: '2026-01-01' }), T({ id: 'b', type: 'buy', accountId: 'x', qty: 2, total: 400, fee: 1, date: '2026-01-02' })];
  const sells = [T({ id: 's1', type: 'sell', accountId: 'x', qty: 1, total: 150, fee: 2, date: '2026-01-03' }), T({ id: 's2', type: 'sell', accountId: 'x', qty: 2, total: 500, fee: 3, date: '2026-01-04' }), T({ id: 's3', type: 'sell', accountId: 'x', qty: 1, total: 250, fee: 1, date: '2026-01-05' })];
  // FIFO: s1 = 150-100 = 50; s2 = 500-(100+200) = 200; s3 = 250-200 = 50
  const f2 = run(buys.concat(sells.slice(0, 2)), 'fifo').byAccount.x.get('BTC');
  near(f2.realized, 250, 'fifo 5 after two sells'); near(f2.qtyHeld, 1, 'fifo 5 qty'); near(f2.avgEntry, 200, 'fifo 5 remaining basis is the newest lot');
  const f3 = run(buys.concat(sells), 'fifo'); near(f3.byAccount.x.get('BTC').realized, 300, 'fifo 5 all sold'); near(f3.byAccount.x.get('BTC').fees, 8, 'fifo 5 fees 1+1+2+3+1');
  // Average: pooled 150 each. s1 = 150-150 = 0; s2 = 500-300 = 200; s3 = 250-150 = 100
  const a2 = run(buys.concat(sells.slice(0, 2)), 'average').byAccount.x.get('BTC');
  near(a2.realized, 200, 'avg 6 after two sells'); near(a2.qtyHeld, 1, 'avg 6 qty'); near(a2.avgEntry, 150, 'avg 6 pooled basis');
  const a3 = run(buys.concat(sells), 'average'); near(a3.byAccount.x.get('BTC').realized, 300, 'avg 6 all sold'); near(a3.byAccount.x.get('BTC').fees, 8, 'avg 6 fees');
}
both(m => { // 7. asset-denominated fee = networkFee on a transfer; 9. then a sale at the destination
  const base = [T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 }), T({ id: 't', type: 'transfer', accountId: 'x', toAccountId: 'y', qty: 1, networkFee: 0.1, date: '2026-01-02' })];
  const r7 = run(base, m);
  near(r7.byAccount.y.get('BTC').qtyHeld, 0.9, m + ' 7 arrives net of the fee'); near(r7.byAccount.y.get('BTC').qtyHeld * r7.byAccount.y.get('BTC').avgEntry, 90, m + ' 7 basis net of the fee share');
  near(r7.byAccount.x.get('BTC').realized, -10, m + ' 7 fee share cost is a realized loss');
  const r9 = run(base.concat([T({ id: 's', type: 'sell', accountId: 'y', qty: 0.9, total: 120, fee: 2, date: '2026-01-03' })]), m);
  near(r9.byAccount.y.get('BTC').realized, 30, m + ' 9 sale at destination: 120 - 90'); near(r9.byAccount.y.get('BTC').fees, 2, m + ' 9 sale fee tally'); near(r9.totals.realized, 20, m + ' 9 grand total = -10 + 30');
  // fiat fee on the transfer is always lost
  const r7f = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 }), T({ id: 't', type: 'transfer', accountId: 'x', toAccountId: 'y', qty: 1, total: 4, date: '2026-01-02' })], m);
  near(r7f.byAccount.x.get('BTC').realized, -4, m + ' 7 fiat transfer fee is lost'); near(r7f.byAccount.y.get('BTC').qtyHeld, 1, m + ' 7 full quantity arrives');
  // 8. fee in another currency: trades in EUR locked at 1.1 into the main currency
  const lock = { rate: 1.1 };
  const r8 = run([T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100, fee: 5, currency: 'EUR', fxLock: lock }),
    T({ id: 'b', type: 'sell', accountId: 'x', qty: 1, total: 150, fee: 3, currency: 'EUR', fxLock: lock, date: '2026-01-02' })], m);
  near(r8.byAccount.x.get('BTC').realized, 55, m + ' 8 (150-100) x 1.1'); near(r8.byAccount.x.get('BTC').fees, 8.8, m + ' 8 fee tally converted'); near(r8.totals.feesFiat, 8.8, m + ' 8 total');
  // 10. swap with fees on both legs: sell leg 1 BTC (cost 100) for 300 fee 2, buy leg 3 ETH for 300 fee 0.5
  const sw = [T({ id: 'a', type: 'buy', accountId: 'x', qty: 1, total: 100 }),
    T({ id: 'sw1s', type: 'sell', accountId: 'x', qty: 1, total: 300, fee: 2, swapId: 'sw1', date: '2026-01-02' }),
    T({ id: 'sw1b', type: 'buy', accountId: 'x', symbol: 'ETH', qty: 3, total: 300, fee: 0.5, swapId: 'sw1', date: '2026-01-02' })];
  const r10 = C.computePortfolio(sw, {}, m);
  near(r10.byAccount.x.get('BTC').realized, 200, m + ' 10 sold leg'); near(r10.byAccount.x.get('BTC').fees, 2, m + ' 10 sold leg fee');
  near(r10.byAccount.x.get('ETH').qtyHeld * r10.byAccount.x.get('ETH').avgEntry, 300, m + ' 10 bought leg basis excludes its fee'); near(r10.byAccount.x.get('ETH').fees, 0.5, m + ' 10 bought leg fee');
  near(r10.totals.feesFiat, 2.5, m + ' 10 both legs');
  const r10b = C.computePortfolio(sw.concat([T({ id: 'e', type: 'sell', accountId: 'x', symbol: 'ETH', qty: 3, total: 330, fee: 1, date: '2026-01-03' })]), {}, m);
  near(r10b.totals.realized, 230, m + ' 10 swap then sale: 200 + 30'); near(r10b.totals.feesFiat, 3.5, m + ' 10 fees accumulate');
});
both(m => { // 11. edit / delete a fee-bearing transaction and recompute
  const buy = T({ id: 'a', type: 'buy', accountId: 'x', qty: 2, total: 200, fee: 4 });
  const sell = T({ id: 'b', type: 'sell', accountId: 'x', qty: 1, total: 150, fee: 3, date: '2026-01-02' });
  const at = (list) => C.computePortfolio(list, {}, m).byAccount.x.get('BTC');
  let p = at([buy, sell]);
  near(p.realized, 50, m + ' 11 start realized'); near(p.qtyHeld, 1, m + ' 11 start qty'); near(p.fees, 7, m + ' 11 start fees');
  const buy2 = Object.assign({}, buy, { total: 300, fee: 6 }); // edit the buy: 150 per unit, fee 6
  p = at([buy2, sell]);
  near(p.realized, 0, m + ' 11 edited buy realized (150-150)'); near(p.qtyHeld, 1, m + ' 11 qty'); near(p.avgEntry, 150, m + ' 11 basis'); near(p.fees, 9, m + ' 11 fees 6+3');
  const sell2 = Object.assign({}, sell, { total: 210, fee: 5 }); // edit the sell
  p = at([buy, sell2]);
  near(p.realized, 110, m + ' 11 edited sell realized (210-100)'); near(p.fees, 9, m + ' 11 fees 4+5');
  // an edit that would oversell is refused by the production timeline check
  const tooBig = Object.assign({}, sell, { qty: 3 });
  assert.ok(C.heldTimelineConflict([buy, sell], tooBig, 'b'), m + ' 11 edit beyond holdings is refused');
  assert.equal(C.heldTimelineConflict([buy, sell], Object.assign({}, sell, { fee: 9, total: 150 }), 'b'), null, m + ' 11 a fee-only edit is allowed');
  // delete the sell: quantity and fees recomputed
  p = at([buy]); near(p.qtyHeld, 2, m + ' 11 after deleting the sell'); near(p.realized, 0, m + ' 11 realized'); near(p.fees, 4, m + ' 11 fees');
  // delete the buy that funded the sell (legacy data): the unfunded sell is ignored, its fee is not tallied
  const q = C.computePortfolio([sell], {}, m);
  near(q.totals.feesFiat, 0, m + ' 11 unfunded sell tallies no fee'); near(q.totals.realized, 0, m + ' 11 realized 0');
});
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
console.log('accounting-differential: OK (' + checked + ' random sequences, ' + withTransfers + ' with transfers, ' + withSwaps + ' with swaps, ' + withFees + ' with fees, ' + withResidual + ' needing the residual allowance)');
