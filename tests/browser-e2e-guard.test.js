#!/usr/bin/env node
'use strict';
// Proves the CSP diagnostics in browser-e2e.test.js can actually fail.
//  1. Pure classification of CSP violation events (no browser needed).
//  2. Real Chromium, CSP stage only: the unmodified policy passes, and each of
//     these must make it exit non-zero: a policy weakened with unsafe-inline,
//     one weakened with unsafe-eval, an unrelated CSP violation, an unrelated
//     page exception, and a missing application asset.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { Diagnostics, classifyViolation, PROBE_PATH } = require('./browser-diagnostics');
const { loadChromium, launchChromium } = require('./browser-env');

// --- 1. classification
const inline = { effectiveDirective: 'script-src-elem', blockedURI: 'inline', sourceFile: 'http://127.0.0.1:1/' };
const evalV = { effectiveDirective: 'script-src', blockedURI: 'eval', sourceFile: 'http://127.0.0.1:1' + PROBE_PATH };
assert.equal(classifyViolation(inline), 'inline-probe');
assert.equal(classifyViolation(evalV), 'eval-probe');
assert.equal(classifyViolation({ effectiveDirective: 'script-src', blockedURI: 'eval', sourceFile: 'http://127.0.0.1:1/app.js' }), 'unexpected', 'eval from the app itself is a regression');
assert.equal(classifyViolation({ effectiveDirective: 'script-src-elem', blockedURI: 'https://evil.test/x.js', sourceFile: 'http://127.0.0.1:1/' }), 'unexpected');
assert.equal(classifyViolation({ effectiveDirective: 'connect-src', blockedURI: 'http://evil.test', sourceFile: '' }), 'unexpected');
// The old text filter muted any message that mentioned the policy's own hosts; event properties cannot be muted that way.
let d = new Diagnostics(); d.csp(inline); d.csp(evalV);
assert.deepEqual(d.probeProblems(), []); assert.deepEqual(d.problems([]), []);
d.csp(inline); assert.equal(d.probeProblems().length, 1, 'a second inline block is not "expected"');
d = new Diagnostics(); d.csp(inline); assert.equal(d.probeProblems().length, 1, 'missing eval evidence fails');
d = new Diagnostics(); d.csp(inline); d.csp(evalV); d.csp({ effectiveDirective: 'img-src', blockedURI: 'https://x.test/a.png', sourceFile: '' });
assert.equal(d.problems([]).length, 1, 'unrelated violation fails');
d = new Diagnostics(); d.exception('boom'); assert.equal(d.problems([]).length, 1);
d = new Diagnostics(); d.requestFailed('http://o/x.js', 'http://o', 'net::ERR'); d.requestFailed('https://ext/x', 'http://o', 'net::ERR'); assert.equal(d.problems([]).length, 1, 'only same-origin failures count');
d = new Diagnostics(); d.requestFailed('http://o/i.png', 'http://o', 'net::ERR_ABORTED', 'image'); assert.deepEqual(d.problems([]), [], 'cancelled image load is tolerated');
d = new Diagnostics(); d.requestFailed('http://o/a.js', 'http://o', 'net::ERR_ABORTED', 'script'); assert.equal(d.problems([]).length, 1, 'aborted script is not');
d = new Diagnostics(); d.requestFailed('http://o/i.png', 'http://o', 'net::ERR_CONNECTION_REFUSED', 'image'); assert.equal(d.problems([]).length, 1, 'failed image (not a cancel) is not');
d = new Diagnostics(); d.response('http://o/app.js', 'http://o', 200); assert.deepEqual(d.problems(['/app.js']), []); assert.equal(d.problems(['/app.js', '/missing.js']).length, 1, 'missing asset fails');
d = new Diagnostics(); d.response('http://o/x.js', 'http://o', 404); assert.equal(d.problems([]).length, 1, '404 fails');

// --- 2. real browser, CSP stage only
(async () => {
  const chromium = loadChromium('browser-e2e-guard');
  (await launchChromium(chromium, 'browser-e2e-guard')).close();
  const e2e = path.join(__dirname, 'browser-e2e.test.js');
  const run = (env) => {
    const r = spawnSync(process.execPath, [e2e], { env: Object.assign({}, process.env, { E2E_CSP_ONLY: '1', CI: '1' }, env), encoding: 'utf8', timeout: 120000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  let r = run({});
  assert.equal(r.code, 0, 'unmodified policy passes the CSP stage: ' + r.out.slice(-600));
  const cases = [
    ['unsafe-inline policy', { E2E_CSP_MUTANT: 'inline' }],
    ['unsafe-eval policy', { E2E_CSP_MUTANT: 'eval' }],
    ['unrelated CSP violation', { E2E_INJECT: 'script' }],
    ['unrelated page exception', { E2E_INJECT: 'exception' }],
    ['missing application asset', { E2E_INJECT: 'asset' }]
  ];
  for (const [label, env] of cases) {
    r = run(env);
    assert.notEqual(r.code, 0, label + ' must fail the CSP stage: ' + r.out.slice(-400));
    console.log('guard: ' + label + ' -> failed as required');
  }
  console.log('browser-e2e-guard: OK');
})().catch(e => { console.error(e); process.exit(1); });
