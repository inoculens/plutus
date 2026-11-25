'use strict';
// Loads the app the way index.html does. The app is a list of classic
// scripts sharing one global scope (deferred <script> tags, executed in
// order); tests read that list from index.html so it can never drift.
//
//   appScripts()  repo-relative paths, in load order
//   appSource()   their concatenated source (for one vm.runInContext call
//                 and for source-text assertions)
//   styleSheets() / cssSource()  the same for the stylesheets (cascade order)
//
// The net-worth chart component (js/ui/net-worth-chart.js) is a
// self-contained module with its own tests and is left out by default.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CHART = 'js/ui/net-worth-chart.js';

function appScripts(opts) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const list = [...html.matchAll(/<script src="\/([^"?]+\.js)(?:\?[^"]*)?" defer><\/script>/g)].map(m => m[1]);
  if (!list.length || list[list.length - 1] !== 'app.js') throw new Error('index.html: app.js must be the last deferred script');
  return opts && opts.withChart ? list : list.filter(f => f !== CHART);
}

function appSource(opts) {
  return appScripts(opts).map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
}

// Stylesheets in cascade order, as index.html links them.
function styleSheets() {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  return [...html.matchAll(/<link rel="stylesheet" href="\/([^"?]+\.css)(?:\?[^"]*)?">/g)].map(m => m[1]);
}

function cssSource() {
  return styleSheets().map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
}

module.exports = { appScripts, appSource, styleSheets, cssSource, root };
