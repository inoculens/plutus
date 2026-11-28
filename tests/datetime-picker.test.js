#!/usr/bin/env node
'use strict';
// Date-time fields wear the select chevron. A click on it must open the
// picker in every engine: Chromium has its own invisible button there, other
// engines get showPicker() from wireDateTimePickers, and Firefox, whose own
// calendar button cannot be hidden, gets no chevron at all.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { appSource, cssSource } = require('./app-source');
const noop = () => {};
let clickHandler = null;
let style = { backgroundImage: 'url(chevron)', paddingRight: '36.8px' };
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: { getElementById: () => null, addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; }, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 },
  getComputedStyle: () => style
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(appSource(), C, { filename: 'app-scripts.js' });
clickHandler = null;
C.wireDateTimePickers();
assert.equal(typeof clickHandler, 'function', 'one delegated click listener');

function field(extra) {
  const f = Object.assign({
    tagName: 'INPUT', type: 'datetime-local', disabled: false, readOnly: false, opened: 0, open: false,
    getBoundingClientRect: () => ({ left: 0, right: 300 }),
    matches(sel) { if (sel === ':open') return this.open; return false; },
    showPicker() { this.opened++; },
    focus: noop
  }, extra || {});
  return f;
}
const click = (target, x) => clickHandler({ target, clientX: x });

let f = field(); click(f, 290);
assert.equal(f.opened, 1, 'a click on the chevron opens the picker');
f = field(); click(f, 120);
assert.equal(f.opened, 0, 'a click on the date text keeps editing it');
f = field({ open: true }); click(f, 290);
assert.equal(f.opened, 0, 'Chromium already opened it from its own button: no second call');
f = field({ type: 'date' }); click(f, 290);
assert.equal(f.opened, 0, 'only datetime-local fields');
f = field({ disabled: true }); click(f, 290);
assert.equal(f.opened, 0, 'disabled fields stay closed');
f = field({ showPicker() { throw new Error('NotAllowedError'); } });
assert.doesNotThrow(() => click(f, 290), 'an engine refusing showPicker never breaks the click');
style = { backgroundImage: 'none', paddingRight: '12px' };
f = field(); click(f, 290);
assert.equal(f.opened, 0, 'no chevron drawn (Firefox): its own button handles it');

const css = cssSource();
assert.match(css, /@supports \(-moz-appearance: none\) \{\s*input\[type="datetime-local"\] \{ background-image: none;/,
  'Firefox gets no chevron beside its own calendar button');
assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js', 'app.js'), 'utf8'), /wireDateTimePickers\(\);/,
  'boot wires it');
console.log('datetime-picker: ok');
