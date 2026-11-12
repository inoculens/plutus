#!/usr/bin/env node
'use strict';
// Real-browser XSS check. Seeds hostile strings into every user-controlled
// text field, boots the actual page from a static server under its real CSP,
// walks home -> account -> trade views, and fails if any payload executes,
// any hostile element/attribute appears, or the CSP reports a violation.
// Skips (exit 0, clearly labelled) when Playwright/Chromium is unavailable
// so it never claims a pass it did not run.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
let chromium;
try { chromium = require('playwright').chromium; } catch (e) {
  console.log('browser-xss: SKIPPED (playwright not installed)'); process.exit(0);
}
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p.indexOf('/account') === 0) p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

const PAYLOADS = [
  '<script>window.__xss=1</script>',
  '<img src=x onerror="window.__xss=2">',
  '<svg onload="window.__xss=3"></svg>',
  '"><img src=x onerror=window.__xss=4>',
  "' onmouseover='window.__xss=5' x='",
  'javascript:window.__xss=6',
  '&lt;b&gt;&amp;#60;script&amp;#62;',
  'evil‮txt.exe⁦⁩\u0007',
  '</textarea><script>window.__xss=7</script>',
  '"]\\"><script>window.__xss=8</script>'
];
const P = PAYLOADS;
const acct = (id, i, extra) => Object.assign({ id, name: P[i % P.length], ticker: 'BTC', kind: 'crypto', address: P[(i + 1) % P.length], createdAt: '2026-01-01T00:00:00.000Z' }, extra || {});
const state = {
  settings: { mainCurrency: 'EUR', costMethod: 'fifo', assetLedgers: true, dateFormat: 'YYYY-MM-DD' },
  accounts: P.map((_, i) => acct('acc' + i, i)),
  trades: P.map((_, i) => ({ id: 'tr' + i, type: 'buy', accountId: 'acc' + (i % P.length), symbol: 'BTC', qty: 1, total: 100,
    date: '2026-01-02', currency: 'EUR', notes: P[i], ledgerLabel: P[(i + 2) % P.length].slice(0, 80),
    attachment: { name: P[i].slice(0, 120), mime: 'application/pdf', size: 10, hash: 'abcdef0123456789' } })),
  priceOverrides: {}
};

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const problems = [];
  let dialogs = 0;
  page.on('dialog', d => { dialogs++; d.dismiss().catch(() => {}); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text()) && !/googletagmanager|google-analytics|accounts\.google/i.test(m.text())) problems.push('csp: ' + m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.addInitScript(s => { try { localStorage.setItem('inoculens.v2', s); localStorage.setItem('inoculens.consent.v1', 'declined'); } catch (e) {} }, JSON.stringify({ app: 'inoculens-plutus', version: 2, ...state }));
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const views = ['#/', '#/account/acc0', '#/account/acc3', '#/account/acc7'];
  for (const v of views) {
    await page.evaluate(h => { location.hash = h; }, v);
    await page.waitForTimeout(500);
    // open every visible "details" style control a user could click
    for (const sel of ['.tx-link', '[data-trade]']) {
      const els = await page.$$(sel);
      for (const e of els.slice(0, 12)) { try { await e.hover({ timeout: 500 }); } catch (_) {} }
    }
  }
  const result = await page.evaluate(() => {
    const bad = [];
    const hostileTags = document.querySelectorAll('main script, main img[src="x"], main svg[onload], #app-loader script');
    if (hostileTags.length) bad.push('hostile element count ' + hostileTags.length);
    document.querySelectorAll('body *').forEach(el => {
      for (const a of el.attributes) {
        if (/^on/i.test(a.name)) bad.push('inline handler attr ' + a.name + ' on <' + el.tagName + '>');
        if ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value)) bad.push('javascript: url on <' + el.tagName + '>');
      }
    });
    return { xss: window.__xss || null, bad, text: document.body.innerText.length, hasPayloadText: document.body.innerText.indexOf('<script>') !== -1 || document.body.innerText.indexOf('onerror') !== -1 };
  });
  await browser.close(); server.close();
  assert.equal(result.xss, null, 'a payload executed: window.__xss=' + result.xss);
  assert.equal(dialogs, 0, 'a dialog was triggered');
  assert.deepEqual(result.bad, [], 'hostile DOM: ' + result.bad.join('; '));
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(result.hasPayloadText, 'payload strings should be visible as plain text (proves the data actually rendered)');
  console.log('browser-xss: OK');
})().catch(e => { console.error(e); try { server.close(); } catch (_) {} process.exit(1); });
