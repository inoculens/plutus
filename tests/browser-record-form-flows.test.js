#!/usr/bin/env node
'use strict';
// Every record type entered through the real form, in a real browser, ends
// up stored exactly as expected: buy, sell, swap (new and edited), transfer
// to an own account with a network fee, cash income with a ledger code and
// a cash expense. Network blocked; one fiat (EUR) so no FX lookups are
// needed. Values compared after dropping generated ids and timestamps. All
// figures are invented.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadChromium, launchChromium } = require('./browser-env');

const chromium = loadChromium('browser-record-form-flows');
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

const acc = (id, name, ticker, kind) => ({ id, name, ticker, kind, createdAt: '2025-01-01T00:00:00.000Z' });
const state = JSON.stringify({
  settings: { mainCurrency: 'EUR', costMethod: 'fifo', dateFormat: 'YYYY-MM-DD' },
  accounts: [acc('btc', 'BTC main', 'BTC', 'crypto'), acc('btc2', 'BTC cold', 'BTC', 'crypto'), acc('eth', 'ETH', 'ETH', 'crypto'), acc('cash', 'Cash', 'EUR', 'cash')],
  trades: [],
  priceOverrides: { BTC: { price: 30000, vs: 'EUR' }, ETH: { price: 2000, vs: 'EUR' } }
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium(chromium, 'browser-record-form-flows');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript((s) => {
    localStorage.setItem('inoculens.consent.v1', JSON.stringify({ choice: 'declined' }));
    if (!sessionStorage.getItem('seeded')) { localStorage.setItem('inoculens.v2', s); sessionStorage.setItem('seeded', '1'); }
  }, state);
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof uiBooted !== 'undefined' && uiBooted);

  // Fill the open form like a user (input + change events), submit, wait.
  async function submit(open, fields, after) {
    const before = await page.evaluate(() => JSON.stringify(loadState().trades));
    await page.evaluate(({ open, fields, after }) => {
      if (open.edit) openEditTrade(open.edit); else openPrefillTrade(open.account, true, open.type);
      const set = (id, v) => {
        const e = document.getElementById(id);
        if (!e) throw new Error('no field #' + id);
        e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      };
      Object.keys(fields).forEach(k => set(k, fields[k]));
      if (after === 'recipient') {
        // Transfers: "You send" is derived from the source row; the network
        // fee fills itself in (sent - recipients).
        addRecipientRow({ kind: 'internal', accountId: 'btc2', qty: '0.05' });
        const sq = document.querySelector('#t-source-list .src-row .src-qty');
        sq.value = '0.0501';
        sq.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.getElementById('t-submit').click();
    }, { open, fields, after });
    await page.waitForFunction((b) => !tradeSubmitBusy && JSON.stringify(loadState().trades) !== b, before, { timeout: 20000 })
      .catch(async () => { throw new Error('not saved: ' + await page.evaluate(() => JSON.stringify({ error: document.getElementById('t-error').textContent, banner: (document.getElementById('banner') || {}).textContent, open: document.getElementById('trade-dialog').open, fee: (document.getElementById('t-networkfee') || {}).value, rows: readRecipientRows(), srcs: readSourceRows(), invalid: Array.from(document.querySelectorAll('#trade-dialog :invalid')).map(e => e.id || e.className), selfrecv: (document.getElementById('t-selfrecv')||{}).value, confirm: document.getElementById('confirm-dialog').open ? document.getElementById('confirm-dialog').textContent.replace(/\s+/g, ' ') : '' }))); });
  }
  const stored = () => page.evaluate(() => loadState().trades.map(t => {
    const o = {};
    Object.keys(t).sort().forEach(k => {
      if (k === 'id' || k === 'createdAt' || k === 'updatedAt') return;
      o[k] = k === 'swapId' ? 'linked' : t[k];
    });
    return o;
  }));
  const one = (list, pred, what) => { const m = list.filter(pred); assert.equal(m.length, 1, what + ': ' + JSON.stringify(list)); return m[0]; };

  await submit({ account: 'btc', type: 'buy' }, { 't-qty': '0.5', 't-total': '10000', 't-date': '2025-01-10', 't-fee': '5' });
  await submit({ account: 'btc', type: 'sell' }, { 't-qty': '0.1', 't-total': '2500', 't-date': '2025-02-10' });
  await submit({ account: 'btc', type: 'swap' }, { 't-toaccount': 'eth', 't-qty': '0.1', 't-toqty': '1.5', 't-total': '2400', 't-date': '2025-03-10' });
  let list = await stored();
  const buy = one(list, t => t.type === 'buy' && t.accountId === 'btc', 'buy');
  assert.equal(buy.qty, 0.5); assert.equal(buy.total, 10000); assert.equal(buy.fee, 5); assert.equal(buy.currency, 'EUR'); assert.equal(buy.date, '2025-01-10');
  assert.deepEqual(buy.fxLock, { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false });
  const sell = one(list, t => t.type === 'sell' && t.date === '2025-02-10', 'sell');
  assert.equal(sell.qty, 0.1); assert.equal(sell.total, 2500);
  const swapSell = one(list, t => t.type === 'sell' && t.swapId, 'swap sell leg');
  const swapBuy = one(list, t => t.type === 'buy' && t.swapId, 'swap buy leg');
  assert.deepEqual([swapSell.accountId, swapSell.symbol, swapSell.qty, swapSell.total, swapSell.date], ['btc', 'BTC', 0.1, 2400, '2025-03-10']);
  assert.deepEqual([swapBuy.accountId, swapBuy.symbol, swapBuy.qty, swapBuy.total, swapBuy.date], ['eth', 'ETH', 1.5, 2400, '2025-03-10']);
  const swapIds = await page.evaluate(() => loadState().trades.filter(t => t.swapId).map(t => t.swapId));
  assert.equal(swapIds[0], swapIds[1], 'both legs share one swapId');

  // Edit the swap: the pair changes together.
  const sellLegId = await page.evaluate(() => loadState().trades.find(t => t.swapId && t.type === 'sell').id);
  await submit({ edit: sellLegId }, { 't-toqty': '1.6', 't-total': '2600' });
  list = await stored();
  assert.equal(list.filter(t => t.swapId).length, 2, 'still one pair');
  assert.equal(one(list, t => t.type === 'buy' && t.swapId, 'edited buy leg').qty, 1.6);
  assert.equal(one(list, t => t.type === 'sell' && t.swapId, 'edited sell leg').total, 2600);
  assert.equal(one(list, t => t.type === 'buy' && t.swapId, 'edited buy leg').total, 2600);

  await submit({ account: 'btc', type: 'transfer' }, { 't-date': '2025-04-10' }, 'recipient');
  list = await stored();
  const tr = one(list, t => t.type === 'transfer', 'transfer');
  assert.equal(tr.accountId, 'btc'); assert.equal(tr.qty, 0.0501); assert.equal(Number(tr.networkFee), 0.0001);
  assert.equal(JSON.stringify(tr.outputs || [{ toAccountId: tr.toAccountId }]).indexOf('btc2') !== -1, true, 'to BTC cold: ' + JSON.stringify(tr));

  await submit({ account: 'cash', type: 'income' }, { 't-qty': '1000', 't-date': '2025-05-10', 't-ledger': '100', 't-ledger-label': 'Sales' });
  await submit({ account: 'cash', type: 'expense' }, { 't-qty': '50', 't-date': '2025-05-11' });
  list = await stored();
  const inc = one(list, t => t.type === 'income', 'income');
  assert.deepEqual([inc.accountId, inc.symbol, inc.qty, inc.total, inc.ledger], ['cash', 'EUR', 1000, 1000, '100']);
  const exp = one(list, t => t.type === 'expense', 'expense');
  assert.deepEqual([exp.accountId, exp.symbol, exp.qty], ['cash', 'EUR', 50]);

  // Holdings across the whole flow (FIFO): 0.5 - 0.1 sold - 0.1 swapped - 0.0501 sent.
  const held = await page.evaluate(() => {
    const pf = computePortfolio(loadState().trades, { BTC: 30000, ETH: 2000 }, 'fifo');
    const q = (a, s) => (pf.byAccount[a] && pf.byAccount[a].get(s)) ? pf.byAccount[a].get(s).qtyHeld : 0;
    return { btc: q('btc', 'BTC'), btc2: q('btc2', 'BTC'), eth: q('eth', 'ETH'), cash: cashBalance(loadState().trades, 'cash', 'EUR').main };
  });
  const near = (a, b, w) => assert.ok(Math.abs(a - b) < 1e-9, w + ': ' + a + ' vs ' + b);
  near(held.btc, 0.2499, 'BTC main'); near(held.btc2, 0.05, 'BTC cold'); near(held.eth, 1.6, 'ETH'); near(held.cash, 950, 'cash');
  assert.equal(await page.evaluate(() => (loadState().accounts.find(a => a.id === 'cash').ledgers || {})['100']), 'Sales', 'ledger label learned into the account chart');

  assert.deepEqual(errors, []);
  if (process.env.DUMP) console.log(JSON.stringify(list, null, 1));
  await browser.close();
  server.close();
  console.log('browser-record-form-flows: OK');
})().catch(e => { console.error(e); process.exit(1); });
