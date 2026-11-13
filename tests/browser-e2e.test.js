#!/usr/bin/env node
'use strict';
// Real-browser end-to-end workflow against the served page under its real CSP:
// fresh install -> accounts, buys, sells, transfer with network fee, swap,
// fees, cash flows, debt positions with snapshots and collateral, grouped
// accounts -> verify independently hand-calculated totals -> export -> wipe
// (unrelated site storage must survive) -> import the backup -> totals match
// -> encrypted WebDAV sync (in-memory fake server) -> wipe -> pull and verify
// -> a failed sync must not touch local data. Fails in CI-required mode, and
// prints an unmistakable SKIP locally, when Playwright or Chromium is
// unavailable (see browser-env.js); it never reports a pass it did not run.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadChromium, launchChromium } = require('./browser-env');
const { Diagnostics, PROBE_PATH, PROBE_EVAL_MARKER, PROBE_INLINE_MARKER } = require('./browser-diagnostics');
// Test-only switches that prove the CSP checks can fail (used by browser-e2e-guard.test.js):
//   E2E_CSP_ONLY=1        stop after the CSP stage
//   E2E_CSP_MUTANT=...    serve a weakened policy (inline | eval)
//   E2E_INJECT=...        add an unrelated violation (script | exception | asset)
const CSP_ONLY = process.env.E2E_CSP_ONLY === '1';
const chromium = loadChromium('browser-e2e');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === PROBE_PATH) { // loaded as a normal page script so the CSP is really enforced on it
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end("try { (0, eval)('window.__evalRan = 1; //" + PROBE_EVAL_MARKER + "'); } catch (e) { window.__evalBlocked = 1; }");
    return;
  }
  if (p === '/' || p.indexOf('/account') === 0) p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  let body = fs.readFileSync(f);
  if (p === '/index.html' && process.env.E2E_CSP_MUTANT) { // weakened copy, only ever served to prove the checks can fail
    const add = process.env.E2E_CSP_MUTANT === 'inline' ? "'unsafe-inline'" : "'unsafe-eval'";
    body = Buffer.from(body.toString().replace("script-src 'self'", "script-src 'self' " + add));
  }
  res.end(body);
});

