#!/usr/bin/env node
'use strict';
// The page must ship a real Content-Security-Policy: scripts only from this
// site plus the two Google hosts the app loads on demand, no inline scripts
// (so injected markup cannot run), and the other directives that stop base-tag
// and form hijacking. Also checks that /account/* gets the same response
// headers as the app shell, and that the CSP meta tag comes before any script.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');

const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
assert.ok(m, 'index.html has a CSP meta tag');
const dirs = {};
m[1].split(';').map(s => s.trim()).filter(Boolean).forEach(d => { const p = d.split(/\s+/); dirs[p[0]] = p.slice(1); });

assert.deepEqual(dirs['default-src'], ["'self'"]);
assert.ok(dirs['script-src'], 'script-src is set');
assert.ok(!dirs['script-src'].includes("'unsafe-inline'") && !dirs['script-src'].includes("'unsafe-eval'"), 'script-src has no unsafe-inline / unsafe-eval');
assert.deepEqual(dirs['script-src'].slice().sort(), ["'self'", 'https://accounts.google.com', 'https://www.googletagmanager.com']);
assert.deepEqual(dirs['base-uri'], ["'self'"]);
assert.deepEqual(dirs['form-action'], ["'self'"]);
assert.ok(dirs['object-src'] && dirs['object-src'].includes('blob:'), 'attachment embeds (blob:) stay allowed');
assert.ok(dirs['img-src'].includes('blob:') && dirs['img-src'].includes('data:'), 'attachment images stay allowed');
assert.ok(dirs['connect-src'].includes('https:'), 'user-chosen WebDAV / S3 hosts still reachable');

// No executable inline scripts: every <script> either has a src or is JSON-LD data.
const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map(x => x[1]);
assert.ok(scripts.length > 0);
for (const attrs of scripts) {
  assert.ok(/\bsrc=/.test(attrs) || /type="application\/ld\+json"/.test(attrs), 'inline script found: <script' + attrs + '>');
}
// The CSP must be parsed before the first script runs.
assert.ok(html.indexOf('Content-Security-Policy') < html.search(/<script\b/i), 'CSP meta precedes every script');
// Both extracted files exist and the page references them.
for (const f of ['consent-default.js', 'loader-recovery.js']) {
  assert.ok(fs.existsSync(path.join(root, 'js', f)), 'js/' + f + ' exists');
  assert.ok(html.includes('/js/' + f), 'index.html loads /js/' + f);
}
// The consent default must run before app.js and stay synchronous (no defer/async).
const consentTag = /<script src="\/js\/consent-default\.js[^"]*"([^>]*)>/.exec(html);
assert.ok(consentTag && !/defer|async/.test(consentTag[1]), 'consent default is a blocking script');
assert.ok(html.indexOf('/js/consent-default.js') < html.indexOf('/app.js'), 'consent default precedes app.js');

// Headers for rewritten account URLs.
for (const p of ['/account/*', '/account']) {
  const re = new RegExp('\\[\\[headers\\]\\]\\s*\\n\\s*for = "' + p.replace(/[*/]/g, '\\$&') + '"[\\s\\S]*?(?=\\n\\[\\[|$)');
  const blk = re.exec(toml);
  assert.ok(blk, 'netlify.toml has a headers block for ' + p);
  for (const h of ['X-Frame-Options = "DENY"', 'X-Content-Type-Options = "nosniff"', 'Referrer-Policy', 'Permissions-Policy']) {
    assert.ok(blk[0].includes(h), p + ' sets ' + h);
  }
}
console.log('csp-and-headers: ok');
