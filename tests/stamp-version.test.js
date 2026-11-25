#!/usr/bin/env node
'use strict';
// stamp-version.sh (the Netlify build command) must:
// - stamp the commit id + count into APP_VERSION (when git is available);
// - give every local script and stylesheet tag in index.html a ?v= checksum
//   of that file's own content, with or without git, so a deploy changes
//   exactly the URLs of the files that changed (they are cached forever);
// - leave everything else in index.html alone.
// Runs the real script on copies in throwaway directories.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cksum = file => sh('cksum', [file]).split(' ')[0];
const assetRe = /(?:src|href)="\/([^"?]+\.(?:js|css))\?v=([^"]*)"/g;
const versions = html => new Map([...html.matchAll(assetRe)].map(m => [m[1], m[2]]));
const unstamp = s => s.replace(/(\.(?:js|css))\?v=[A-Za-z0-9]+"/g, '$1?v=X"');

function copyTree(dir) {
  for (const f of ['index.html', 'stamp-version.sh']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  fs.cpSync(path.join(root, 'js'), path.join(dir, 'js'), { recursive: true });
  fs.cpSync(path.join(root, 'css'), path.join(dir, 'css'), { recursive: true });
}

const before = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const assets = versions(before);
assert.ok(assets.size > 100, 'index.html references its scripts and styles with ?v=');

// 1. In a git checkout.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plutus-stamp-'));
  try {
    copyTree(dir);
    const git = (...a) => sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'].concat(a), dir);
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'one'); git('add', '.'); git('commit', '-q', '-m', 'two');
    const hash = git('rev-parse', '--short', 'HEAD');
    sh('sh', ['stamp-version.sh'], dir);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(fs.readFileSync(path.join(dir, 'js', 'app.js'), 'utf8'), new RegExp("^var APP_VERSION = '" + hash + " \\(#2\\)';$", 'm'), 'APP_VERSION stamped');
    const stamped = versions(html);
    assert.deepEqual([...stamped.keys()], [...assets.keys()], 'same assets, same order');
    for (const [f, v] of stamped) assert.equal(v, cksum(path.join(dir, f)), f + ' carries its own content checksum');
    assert.equal(unstamp(html), unstamp(before), 'only the .js/.css cache-busters changed');

    // A rebuild where one file changed: only that URL changes.
    const target = 'js/ui/format.js';
    fs.appendFileSync(path.join(dir, target), '\n// edited\n');
    sh('sh', ['stamp-version.sh'], dir);
    const again = versions(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'));
    for (const [f, v] of again) {
      if (f === target || f === 'js/app.js') continue; // app.js holds the stamped version
      assert.equal(v, stamped.get(f), f + ' keeps its URL');
    }
    assert.notEqual(again.get(target), stamped.get(target), 'the edited file gets a new URL');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Without git (e.g. a deploy from an exported folder): cache-busters are
// still stamped, APP_VERSION keeps its checked-in fallback, the build passes.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plutus-stamp-nogit-'));
  try {
    copyTree(dir);
    const fallback = /^var APP_VERSION = '.*';$/m.exec(fs.readFileSync(path.join(dir, 'js', 'app.js'), 'utf8'))[0];
    execFileSync('sh', ['stamp-version.sh'], { cwd: dir, stdio: 'pipe', env: Object.assign({}, process.env, { GIT_DIR: path.join(dir, 'no-such-repo'), GIT_CEILING_DIRECTORIES: path.dirname(dir) }) });
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(fs.readFileSync(path.join(dir, 'js', 'app.js'), 'utf8'), new RegExp('^' + fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'), 'APP_VERSION fallback untouched');
    for (const [f, v] of versions(html)) assert.equal(v, cksum(path.join(dir, f)), f + ' stamped without git');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('stamp-version checks passed');
