#!/usr/bin/env node
'use strict';
// stamp-version.sh (the Netlify build command) must stamp the commit id +
// count into APP_VERSION and the commit id into EVERY local script and
// stylesheet cache-buster in index.html, leaving everything else alone.
// Runs the real script on copies inside a throwaway git repository.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plutus-stamp-'));
try {
  for (const f of ['index.html', 'app.js', 'stamp-version.sh']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'one');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'two');
  const hash = git('rev-parse', '--short', 'HEAD');
  const before = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  execFileSync('sh', ['stamp-version.sh'], { cwd: dir, stdio: 'pipe' });
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');

  assert.match(app, new RegExp("^var APP_VERSION = '" + hash + " \\(#2\\)';$", 'm'), 'APP_VERSION stamped');
  const assets = [...before.matchAll(/(?:src|href)="(\/[^"?]+\.(?:js|css))\?v=[^"]*"/g)].map(m => m[1]);
  assert.ok(assets.length > 3, 'index.html references its scripts and styles with ?v=');
  for (const a of assets) assert.ok(html.includes(a + '?v=' + hash + '"'), a + ' stamped with ?v=' + hash);
  // Nothing else changes (icons, manifest keep their own versions).
  const unstamp = s => s.replace(/(\.(?:js|css))\?v=[A-Za-z0-9]+"/g, '$1?v=X"');
  assert.equal(unstamp(html), unstamp(before), 'only the .js/.css cache-busters changed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('stamp-version checks passed');
