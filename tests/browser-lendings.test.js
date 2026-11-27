#!/usr/bin/env node
'use strict';
// Lendings in a real browser: lend 1,000 EUR out of a cash account, report
// interest, take a partial repayment (interest first) and write off part of
// the rest. Net value never moves on lending; Available leaves the
// outstanding amount out; only interest and a lost principal write records.
// Network blocked; all figures invented.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadChromium, launchChromium } = require('./browser-env');

const chromium = loadChromium('browser-lendings');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p.indexOf('/account') === 0) p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
const lock = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const state = JSON.stringify({
  settings: { mainCurrency: 'EUR', costMethod: 'average' },
  accounts: [{ id: 'eur', name: 'Bank EUR', ticker: 'EUR', kind: 'cash' }],
  trades: [{ id: 'i1', type: 'income', accountId: 'eur', symbol: 'EUR', qty: 5000, total: 5000, currency: 'EUR', date: '2026-10-02', fee: 0, feeCurrency: 'EUR', fxLock: lock }],
  priceOverrides: {}
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium(chromium, 'browser-lendings');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript((s) => {
    localStorage.setItem('inoculens.consent.v1', JSON.stringify({ choice: 'declined' }));
    if (!localStorage.getItem('inoculens.v2')) localStorage.setItem('inoculens.v2', s);
  }, state);
  await page.goto(base + '/account/eur', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);
  await page.waitForSelector('.stake-rewards-section');
  const sheet = () => page.$$eval('.debt-net-line, .debt-net-available p', els => els.map(e => e.textContent));
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('inoculens.v2')));

  // New lending: the asset locks to the account's own, the total follows the amount lent.
  await page.click('button[aria-label="Add pending income to Bank EUR"]');
  await page.click('.stake-type-toggle button[data-type="lending"]');
  assert.equal(await page.$eval('#stake-reward-income-wrap', el => el.hidden), true);
  assert.equal(await page.inputValue('#stake-reward-asset-ticker'), 'EUR');
  await page.fill('#stake-reward-name', 'Loan to Alex');
  await page.fill('#stake-reward-borrower', 'Alex');
  await page.fill('#stake-reward-principal', '6000');
  await page.click('#stake-reward-save');
  assert.match(await page.textContent('#stake-reward-error'), /only .*5,000/, 'cannot lend more than the account holds');
  await page.fill('#stake-reward-principal', '1000');
  assert.equal(await page.inputValue('#stake-reward-balance'), '1000', 'the total owed starts at the amount lent');
  await page.fill('#stake-reward-balance', '1050');
  assert.match(await page.textContent('#stake-reward-earned'), /Interest: €50\.00/);
  await page.click('#stake-reward-save');
  await page.waitForFunction(() => !document.getElementById('stake-reward-dialog').open);
  let lines = await sheet();
  assert.ok(lines.some(t => /Net value/.test(t) && /5,050\.00/.test(t)), 'net value keeps the principal and adds the interest: ' + lines);
  assert.ok(lines.some(t => /Lent out/.test(t) && /1,050\.00/.test(t)), lines.join());
  assert.ok(lines.some(t => /Available/.test(t) && /4,000\.00/.test(t)), lines.join());
  assert.equal((await stored()).trades.length, 1, 'lending writes no record');

  // Partial repayment: 50 interest (income record) + 250 principal (no record).
  await page.click('.stake-rewards-section summary');
  await page.click('button[aria-label="Record a repayment of Loan to Alex"]');
  assert.equal(await page.inputValue('#lending-settle-amount'), '1050', 'defaults to everything owed');
  await page.fill('#lending-settle-amount', '300');
  assert.match(await page.textContent('#lending-settle-preview'), /€50\.00 interest.*€250\.00 back.*€750\.00 still owed/);
  await page.click('#lending-settle-save');
  await page.waitForFunction(() => !document.getElementById('lending-settle-dialog').open);
  lines = await sheet();
  assert.ok(lines.some(t => /Available/.test(t) && /4,300\.00/.test(t)), 'principal repaid returns to available: ' + lines);
  let st = await stored();
  assert.deepEqual(st.trades.slice(1).map(t => [t.type, t.qty]), [['income', 50]]);

  // Write off 100: the lost principal leaves the account as an expense.
  await page.click('button[aria-label="Write off Loan to Alex"]');
  await page.fill('#lending-settle-amount', '800');
  assert.match(await page.textContent('#lending-settle-preview'), /at most what is owed/);
  await page.fill('#lending-settle-amount', '100');
  await page.click('#lending-settle-save');
  await page.waitForFunction(() => !document.getElementById('lending-settle-dialog').open);
  lines = await sheet();
  assert.ok(lines.some(t => /Net value/.test(t) && /4,950\.00/.test(t)), 'the loss lowers net value: ' + lines);
  assert.ok(lines.some(t => /Available/.test(t) && /4,300\.00/.test(t)), 'but not what was available: ' + lines);
  st = await stored();
  assert.deepEqual(st.trades.slice(1).map(t => [t.type, t.qty]), [['income', 50], ['expense', 100]]);
  assert.equal(st.accounts[0].stakeRewards[0].balanceSnapshots.length, 3);

  // Home: the account card carries a Lent chip.
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);
  await page.waitForSelector('.acct-lent-indicator');
  assert.equal(await page.textContent('.acct-lent-indicator'), 'Lent · 1');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('browser-lendings: OK');
})().catch(async (err) => { console.error(err); process.exit(1); });
