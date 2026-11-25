#!/usr/bin/env node
'use strict';
// Real-browser checks for the startup loader (js/boot/startup-loader.js):
// - the intro animates only compositor-friendly properties (transform,
//   opacity), so a busy boot cannot make it stutter or leave a coin blurred;
// - with a heavy store (hundreds of records) the loader closes only after
//   every intro animation has finished AND the app is ready;
// - if the app never boots, the page is still uncovered after load;
// - reduced motion: no intro, the page is revealed after load.
// All figures are invented. Fails in CI-required mode, prints SKIP locally,
// when Playwright or Chromium is unavailable (see browser-env.js).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadChromium, launchChromium } = require('./browser-env');

const chromium = loadChromium('browser-startup-loader');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
let breakApp = false;
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p.indexOf('/account') === 0) p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  if (breakApp && p === '/js/app.js') { // the app throws while booting
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end("document.addEventListener('DOMContentLoaded', function () { throw new Error('boot failed'); });");
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

function heavyState(n) {
  const accounts = [{ id: 'a1', name: 'Wallet', ticker: 'BTC', kind: 'crypto' }, { id: 'c1', name: 'Cash', ticker: 'EUR', kind: 'cash' }];
  const trades = [];
  for (let i = 0; i < n; i++) {
    const day = '2024-' + String(1 + (i % 12)).padStart(2, '0') + '-' + String(1 + (i % 28)).padStart(2, '0');
    trades.push(i % 3 ? { id: 'b' + i, type: 'buy', accountId: 'a1', symbol: 'BTC', qty: 0.01, total: 300, currency: 'EUR', date: day }
      : { id: 'c' + i, type: 'income', accountId: 'c1', symbol: 'EUR', qty: 100, total: 100, currency: 'EUR', date: day });
  }
  return JSON.stringify({ settings: { mainCurrency: 'EUR', costMethod: 'fifo' }, accounts, trades, priceOverrides: {} });
}

async function openPage(browser, base, opts) {
  const ctx = await browser.newContext(opts.reducedMotion ? { reducedMotion: 'reduce' } : {});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript((state) => {
    try { localStorage.setItem('inoculens.consent.v1', 'declined'); if (state) localStorage.setItem('inoculens.v2', state); } catch (e) { /* ignore */ }
    window.__loaderLog = { hiddenAt: 0, animEnds: [] };
    new MutationObserver(() => {
      const l = document.getElementById('app-loader');
      if (l && l.hidden && !window.__loaderLog.hiddenAt) window.__loaderLog.hiddenAt = performance.now();
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('animationend', e => {
      if (e.target.closest && e.target.closest('#app-loader')) window.__loaderLog.animEnds.push(performance.now());
    }, true);
  }, opts.state || null);
  await page.goto(base + '/', { waitUntil: 'load' });
  return { ctx, page, errors };
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchChromium(chromium, 'browser-startup-loader');

  // 1. Heavy store: the intro plays to the end, then the loader closes.
  {
    const { ctx, page, errors } = await openPage(browser, base, { state: heavyState(800) });
    const props = await page.evaluate(() => {
      const out = {};
      document.getElementById('app-loader').getAnimations({ subtree: true }).forEach(a => {
        a.effect.getKeyframes().forEach(k => Object.keys(k).forEach(p => {
          if (['offset', 'computedOffset', 'easing', 'composite'].indexOf(p) === -1) out[p] = true;
        }));
      });
      return Object.keys(out).sort();
    });
    assert.ok(props.length > 0, 'the intro is running');
    assert.deepEqual(props.filter(p => p !== 'transform' && p !== 'opacity'), [], 'intro animates only transform/opacity, got ' + props.join(','));
    await page.waitForFunction(() => document.getElementById('app-loader').hidden, null, { timeout: 15000 });
    const log = await page.evaluate(() => window.__loaderLog);
    assert.equal(log.animEnds.length, 11, 'every intro animation finished (3 coins x 3 layers, logo, progress bar); got ' + log.animEnds.length);
    assert.ok(log.hiddenAt >= Math.max.apply(null, log.animEnds), 'loader hid only after the last intro animation ended');
    const after = await page.evaluate(() => ({
      busy: document.getElementById('app-loader').getAttribute('aria-busy'),
      locked: document.documentElement.classList.contains('is-app-loading') || document.body.classList.contains('is-app-loading'),
      booted: uiBooted
    }));
    assert.deepEqual(after, { busy: 'false', locked: false, booted: true });
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // 2. The app fails to boot: the page is still uncovered after load.
  {
    breakApp = true;
    const { ctx, page } = await openPage(browser, base, {});
    await page.waitForFunction(() => document.getElementById('app-loader').hidden, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains('is-app-loading')), false, 'scroll lock released');
    breakApp = false;
    await ctx.close();
  }

  // 3. Reduced motion: no intro, revealed after load.
  {
    const { ctx, page, errors } = await openPage(browser, base, { reducedMotion: true });
    assert.equal(await page.evaluate(() => document.getElementById('app-loader').classList.contains('is-running')), false, 'no intro');
    await page.waitForFunction(() => document.getElementById('app-loader').hidden, null, { timeout: 5000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log('browser-startup-loader: OK');
})().catch(e => { console.error(e); process.exit(1); });
