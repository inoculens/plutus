#!/usr/bin/env node
'use strict';
// Duplicate transaction IDs in a real browser: a new record whose asset +
// hash already exists asks first (Cancel keeps nothing, Save anyway saves and
// marks the group); a duplicate already in the data shows the warning pill
// on its cards; Ignore warning hides it and leaves a quiet marker; Show
// warning again brings it back. Internal transfers, cash records and other
// assets never warn. Network blocked; all figures are invented.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadChromium, launchChromium } = require('./browser-env');

const chromium = loadChromium('browser-tx-duplicates');
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

const H1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const H2 = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
const acc = (id, name, ticker, kind) => ({ id, name, ticker, kind, createdAt: '2025-01-01T00:00:00.000Z' });
const lock = { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false };
const buy = (id, accountId, symbol, qty, date, txid) => ({ id, type: 'buy', symbol, qty, total: 100, currency: 'EUR', date, fee: 0, feeCurrency: 'EUR', note: '', fxLock: lock, accountId, txid, createdAt: '2025-01-01T00:00:00.000Z' });
const state = JSON.stringify({
  settings: { mainCurrency: 'EUR', costMethod: 'fifo', dateFormat: 'YYYY-MM-DD' },
  accounts: [acc('ada1', 'ADA hot', 'ADA', 'crypto'), acc('ada2', 'ADA cold', 'ADA', 'crypto'), acc('btc', 'BTC main', 'BTC', 'crypto'), acc('cash1', 'Bank', 'EUR', 'cash'), acc('cash2', 'Savings', 'EUR', 'cash')],
  trades: [
    buy('a1', 'ada1', 'ADA', 100, '2025-01-10', H1),
    buy('a2', 'ada2', 'ADA', 50, '2025-01-11', H1.toUpperCase()), // the same hash, other case: a duplicate
    buy('b1', 'btc', 'BTC', 0.1, '2025-01-12', H1), // other asset: fine
    { id: 't1', type: 'transfer', symbol: 'ADA', qty: 10, networkFee: 0.2, date: '2025-02-01', accountId: 'ada1', outputs: [{ toAccountId: 'ada2', qty: 9.8 }], txid: H2, currency: 'EUR', fee: 0, feeCurrency: 'EUR', note: '', fxLock: lock, createdAt: '2025-01-01T00:00:00.000Z' },
    { id: 'c1', type: 'income', symbol: 'EUR', qty: 10, total: 10, currency: 'EUR', date: '2025-01-05', fee: 0, feeCurrency: 'EUR', note: '', fxLock: lock, accountId: 'cash1', txid: 'REF1', createdAt: '2025-01-01T00:00:00.000Z' },
    { id: 'c2', type: 'income', symbol: 'EUR', qty: 10, total: 10, currency: 'EUR', date: '2025-01-05', fee: 0, feeCurrency: 'EUR', note: '', fxLock: lock, accountId: 'cash2', txid: 'REF1', createdAt: '2025-01-01T00:00:00.000Z' }
  ],
  priceOverrides: { ADA: { price: 1, vs: 'EUR' }, BTC: { price: 30000, vs: 'EUR' } }
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium(chromium, 'browser-tx-duplicates');
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript((s) => {
    localStorage.setItem('inoculens.consent.v1', JSON.stringify({ choice: 'declined' }));
    if (!sessionStorage.getItem('seeded')) { localStorage.setItem('inoculens.v2', s); sessionStorage.setItem('seeded', '1'); }
  }, state);
  const shot = (name) => process.env.SHOTS ? page.screenshot({ path: path.join(process.env.SHOTS, name + '.png') }) : null;

  // Cards of one account: which records show the pill / the Tx-row marker.
  async function cards(accountId) {
    await page.goto(base + '/account/' + accountId, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);
    await page.waitForSelector('.trade-block');
    // The startup intro covers the page until it closes.
    await page.waitForFunction(() => !document.getElementById('app-loader') || getComputedStyle(document.getElementById('app-loader')).display === 'none' || !document.body.classList.contains('is-app-loading'));
    await page.waitForSelector('#app-loader', { state: 'hidden' }).catch(() => {});
    return page.evaluate(() => Array.from(document.querySelectorAll('.trade-block')).map(b => ({
      id: b.getAttribute('data-trade'),
      pill: !!b.querySelector('.trade-head .trade-dup'),
      mark: (() => { const m = b.querySelector('.tx-dup-mark'); return m ? (m.classList.contains('is-open') ? 'Duplicate' : 'Ignored') : ''; })()
    })));
  }
  const byId = (list) => Object.fromEntries(list.map(c => [c.id, c]));

  // --- Existing duplicates: ADA on two accounts warns, nothing else does ---
  let ada1 = byId(await cards('ada1'));
  assert.equal(ada1.a1.pill, true, 'ADA duplicate warns on ADA hot');
  assert.equal(ada1.a1.mark, 'Duplicate');
  assert.equal(ada1.t1.pill, false, 'an internal transfer is one record: no warning');
  await shot('1-ada-hot-warning');
  let ada2 = byId(await cards('ada2'));
  assert.equal(ada2.a2.pill, true, 'and on ADA cold');
  assert.equal(ada2.t1.pill, false, 'the transfer shows under its destination without a warning');
  assert.equal(byId(await cards('btc')).b1.pill, false, 'BTC with the same hash is another asset');
  assert.equal(byId(await cards('cash1')).c1.pill, false, 'fiat records are not checked');

  // --- Ignore warning, then bring it back ---
  await cards('ada1');
  await page.click('[data-trade="a1"] .trade-dup');
  await page.waitForSelector('#txdup-dialog[open]');
  const listed = await page.$$eval('#txdup-list li', lis => lis.map(li => li.textContent));
  assert.equal(listed.length, 2, 'both records listed: ' + JSON.stringify(listed));
  assert.ok(listed.some(t => t.indexOf('ADA cold') !== -1), 'the other account is named');
  await shot('2-dialog');
  await page.click('#txdup-toggle');
  await page.waitForFunction(() => !document.getElementById('txdup-dialog').open);
  assert.equal(await page.evaluate(() => loadState().trades.filter(t => t.txidDupOk === true).map(t => t.id).sort().join()), 'a1,a2');
  ada1 = byId(await cards('ada1'));
  assert.equal(ada1.a1.pill, false, 'ignored: no pill');
  assert.equal(ada1.a1.mark, 'Ignored', 'a quiet marker stays as the way back');
  assert.equal(byId(await cards('ada2')).a2.pill, false, 'ignored for the whole group');
  await page.click('[data-trade="a2"] .tx-dup-mark');
  await page.waitForSelector('#txdup-dialog[open]');
  assert.equal(await page.textContent('#txdup-toggle'), 'Show warning again');
  await page.click('#txdup-toggle');
  await page.waitForFunction(() => !document.getElementById('txdup-dialog').open);
  assert.equal(byId(await cards('ada2')).a2.pill, true, 'warning back');

  // --- New record with a known hash: asks first ---
  async function addBuy(accountId, txid) {
    await page.evaluate(({ accountId, txid }) => {
      openPrefillTrade(accountId, true, 'buy');
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
      set('t-qty', '5'); set('t-total', '5'); set('t-date', '2025-03-01'); set('t-txid', txid);
      document.getElementById('t-submit').click();
    }, { accountId, txid });
  }
  const count = () => page.evaluate(() => loadState().trades.length);
  const n0 = await count();
  await addBuy('ada2', '  ' + H1 + ' ');
  await page.waitForSelector('#confirm-dialog[open]');
  const msg = await page.textContent('#confirm-message');
  assert.ok(/ADA transaction ID is already on 2 records/.test(msg), msg);
  await shot('3-save-anyway');
  await page.click('#confirm-cancel');
  await page.waitForFunction(() => !document.getElementById('confirm-dialog').open);
  await page.waitForTimeout(300); // the dialog's own close event settles first (as it does for a person)
  assert.equal(await count(), n0, 'Cancel saves nothing');
  assert.equal(await page.evaluate(() => document.getElementById('trade-dialog').open), true, 'the form stays open to fix the hash');
  await page.evaluate(() => document.getElementById('t-submit').click());
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-ok');
  await page.waitForFunction((n) => !tradeSubmitBusy && loadState().trades.length === n + 1, n0, { timeout: 20000 });
  assert.equal(await page.evaluate((h) => loadState().trades.filter(t => String(t.txid).toLowerCase() === h && t.symbol === 'ADA').every(t => t.txidDupOk === true), H1), true,
    'Save anyway marks the whole group');
  assert.equal(byId(await cards('ada2')).a2.pill, false, 'confirmed group stays quiet');

  // --- Unique hash and other assets save without a question ---
  const n1 = await count();
  await addBuy('btc', 'cafebabe');
  await page.waitForFunction((n) => !tradeSubmitBusy && loadState().trades.length === n + 1, n1, { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.getElementById('confirm-dialog').open), false);

  // --- Phone layout: the pill sits in the head without breaking it ---
  await page.evaluate(() => { const s = loadState(); s.trades.forEach(t => { delete t.txidDupOk; }); saveState(s); });
  await page.setViewportSize({ width: 390, height: 844 });
  await cards('ada1');
  const geo = await page.evaluate(() => {
    const b = document.querySelector('[data-trade="a1"]');
    const pill = b.querySelector('.trade-dup').getBoundingClientRect();
    const acts = b.querySelector('.trade-actions').getBoundingClientRect();
    return { overlap: !(pill.right <= acts.left || pill.top >= acts.bottom || pill.bottom <= acts.top), scroll: document.documentElement.scrollWidth > innerWidth };
  });
  assert.equal(geo.overlap, false, 'pill never slides under the ▾ ✎ 🗑 corner');
  assert.equal(geo.scroll, false, 'no horizontal scroll');
  await shot('4-phone');

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('browser-tx-duplicates: OK');
})().catch(e => { console.error(e); process.exit(1); });
