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


const bad = ['a"b', 'a\\b', 'a\nb', '"]\\"><script>', 'x" y="z'];
bad.forEach(v => {
  const e = C.cssAttrValue(v);
  assert.equal(/(^|[^\\])"/.test(e.replace(/\\\\/g, '')), false, 'no unescaped quote survives: ' + JSON.stringify(v));
  assert.equal(/\n|\r|\f/.test(e), false, 'no raw newline survives');
});
assert.equal(C.cssAttrValue('plain-id_1'), 'plain-id_1', 'ordinary ids unchanged');
assert.equal(C.safeDisplayName('evil\u202Etxt.exe'), 'eviltxt.exe', 'bidi override stripped');
assert.equal(C.safeDisplayName('a\u0007b\u2066c\u2069'), 'abc', 'control and isolate chars stripped');
assert.equal(C.safeDisplayName('Rechnung \u00E4\u00F6\u00FC \u65E5\u672C.pdf'), 'Rechnung \u00E4\u00F6\u00FC \u65E5\u672C.pdf', 'legitimate unicode kept');
assert.equal(C.safeDisplayName(null), '');
console.log('dom-escaping: OK');
