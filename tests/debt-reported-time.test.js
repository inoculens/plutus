#!/usr/bin/env node
'use strict';
// A reported debt balance is an observation that already happened: the form
// rejects a future observation time (5 minutes of clock skew allowed), and an
// as-of-now lookup never returns a snapshot dated in the future, so the
// position card and the totals always agree. All figures are invented.
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

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const MIN = 60 * 1000;
assert.equal(C.debtReportedAtIssue(NOW, NOW), '', 'now is accepted');
assert.equal(C.debtReportedAtIssue(NOW - 365 * 24 * 60 * MIN, NOW), '', 'the past is accepted');
assert.equal(C.debtReportedAtIssue(NOW + 5 * MIN, NOW), '', 'five minutes of clock skew is tolerated');
assert.match(C.debtReportedAtIssue(NOW + 5 * MIN + 1, NOW), /future/);
assert.match(C.debtReportedAtIssue(NOW + 5 * 24 * 60 * MIN, NOW), /future/);
assert.match(C.debtReportedAtIssue(NaN, NOW), /Enter when/);
assert.match(C.debtReportedAtIssue('2026-11-10', NOW), /Enter when/);
assert.match(C.debtReportedAtIssue(undefined, NOW), /Enter when/);

// As-of-now lookup: a future-dated snapshot (legacy/imported) never leaks.
const position = {
  id: 'd1', name: 'Loan', createdAt: '2026-11-01T00:00:00.000Z',
  balanceSnapshots: [
    { id: 's1', amount: 300, reportedAt: '2026-11-01T10:00:00.000Z', enteredAt: '2026-11-01T10:01:00.000Z' },
    { id: 's2', amount: 999, reportedAt: '2026-11-15T10:00:00.000Z', enteredAt: '2026-11-10T11:00:00.000Z' }
  ]
};
assert.equal(C.latestDebtBalanceSnapshot(position, NOW).amount, 300, 'the future snapshot is not current');
assert.equal(C.accountDebtBalanceAt({ debtPositions: [position] }, NOW), 300);
assert.equal(C.latestDebtBalanceSnapshot(position, Date.parse('2026-11-15T10:00:00.000Z')).amount, 999,
  'it becomes current exactly when its report time arrives');
assert.equal(C.latestDebtBalanceSnapshot({ balanceSnapshots: [position.balanceSnapshots[1]] }, NOW), null,
  'only future snapshots means no current liability');

console.log('debt-reported-time: ok');
