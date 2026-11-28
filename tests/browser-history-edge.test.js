#!/usr/bin/env node
'use strict';
// The net worth line must reach the chart's right edge while the page stays
// open. The time axis used to end at the clock while the newest point kept
// the time of the first reading in its 5-minute slot, so every redraw pushed
// the line further left and left a widening blank strip on the right (most
// visible on a new profile, whose whole chart spans minutes). Network
// blocked except fake daily candles; the live price is a manual override.
// Figures invented.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadChromium, launchChromium } = require('./browser-env');

const chromium = loadChromium('browser-history-edge');
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

const opened = Date.parse('2026-11-28T09:00:00Z');
// A new profile: one account, one buy made today.
const state = JSON.stringify({
  settings: { mainCurrency: 'EUR', costMethod: 'average' },
  accounts: [{ id: 'eth', name: 'ETH', ticker: 'ETH', kind: 'crypto' }],
  trades: [{ id: 'b1', type: 'buy', accountId: 'eth', symbol: 'ETH', qty: 2, total: 4000, currency: 'EUR', date: '2026-11-28',
    fxLock: { pair: 'EUR/EUR', rate: 1, source: '1:1', interpolated: false } }],
  priceOverrides: { ETH: 2000 }
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium(chromium, 'browser-history-edge');
  const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Daily candles for the history; every other host is blocked.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'api.exchange.coinbase.com' || !url.pathname.endsWith('/candles')) return route.abort();
    const rows = [];
    for (let t = Math.floor(Date.parse(url.searchParams.get('start')) / 86400000) * 86400000;
      t <= Date.parse(url.searchParams.get('end')); t += 86400000) rows.unshift([t / 1000, 2000, 2000, 2000, 2000, 1]);
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(rows) });
  });
  await page.clock.install({ time: opened });
  await page.addInitScript((s) => {
    localStorage.setItem('inoculens.consent.v1', JSON.stringify({ choice: 'declined' }));
    if (!localStorage.getItem('inoculens.v2')) localStorage.setItem('inoculens.v2', s);
  }, state);
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#history-plot path.history-line') &&
    document.getElementById('networth-history').getAttribute('aria-busy') === 'false', null, { timeout: 60000 });

  async function lineEnd() {
    return page.evaluate(() => {
      const svg = document.getElementById('history-plot');
      const nums = svg.querySelector('path.history-line').getAttribute('d')
        .trim().split(/[ ,]+/).filter(x => /^-?[\d.]+$/.test(x)).map(Number);
      return { x: nums[nums.length - 2], right: Number(svg.getAttribute('viewBox').split(' ')[2]) - 12 };
    });
  }
  // Default view on a profile whose only record is from today: the history
  // load gives one point and live readings (one per app render, kept per
  // 5-minute slot) draw the rest of the line.
  await page.clock.runFor('06:00');
  await page.evaluate(() => render());
  await page.waitForFunction(() => /C /.test(document.querySelector('#history-plot path.history-line').getAttribute('d')));
  function atEdge(end, when) {
    assert.ok(Math.abs(end.x - end.right) < 0.5, when + ', the line reaches the right edge: ' + JSON.stringify(end));
  }
  atEdge(await lineEnd(), 'with two readings');
  // Time passes with the page open. Redraws without a new reading (hovering
  // the plot) and app renders with one must both keep the line at the edge.
  for (const step of ['00:30', '02:00', '04:00', '20:00']) {
    await page.clock.runFor(step);
    await page.locator('#history-plot').hover();
    await page.mouse.move(5, 5);
    atEdge(await lineEnd(), 'after +' + step + ' and a redraw');
    await page.evaluate(() => render());
    atEdge(await lineEnd(), 'after +' + step + ' and a render');
  }
  assert.deepEqual(errors, [], 'no page errors');
  await browser.close();
  server.close();
  console.log('browser-history-edge: OK');
})().catch(async e => { console.error(e); process.exit(1); });
