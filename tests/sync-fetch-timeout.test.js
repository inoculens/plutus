#!/usr/bin/env node
'use strict';
// The sync timeout must cover the whole exchange, not only the arrival of the
// response headers: a body that stalls after headers must abort and reject
// with the same timeout error, a completed or failed body read must stop the
// timer, and a later retry must work. Loads app.js in a stubbed vm context
// with a fetch mock that honors AbortSignal.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const noop = () => {};
let fetchImpl = () => Promise.reject(new Error('unset'));
const C = {
  console, setTimeout, clearTimeout, setInterval: noop, Promise, Map, Set, BigInt, JSON, Math, Date, AbortController,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  document: { getElementById: () => null, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), body: {}, documentElement: {}, readyState: 'loading' },
  navigator: { userAgent: 'node' }, location: { hash: '', href: '', pathname: '/' }, addEventListener: noop,
  fetch: (url, o) => fetchImpl(url, o), matchMedia: () => ({ matches: false, addEventListener: noop }),
  requestAnimationFrame: noop, Event: function () {}, crypto: { getRandomValues: a => a, subtle: {} },
  history: { pushState: noop, replaceState: noop }, performance: { now: () => 0 }
};
C.window = C; C.self = C; C.globalThis = C;
vm.createContext(C);
vm.runInContext(src, C, { filename: 'app.js' });
C.SYNC_TIMEOUT_MS = 80;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const abortErr = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
const untilAbort = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortErr())));

async function main() {
  // Headers and body arrive promptly.
  {
    fetchImpl = (u, o) => Promise.resolve({ ok: true, body: {}, text: () => Promise.resolve('hello'), json: () => Promise.resolve({ a: 1 }) });
    const res = await C.syncFetch('https://x.test/a', {}, 'the test server');
    assert.equal(await res.text(), 'hello');
    assert.deepEqual(JSON.parse(JSON.stringify(await res.json())), { a: 1 });
  }

  // Headers never arrive: times out.
  {
    fetchImpl = (u, o) => untilAbort(o.signal);
    await assert.rejects(C.syncFetch('https://x.test/b', {}, 'the test server'), /timed out reaching the test server/);
  }

  // Headers arrive, body stalls: the timer is still running and aborts the read.
  {
    let signal;
    fetchImpl = (u, o) => { signal = o.signal; return Promise.resolve({ ok: true, body: {}, text: () => untilAbort(o.signal) }); };
    const res = await C.syncFetch('https://x.test/c', {}, 'the test server');
    assert.equal(signal.aborted, false, 'not aborted yet when headers arrive');
    await assert.rejects(res.text(), /timed out reaching the test server/);
    assert.equal(signal.aborted, true);
  }

  // Body parse failure propagates unchanged and stops the timer.
  {
    let signal;
    const boom = new SyntaxError('bad json');
    fetchImpl = (u, o) => { signal = o.signal; return Promise.resolve({ ok: true, body: {}, json: () => Promise.reject(boom) }); };
    const res = await C.syncFetch('https://x.test/d', {}, 'the test server');
    await assert.rejects(res.json(), e => e === boom);
    await sleep(150);
    assert.equal(signal.aborted, false, 'timer stopped after the failed read');
  }

  // Bodyless response (HEAD / 204) stops the timer at once.
  {
    let signal;
    fetchImpl = (u, o) => { signal = o.signal; return Promise.resolve({ ok: true, status: 204, body: null }); };
    await C.syncFetch('https://x.test/e', { method: 'HEAD' }, 'the test server');
    await sleep(150);
    assert.equal(signal.aborted, false);
  }

  // Network failure keeps its own message; retry after a timeout works.
  {
    fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'));
    await assert.rejects(C.syncFetch('https://x.test/f', {}, 'the test server'), /cannot reach the test server/);
    fetchImpl = (u, o) => untilAbort(o.signal);
    await assert.rejects(C.syncFetch('https://x.test/g', {}, 'the test server'), /timed out/);
    fetchImpl = () => Promise.resolve({ ok: true, body: {}, text: () => Promise.resolve('again') });
    const res = await C.syncFetch('https://x.test/h', {}, 'the test server');
    assert.equal(await res.text(), 'again');
  }

  console.log('sync fetch timeout checks passed');
}

// A stalled body on a broken build leaves a promise pending forever and Node
// would exit 0 silently: treat "never finished" as a failure.
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('sync fetch timeout test did not finish (a request hung)'); process.exitCode = 1; }
});
main().then(() => { finished = true; }, err => { console.error(err); process.exit(1); });
