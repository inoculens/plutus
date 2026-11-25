#!/usr/bin/env node
'use strict';
// The app is a list of classic scripts sharing one global scope, executed in
// index.html order. Function declarations are only hoisted within their own
// file, so load-time code may only use what earlier files (or its own file)
// declare. This test runs each file on its own, in order, like the browser,
// and checks the list itself:
// - every script runs at load without error and is strict mode;
// - no global name is declared by two files (a later one would silently
//   replace the earlier one);
// - every .js file under js/ is loaded by index.html (no orphans), and the
//   page's scripts all exist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { appScripts, root } = require('./app-source');

const noop = () => {};
const el = () => ({ addEventListener: noop, setAttribute: noop, classList: { add: noop, remove: noop, contains: () => false }, style: {} });
const C = {
  console, setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop, Promise, Map, Set, WeakMap, BigInt, JSON, Math, Date,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: el, body: el(), documentElement: el(), readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/', search: '' }, addEventListener: noop,
  fetch: () => Promise.reject(new Error('no net')), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);

const scripts = appScripts({ withChart: true });
const declaredBy = {};
for (const f of scripts) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  assert.ok(fs.existsSync(path.join(root, f)), f + ' exists');
  if (f !== 'js/ui/net-worth-chart.js') { // the chart is one strict IIFE
    assert.match(src, /^'use strict';\n/, f + ' starts with \'use strict\'');
  }
  // Top-level declarations (column 0 by the project's style).
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([\w$]+)|^var\s+([\w$]+)/gm)) {
    const name = m[1] || m[2];
    assert.ok(!declaredBy[name] || declaredBy[name] === f, name + ' is declared in both ' + declaredBy[name] + ' and ' + f);
    declaredBy[name] = f;
  }
  try {
    vm.runInContext(src, C, { filename: f });
  } catch (e) {
    assert.fail(f + ' failed at load (does it use something a later file declares?): ' + e.message);
  }
}
assert.equal(scripts[scripts.length - 1], 'js/app.js', 'js/app.js boots last');
assert.equal(typeof C.init, 'function', 'init is reachable once every script ran');

// No orphans: every app file under js/ is loaded by the page.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Every script tag is either one of the two parse-time boot scripts or an app
// script in the exact form the test helper reads (src first, then defer), so
// no script can load in the browser yet be missing from the tests.
const BOOT = ['js/boot/consent-default.js', 'js/boot/startup-loader.js'];
for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
  const src = /\bsrc="\/([^"?]+)/.exec(m[1]);
  if (!src) continue; // JSON-LD data
  assert.ok(BOOT.includes(src[1]) || scripts.includes(src[1]), '<script' + m[1] + '> is not in the app script list (write it as <script src="/js/...?v=N" defer></script>)');
}
function walk(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(dir + '/' + d.name) : (d.name.endsWith('.js') ? [dir + '/' + d.name] : []));
}
for (const f of walk('js')) {
  assert.ok(html.includes('src="/' + f + '?') || html.includes('src="/' + f + '"'), f + ' is not loaded by index.html');
}

console.log('script order checks passed (' + scripts.length + ' scripts)');
