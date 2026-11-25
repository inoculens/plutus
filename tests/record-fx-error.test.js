#!/usr/bin/env node
'use strict';
// Saving a record in a foreign currency needs that day's ECB rate. When it
// cannot be fetched nothing is saved, the user is asked for a manual rate,
// and the submit button returns to its idle label: "Add record" for a new
// record, "Save changes" for an edit (an edit used to come back as "Add
// record"). Real browser, network blocked. All figures are invented.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadChromium, launchChromium } = require('./browser-env');

const chromium = loadChromium('record-fx-error');
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
  settings: { mainCurrency: 'EUR', costMethod: 'fifo' },
  accounts: [{ id: 'a1', name: 'Wallet', ticker: 'BTC', kind: 'crypto' }],
  trades: [{ id: 'b1', type: 'buy', accountId: 'a1', symbol: 'BTC', qty: 0.1, total: 3000, currency: 'EUR', date: '2025-02-03',
    fxLock: { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false } }],
  priceOverrides: {}
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium(chromium, 'record-fx-error');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript((s) => { localStorage.setItem('inoculens.consent.v1', JSON.stringify({ choice: 'declined' })); localStorage.setItem('inoculens.v2', s); }, state);
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);

  async function submitInUsd(edit) {
    await page.evaluate((edit) => {
      if (edit) openEditTrade('b1'); else openPrefillTrade('a1', true, 'buy');
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
      set('t-qty', '0.2'); set('t-total', '5000'); set('t-currency', 'USD');
      document.getElementById('t-submit').click();
    }, edit);
    await page.waitForFunction(() => !tradeSubmitBusy && !!(document.getElementById('t-error') || {}).textContent, null, { timeout: 30000 });
    const out = await page.evaluate(() => ({
      label: document.getElementById('t-submit').textContent,
      error: document.getElementById('t-error').textContent,
      trades: loadState().trades.map(t => t.id + ':' + t.currency + ':' + t.total).join(',')
    }));
    await page.evaluate(() => closeDialog('trade-dialog'));
    return out;
  }

  const added = await submitInUsd(false);
  assert.match(added.error, /ECB rate unavailable/);
  assert.equal(added.label, 'Add record');
  assert.equal(added.trades, 'b1:EUR:3000', 'nothing saved');

  const edited = await submitInUsd(true);
  assert.match(edited.error, /ECB rate unavailable/);
  assert.equal(edited.label, 'Save changes', 'an edit keeps its own button label');
  assert.equal(edited.trades, 'b1:EUR:3000', 'the edited record is unchanged');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('record-fx-error: OK');
})().catch(e => { console.error(e); process.exit(1); });
