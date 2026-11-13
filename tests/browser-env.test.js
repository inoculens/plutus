#!/usr/bin/env node
'use strict';
// Proves the browser-test loader cannot turn missing infrastructure into a
// green run. Child processes exercise browser-env.js directly:
//  - CI-required mode + Playwright absent   -> exit 1, FAIL printed
//  - CI-required mode + Chromium absent     -> exit 1, FAIL printed
//  - CI-required mode + both present        -> body runs, Chromium really launches (exit 0)
//  - REQUIRE_BROWSER_TESTS=1 behaves like CI
//  - local optional mode + either absent    -> exit 0 with an unmistakable SKIP line
// The "present" cases need the real Playwright + Chromium; in CI-required mode
// their absence fails this test too.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const helper = path.join(__dirname, 'browser-env.js');
const body = "const e=require(" + JSON.stringify(helper) + ");const c=e.loadChromium('probe');" +
  "e.launchChromium(c,'probe').then(b=>b.close().then(()=>console.log('probe: BODY RAN')));";
const run = (env) => {
  const clean = Object.assign({}, process.env);
  delete clean.CI; delete clean.REQUIRE_BROWSER_TESTS; delete clean.PLUTUS_PLAYWRIGHT_MODULE; delete clean.PLUTUS_CHROMIUM_EXECUTABLE;
  const r = spawnSync(process.execPath, ['-e', body], { env: Object.assign(clean, env), encoding: 'utf8', timeout: 90000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const NO_PW = { PLUTUS_PLAYWRIGHT_MODULE: 'playwright-does-not-exist-xyz' };
const NO_CHROMIUM = { PLUTUS_CHROMIUM_EXECUTABLE: path.join(__dirname, 'no-such-chromium-binary') };

let r = run(Object.assign({ CI: '1' }, NO_PW));
assert.equal(r.code, 1, 'CI + no Playwright must fail'); assert.match(r.out, /probe: FAIL: playwright is not installed/); assert.doesNotMatch(r.out, /SKIP/);
r = run(Object.assign({ CI: 'true' }, NO_CHROMIUM));
assert.equal(r.code, 1, 'CI + no Chromium must fail'); assert.match(r.out, /probe: FAIL: Chromium could not be launched/); assert.doesNotMatch(r.out, /SKIP/);
r = run(Object.assign({ REQUIRE_BROWSER_TESTS: '1' }, NO_PW));
assert.equal(r.code, 1, 'REQUIRE_BROWSER_TESTS=1 behaves like CI');
r = run(Object.assign({ CI: '0' }, NO_PW)); // CI=0 means not required
assert.equal(r.code, 0, 'CI=0 is optional mode');
r = run(NO_PW);
assert.equal(r.code, 0, 'local optional mode + no Playwright exits 0'); assert.match(r.out, /SKIP: probe NOT RUN: playwright is not installed/);
r = run(NO_CHROMIUM);
assert.equal(r.code, 0, 'local optional mode + no Chromium exits 0'); assert.match(r.out, /SKIP: probe NOT RUN: Chromium could not be launched/);
// Present: the test body really executes and Chromium really launches.
r = run({ CI: '1' });
assert.equal(r.code, 0, 'CI + Playwright + Chromium present must pass: ' + r.out);
assert.match(r.out, /probe: Chromium \S+ launched/); assert.match(r.out, /probe: BODY RAN/);
console.log('browser-env: OK');