const acc = (id, name, ticker, kind, extra) => Object.assign({ id, name, ticker, kind, createdAt: '2025-01-01T00:00:00.000Z' }, extra || {});
const snap = (id, amount, day) => ({ id, amount, reportedAt: day + 'T10:00:00.000Z', enteredAt: day + 'T10:01:00.000Z' });
const T = (o) => Object.assign({ currency: 'EUR' }, o);
const workflow = {
  settings: { mainCurrency: 'EUR', costMethod: 'fifo', assetLedgers: true, dateFormat: 'YYYY-MM-DD' },
  accounts: [
    acc('btc-a', 'BTC main', 'BTC', 'crypto'),
    acc('btc-b', 'BTC cold', 'BTC', 'crypto', { groupId: 'btc-a' }),
    acc('eth-a', 'ETH', 'ETH', 'crypto'),
    acc('usdc-a', 'USDC loan', 'USDC', 'crypto', { debtPositions: [{
      id: 'debt-1', name: 'Protocol borrow', createdAt: '2025-04-01T10:00:00.000Z',
      balanceSnapshots: [snap('s1', 100, '2025-04-01'), snap('s2', 140, '2025-05-01')],
      collateral: [{ accountId: 'btc-a', quantity: 0.1 }] }] }),
    acc('cash-eur', 'Cash', 'EUR', 'cash', { debtPositions: [{
      id: 'debt-2', name: 'Bank loan', createdAt: '2025-04-01T10:00:00.000Z',
      balanceSnapshots: [snap('s3', 500, '2025-04-01')], collateral: [] }] })
  ],
  trades: [
    T({ id: 'b1', type: 'buy', accountId: 'btc-a', symbol: 'BTC', qty: 1, total: 20000, date: '2025-01-10' }),
    T({ id: 'b2', type: 'buy', accountId: 'btc-a', symbol: 'BTC', qty: 0.5, total: 12000, date: '2025-02-10' }),
    T({ id: 's1', type: 'sell', accountId: 'btc-a', symbol: 'BTC', qty: 0.8, total: 20000, date: '2025-03-01' }),
    T({ id: 'x1', type: 'transfer', accountId: 'btc-a', symbol: 'BTC', qty: 0.3, networkFee: 0.001, toAccountId: 'btc-b', total: 0, date: '2025-03-05' }),
    T({ id: 'f1', type: 'expense', accountId: 'btc-b', symbol: 'BTC', qty: 0.0005, total: 0, date: '2025-03-06' }),
    T({ id: 'e1', type: 'buy', accountId: 'eth-a', symbol: 'ETH', qty: 4, total: 8000, date: '2025-02-01' }),
    T({ id: 'sw-s', type: 'sell', accountId: 'eth-a', symbol: 'ETH', qty: 1, total: 2200, date: '2025-04-02', swapId: 'sw1' }),
    T({ id: 'sw-b', type: 'buy', accountId: 'usdc-a', symbol: 'USDC', qty: 2200, total: 2200, date: '2025-04-02', swapId: 'sw1' }),
    T({ id: 'c1', type: 'income', accountId: 'cash-eur', symbol: 'EUR', qty: 1000, total: 1000, date: '2025-04-03' }),
    T({ id: 'c2', type: 'expense', accountId: 'cash-eur', symbol: 'EUR', qty: 120, total: 0, date: '2025-04-04' })
  ],
  priceOverrides: {}
};
const PRICES = { BTC: 30000, ETH: 2500, USDC: 0.9, EUR: 1 };
// Independently hand-calculated, FIFO by lot:
//  BTC main: lots 1@20000 + 0.5@12000; sell 0.8 for 20000 -> cost 16000, gain 4000.
//    Moving 0.3 takes 0.2@20000 + 0.1@24000 = 6400; the 0.001 network fee costs
//    6400*0.001/0.3 = 21.3333 -> realized 3978.6667, 0.4 BTC left.
//  BTC cold: receives 0.299 (lots keep their unit cost); the 0.0005 fee expense
//    takes the oldest lot (20000) -> -10; 0.2985 BTC left.
//  ETH: buy 4 @2000, swap-sell 1 for 2200 -> +200, 3 left. USDC: 2200 acquired.
//  Cash: +1000, spend 120 -> balance 880. Cash is bookkeeping, not P&L: the app
//  reports it through cashBalance() and keeps it out of realized P&L, so the
//  realized total is taken over non-cash accounts exactly as the summary does.
//  (The cash form stores total = qty on a spend; the engine's per-account
//  figure for a cash account is therefore not a user-facing number.)
const expected = { btcA: 0.4, btcB: 0.2985, eth: 3, usdc: 2200, cash: 880, realized: 3978 + 2 / 3 - 10 + 200 };
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, what + ': got ' + a + ' expected ' + b);

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const origin0 = base;
  const browser = await launchChromium(chromium, 'browser-e2e');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const diag = new Diagnostics();
  let remote = null, failDav = false, davHits = 0;
  const origin = origin0;
  page.on('pageerror', e => diag.exception(e.message));
  page.on('requestfailed', r => diag.requestFailed(r.url(), origin, (r.failure() || {}).errorText || '', r.resourceType()));
  page.on('response', r => diag.response(r.url(), origin, r.status()));
  await page.exposeFunction('__reportCsp', v => diag.csp(v));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async route => {
    const req = route.request(), url = req.url();
    if (url.startsWith('https://dav.test/')) {
      davHits++;
      if (failDav) return route.abort('connectionreset');
      const m = req.method();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const isRecords = /plutus\.enc\.json$/.test(url.split('?')[0]);
      if (!isRecords && m === 'GET') return route.fulfill({ status: 404, headers: cors, body: '' });
      if (!isRecords && m === 'PUT') return route.fulfill({ status: 201, headers: cors, body: '' });
      if (m === 'PUT') { remote = req.postData(); return route.fulfill({ status: 201, headers: Object.assign({ etag: '"v' + davHits + '"' }, cors), body: '' }); }
      if (m === 'GET') return remote === null ? route.fulfill({ status: 404, headers: cors, body: '' }) : route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: remote });
      if (m === 'MKCOL') return route.fulfill({ status: 405, headers: cors, body: '' });
      return route.fulfill({ status: 207, headers: cors, body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>' });
    }
    return route.abort();
  });
  await page.addInitScript(() => {
    // Stable CSP evidence (event properties), recorded from document start.
    document.addEventListener('securitypolicyviolation', e => window.__reportCsp({
      effectiveDirective: e.effectiveDirective, violatedDirective: e.violatedDirective, blockedURI: e.blockedURI,
      sourceFile: e.sourceFile, disposition: e.disposition }));
    try { localStorage.setItem('inoculens.consent.v1', 'declined'); } catch (e) {}
    // Same sequence as clearAllData() minus the confirm dialog and reload.
    window.wipeEverything = () => { saveStateGuarded(defaultState(), { replaceDamaged: true }); clearRecoveryCopies(); return wipeAllBrowserData(); };
    window.realizedExCash = (pf) => Object.keys(pf.byAccount).filter(a => a !== 'cash-eur').reduce((sum, a) => { let t = 0; pf.byAccount[a].forEach(p => { t += p.realized; }); return sum + t; }, 0);
  });

  // 1. Fresh install + CSP verification
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const csp = await page.evaluate(({ inlineMarker, probePath, inject }) => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const policy = meta ? meta.content : '';
    window.__inline = 0; const s = document.createElement('script'); s.textContent = 'window.__inline=1; //' + inlineMarker; document.head.appendChild(s);
    const p = document.createElement('script'); p.src = probePath; document.head.appendChild(p);
    // Deliberately UNRELATED faults, only to prove the diagnostics fail on them.
    if (inject === 'script') { const x = document.createElement('script'); x.src = 'https://unrelated-origin.test/x.js'; document.head.appendChild(x); }
    if (inject === 'exception') setTimeout(() => { throw new Error('unrelated page exception'); }, 0);
    if (inject === 'asset') { const x = document.createElement('script'); x.src = '/js/no-such-asset.js'; document.head.appendChild(x); }
    return { policy, inlineRan: window.__inline === 1, fresh: localStorage.getItem('inoculens.v2') };
  }, { inlineMarker: PROBE_INLINE_MARKER, probePath: PROBE_PATH, inject: process.env.E2E_INJECT || '' });
  await page.waitForTimeout(500);
  csp.evalBlocked = await page.evaluate(() => window.__evalBlocked === 1 && window.__evalRan !== 1);
  csp.evalRan = await page.evaluate(() => window.__evalRan === 1);
  const scriptSrc = (csp.policy.match(/script-src[^;]*/) || [''])[0];
  assert.ok(scriptSrc && !/unsafe-inline|unsafe-eval/.test(scriptSrc), 'script-src has no unsafe-inline/unsafe-eval: ' + scriptSrc);
  assert.equal(csp.evalRan, false, 'eval probe did not execute');
  assert.equal(csp.evalBlocked, true, 'eval is blocked by the CSP');
  assert.equal(csp.inlineRan, false, 'injected inline script is blocked by the CSP');
  // Expected blocks are classified by event properties, exactly once each; anything else is a failure.
  assert.deepEqual(diag.probeProblems(), [], 'CSP probe evidence');
  assert.deepEqual(diag.problems(['/', '/app.js', '/styles.css', '/js/net-worth-history.js']), [], 'unexpected diagnostics after load');
  if (CSP_ONLY) { await browser.close(); server.close(); console.log('browser-e2e: OK (csp only)'); return; }
  assert.ok(!csp.fresh || JSON.parse(csp.fresh).trades.length === 0, 'fresh install starts empty');

  // 2. Build the workflow through the app's own import path
  const result = await page.evaluate((wf) => {
    localStorage.setItem('unrelated-site-key', 'keep-me');
    const st = importState(JSON.stringify({ app: APP_ID, version: STORE_VERSION, exportedAt: new Date().toISOString(), ...wf }));
    render();
    const pf = computePortfolio(loadState().trades, { BTC: 30000, ETH: 2500, USDC: 0.9, EUR: 1 }, 'fifo');
    const held = (a, s) => (pf.byAccount[a] && pf.byAccount[a].get(s)) ? pf.byAccount[a].get(s).qtyHeld : 0;
    const acct = loadState().accounts.find(a => a.id === 'usdc-a');
    return {
      accounts: st.accounts.length, trades: st.trades.length,
      btcA: held('btc-a', 'BTC'), btcB: held('btc-b', 'BTC'), eth: held('eth-a', 'ETH'), usdc: held('usdc-a', 'USDC'),
      realized: realizedExCash(pf), cash: cashBalance(loadState().trades, 'cash-eur', 'EUR').main, grouped: loadState().accounts.find(a => a.id === 'btc-b').groupId,
      debtEarly: debtPositionBalanceAt(acct.debtPositions[0], Date.parse('2025-04-15T00:00:00Z')).amount,
      debtLate: debtPositionBalanceAt(acct.debtPositions[0], Date.parse('2025-06-01T00:00:00Z')).amount,
      cashDebt: accountDebtBalanceAt(loadState().accounts.find(a => a.id === 'cash-eur'), Date.parse('2025-06-01T00:00:00Z')),
      names: Array.from(document.querySelectorAll('body *')).some(e => e.textContent && e.textContent.indexOf('BTC main') !== -1)
    };
  }, workflow);
  assert.equal(result.accounts, 5); assert.equal(result.trades, 10);
  near(result.btcA, expected.btcA, 'BTC main'); near(result.btcB, expected.btcB, 'BTC cold'); near(result.eth, expected.eth, 'ETH'); near(result.usdc, expected.usdc, 'USDC');
  near(result.realized, expected.realized, 'realized P&L'); near(result.cash, expected.cash, 'cash balance');
  assert.equal(result.grouped, 'btc-a');
  assert.equal(result.debtEarly, 100); assert.equal(result.debtLate, 140); assert.equal(result.cashDebt, 500);
  assert.ok(result.names, 'account names rendered in the page');

  // 3. Export, wipe (unrelated storage survives), import the backup
  const backup = await page.evaluate(() => exportStateStrict(loadState()));
  await page.evaluate(() => wipeEverything());
  const afterWipe = await page.evaluate(() => ({ state: localStorage.getItem('inoculens.v2'), sync: localStorage.getItem('inoculens.sync.v1'), unrelated: localStorage.getItem('unrelated-site-key') }));
  assert.equal(JSON.parse(afterWipe.state).trades.length + JSON.parse(afterWipe.state).accounts.length, 0, 'app state wiped to an empty state'); assert.equal(afterWipe.sync, null, 'saved sync sign-in wiped'); assert.equal(afterWipe.unrelated, 'keep-me', 'unrelated site storage survives the wipe');
  const restored = await page.evaluate((json) => {
    importState(json);
    const pf = computePortfolio(loadState().trades, { BTC: 30000, ETH: 2500, USDC: 0.9, EUR: 1 }, 'fifo');
    return { realized: realizedExCash(pf), btcB: pf.byAccount['btc-b'].get('BTC').qtyHeld, state: exportStateStrict(loadState()) };
  }, backup);
  near(restored.realized, expected.realized, 'restored realized'); near(restored.btcB, expected.btcB, 'restored btc-b');
  const strip = j => { const o = JSON.parse(j); delete o.exportedAt; return JSON.stringify(o); };
  assert.equal(strip(restored.state), strip(backup), 'import/export round trip is lossless');

  // 4. Encrypted synchronization against the fake WebDAV server
  await page.evaluate(() => syncSaveConfig(Object.assign(syncDefaultConfig(), {
    provider: 'webdav', url: 'https://dav.test/remote.php/dav/files/me/', username: 'me', password: 'pw', rememberPassword: true,
    passphrase: 'correct horse battery', rememberPassphrase: true, filename: 'plutus.enc.json' })));
  // The Sync form is mounted and its fields win over stored config, so fill it like a user would.
  const fillSyncForm = (pass) => page.evaluate((pw) => {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    const chk = (id) => { const e = document.getElementById(id); if (e) e.checked = true; };
    set('sy-provider', 'webdav');
    set('sy-url', 'https://dav.test/remote.php/dav/files/me/'); set('sy-user', 'me'); set('sy-passwd', 'pw');
    set('sy-filename', 'plutus.enc.json'); chk('sy-remember'); chk('sy-remember-pass'); set('sy-pass', pw);
  }, pass);
  await fillSyncForm('correct horse battery');
  await page.evaluate(() => syncPushFlow({ auto: false }));
  await page.waitForFunction(() => !syncBusy, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  if (false) console.log('dbg', await page.evaluate(() => ({ banner: (document.querySelector('#banner, .banner')||{}).textContent, form: JSON.stringify(syncReadForm().cfg).replace(/"(password|passphrase)":"[^"]*"/g,'$1') })));
  assert.ok(remote && JSON.parse(remote).ciphertext, 'an encrypted envelope was uploaded');
  assert.equal(remote.indexOf('BTC main'), -1, 'no plaintext account names reach the server');
  assert.equal(remote.indexOf('correct horse'), -1, 'passphrase never reaches the server');
  const uploaded = remote;

  // 4b. A failed sync must not change local data (network down), and must not alter the server copy
  await page.evaluate(() => { const s = loadState(); s.trades.push({ id: 'late', type: 'buy', accountId: 'eth-a', symbol: 'ETH', qty: 1, total: 2000, currency: 'EUR', date: '2025-05-05' }); saveState(s); });
  failDav = true;
  await page.evaluate(() => syncPushFlow({ auto: false }));
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => !syncBusy, null, { timeout: 40000 });
  failDav = false;
  assert.equal(remote, uploaded, 'failed push left the server copy untouched');
  assert.equal(await page.evaluate(() => loadState().trades.length), 11, 'failed sync lost no local data');

  // 4c. Wipe and pull: the restored data matches (the newer local trade was never uploaded)
  await page.evaluate(() => { const s = loadState(); s.trades = s.trades.filter(t => t.id !== 'late'); saveState(s); });
  await page.evaluate(() => wipeEverything());
  await page.evaluate((env) => {
    syncSaveConfig(Object.assign(syncDefaultConfig(), { provider: 'webdav', url: 'https://dav.test/remote.php/dav/files/me/', username: 'me', password: 'pw', rememberPassword: true, passphrase: 'correct horse battery', rememberPassphrase: true, filename: 'plutus.enc.json' }));
  });
  await fillSyncForm('correct horse battery');
  await page.evaluate(() => syncPullFlow());
  const confirm = page.locator('#confirm-ok');
  try { await confirm.waitFor({ state: 'visible', timeout: 8000 }); await confirm.click(); } catch (e) { /* empty device: restore may not ask */ }
  await page.waitForFunction(() => !syncBusy, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const pulled = await page.evaluate(() => {
    const st = loadState();
    const pf = computePortfolio(st.trades, { BTC: 30000, ETH: 2500, USDC: 0.9, EUR: 1 }, 'fifo');
    return { accounts: st.accounts.length, trades: st.trades.length, realized: realizedExCash(pf), debt: st.accounts.find(a => a.id === 'usdc-a').debtPositions[0].balanceSnapshots.length };
  });
  assert.equal(pulled.accounts, 5); assert.equal(pulled.trades, 10);
  near(pulled.realized, expected.realized, 'pulled realized'); assert.equal(pulled.debt, 2, 'debt snapshots restored');

  // 4d. Wrong passphrase on pull must not replace local data
  await page.evaluate(() => { const c = syncLoadConfig(); c.passphrase = 'wrong passphrase'; syncSaveConfig(c); });
  await fillSyncForm('wrong passphrase');
  await page.evaluate(() => { const s = loadState(); s.trades.push({ id: 'keep', type: 'buy', accountId: 'eth-a', symbol: 'ETH', qty: 1, total: 2100, currency: 'EUR', date: '2025-06-06' }); saveState(s); });
  await page.evaluate(() => syncPullFlow());
  await page.waitForTimeout(2500);
  await page.waitForFunction(() => !syncBusy, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => loadState().trades.length), 11, 'wrong passphrase left local data untouched');

  await browser.close(); server.close();
  assert.deepEqual(diag.probeProblems(), [], 'CSP probe evidence');
  assert.deepEqual(diag.problems(['/', '/app.js', '/styles.css', '/js/net-worth-history.js']), [], 'unexpected browser diagnostics');
  console.log('browser-e2e: OK');
})().catch(e => { console.error(e); try { server.close(); } catch (_) {} process.exit(1); });
