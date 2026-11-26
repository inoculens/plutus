#!/usr/bin/env node
'use strict';
// Pending income in a real browser (stake rewards and a fiat invoice): add an unclaimed balance in the staked
// token and one paid in another token, see both in the hero total, claim
// part of one and all of the other. A claim must write one Income record in
// the receiving account and lower the unclaimed balance in the same save.
// Network blocked; prices come from manual overrides. All figures invented.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadChromium, launchChromium } = require('./browser-env');

const chromium = loadChromium('browser-stake-rewards');
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

const state = JSON.stringify({
  settings: { mainCurrency: 'EUR', costMethod: 'average' },
  accounts: [
    { id: 'eth', name: 'ETH staking', ticker: 'ETH', kind: 'crypto' },
    { id: 'crv', name: 'CRV wallet', ticker: 'CRV', kind: 'crypto' },
    { id: 'usd', name: 'USD business', ticker: 'USD', kind: 'cash' }
  ],
  trades: [{ id: 'b1', type: 'buy', accountId: 'eth', symbol: 'ETH', qty: 10, total: 20000, currency: 'EUR', date: '2026-10-01',
    fxLock: { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false } }],
  priceOverrides: { ETH: 2000, CRV: 0.5 }
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium(chromium, 'browser-stake-rewards');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript((s) => {
    localStorage.setItem('inoculens.consent.v1', JSON.stringify({ choice: 'declined' }));
    if (!localStorage.getItem('inoculens.v2')) localStorage.setItem('inoculens.v2', s);
  }, state);
  await page.goto(base + '/account/eth', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);
  await page.waitForSelector('.stake-rewards-section');

  async function addReward(name, ticker, balance) {
    await page.click('button[aria-label="Add pending income to ETH staking"]');
    await page.fill('#stake-reward-name', name);
    if (ticker) await page.fill('#stake-reward-asset-ticker', ticker);
    await page.fill('#stake-reward-balance', balance);
    await page.click('#stake-reward-save');
    await page.waitForFunction(() => !document.getElementById('stake-reward-dialog').open);
  }
  // A new reward defaults to the staked token.
  await page.click('button[aria-label="Add pending income to ETH staking"]');
  assert.equal(await page.inputValue('#stake-reward-asset-ticker'), 'ETH');
  await page.evaluate(() => closeDialog('stake-reward-dialog'));
  await addReward('Validator rewards', '', '0.75');
  await addReward('Gauge CRV', 'CRV', '40');

  const summary = await page.$$eval('.debt-net-line', els => els.map(e => e.textContent));
  assert.ok(summary.some(t => /Pending income/.test(t) && /1,520\.00/.test(t)), 'account summary lists the unclaimed rewards: ' + summary);
  assert.ok(summary.some(t => /Net value/.test(t) && /21,520\.00/.test(t)), 'net value adds them: ' + summary);

  // The panel starts collapsed, like Debt positions.
  await page.click('.stake-rewards-section summary');
  // Partial claim into the staking account itself: no account picker.
  await page.click('button[aria-label="Claim Validator rewards"]');
  assert.equal(await page.inputValue('#stake-claim-amount'), '0.75', 'the claim defaults to everything unclaimed');
  assert.equal(await page.$eval('#stake-claim-target-wrap', el => el.hidden), true);
  await page.fill('#stake-claim-amount', '0.25');
  await page.fill('#stake-claim-value', '500');
  await page.click('#stake-claim-save');
  await page.waitForFunction(() => !document.getElementById('stake-claim-dialog').open);

  // CRV is paid into the CRV account: the picker shows and preselects it.
  await page.click('button[aria-label="Claim Gauge CRV"]');
  assert.equal(await page.$eval('#stake-claim-target-wrap', el => el.hidden), false);
  assert.equal(await page.inputValue('#stake-claim-target'), 'crv');
  await page.click('#stake-claim-save');
  await page.waitForFunction(() => !document.getElementById('stake-claim-dialog').open);

  const out = await page.evaluate(() => {
    const st = loadState();
    const eth = st.accounts.find(a => a.id === 'eth');
    return {
      pending: eth.stakeRewards.map(r => latestDebtBalanceSnapshot(r, Date.now()).amount),
      incomes: st.trades.filter(t => t.type === 'income').map(t => [t.accountId, t.symbol, t.qty, t.total]),
      historyTop: document.querySelector('.stake-reward-card .debt-snapshot-history li strong').textContent
    };
  });
  assert.deepEqual(out.pending, [0.5, 0], 'claims lower the unclaimed balances');
  assert.deepEqual(out.incomes, [['eth', 'ETH', 0.25, 500], ['crv', 'CRV', 40, 0]], 'one income record per claim, in the receiving account');
  assert.equal(out.historyTop, '0.5 ETH', 'the claim report is the newest history entry');

  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);
  await page.waitForFunction(() => /21,520\.00/.test((document.getElementById('hero-value-num') || {}).textContent || ''), null, { timeout: 10000 });
  const chip = await page.$eval('.acct-reward-indicator', el => el.textContent);
  assert.equal(chip, 'Pending · 2');

  // Fiat: an invoice owed in USD on a cash account (main currency EUR).
  await page.goto(base + '/account/usd', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);
  await page.click('button[aria-label="Add pending income to USD business"]');
  assert.equal(await page.inputValue('#stake-reward-asset-kind'), 'cash', 'a cash account starts with its own fiat');
  assert.equal(await page.inputValue('#stake-reward-asset-ticker'), 'USD');
  await page.fill('#stake-reward-name', 'Invoice 114');
  await page.fill('#stake-reward-balance', '1200');
  await page.click('#stake-reward-save');
  await page.waitForFunction(() => !document.getElementById('stake-reward-dialog').open);
  await page.click('.stake-rewards-section summary');
  await page.click('button[aria-label="Mark paid: Invoice 114"]');
  assert.equal(await page.$eval('#stake-claim-value-wrap', el => el.hidden), true, 'a cash payment is its own value');
  assert.equal(await page.$eval('#stake-claim-rate-wrap', el => el.hidden), false, 'foreign fiat offers a rate');
  assert.equal(await page.textContent('#stake-claim-save'), 'Mark paid');
  await page.fill('#stake-claim-amount', '700');
  // Network blocked: no ECB rate, so nothing is saved and a rate is asked for.
  await page.click('#stake-claim-save');
  await page.waitForFunction(() => /enter the exchange rate/.test((document.getElementById('stake-claim-error-text') || {}).textContent || ''));
  assert.equal(await page.evaluate(() => loadState().trades.filter(t => t.accountId === 'usd').length), 0, 'nothing saved without a rate');
  await page.fill('#stake-claim-rate', '0.9');
  await page.click('#stake-claim-save');
  await page.waitForFunction(() => !document.getElementById('stake-claim-dialog').open);
  const fiat = await page.evaluate(() => {
    const st = loadState();
    const t = st.trades.find(x => x.accountId === 'usd');
    return { t: [t.type, t.symbol, t.qty, t.total, t.currency, t.fxLock.rate, t.fxLock.source],
      pending: latestDebtBalanceSnapshot(st.accounts.find(a => a.id === 'usd').stakeRewards[0], Date.now()).amount };
  });
  assert.deepEqual(fiat.t, ['income', 'USD', 700, 700, 'USD', 0.9, 'manual'], 'a cash Income record in USD at the typed rate');
  assert.equal(fiat.pending, 500, '1200 owed - 700 paid');

  // Pledge mode (Aave-style): pledge 2 ETH from the account itself, report
  // the total Aave shows, and only the growth counts.
  await page.goto(base + '/account/eth', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);
  await page.click('button[aria-label="Add pending income to ETH staking"]');
  await page.fill('#stake-reward-name', 'Aave ETH supply');
  await page.selectOption('#stake-reward-mode', 'pledge');
  assert.equal(await page.$eval('#stake-reward-pledge-wrap', el => el.hidden), false);
  await page.click('#stake-reward-add-pledge');
  await page.selectOption('#stake-reward-pledge-list .stake-pledge-row select', 'eth');
  await page.fill('#stake-reward-pledge-list .stake-pledge-row input', '20');
  await page.fill('#stake-reward-balance', '2.03');
  await page.click('#stake-reward-save');
  await page.waitForFunction(() => /holds only/.test((document.getElementById('stake-reward-error-text') || {}).textContent || ''));
  await page.fill('#stake-reward-pledge-list .stake-pledge-row input', '2');
  assert.equal(await page.textContent('#stake-reward-earned'), 'Earned: 0.03 ETH (total − 2 ETH pledged)', 'live earned line');
  await page.click('#stake-reward-save');
  await page.waitForFunction(() => !document.getElementById('stake-reward-dialog').open);
  const pledgeOut = await page.evaluate(() => {
    const st = loadState();
    const entry = st.accounts.find(a => a.id === 'eth').stakeRewards.find(r => r.name === 'Aave ETH supply');
    const s = entry.balanceSnapshots[0];
    return { pledge: entry.pledge, snap: [s.amount, s.total, s.pledged],
      held: computePositions(st.trades.filter(t => t.accountId === 'eth'), {}, 'average')[0].qtyHeld,
      cards: Array.from(document.querySelectorAll('.stake-reward-card')).map(c => c.textContent).join(' | ') };
  });
  assert.deepEqual(pledgeOut.pledge, [{ accountId: 'eth', quantity: 2 }]);
  assert.deepEqual(pledgeOut.snap, [0.03, 2.03, 2], 'only the growth is pending');
  assert.equal(pledgeOut.held, 10.25, 'the pledged ETH stays in the holdings, no record moved it');
  assert.ok(/0\.03 ETH earned/.test(pledgeOut.cards) && /Payer shows 2\.03 ETH · 2 ETH pledged/.test(pledgeOut.cards), pledgeOut.cards);

  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('browser-stake-rewards: OK');
})().catch(async e => { console.error(e); process.exit(1); });
