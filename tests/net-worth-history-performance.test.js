#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'net-worth-history.js'), 'utf8');
const marker = '  root.NetWorthHistory = { update: update, refresh: refresh };';
assert(src.includes(marker), 'chart test hook marker missing');
const instrumented = src.replace(marker, [
  '  root.__netWorthHistoryTest = {',
  '    samplePoints: samplePoints,',
  '    setActive: function (data) { active = data; },',
  '    visiblePoints: visiblePoints',
  '  };',
  marker
].join('\n'));
const context = { Promise, Date, Math, isFinite };
context.window = context;
vm.createContext(context);
vm.runInContext(instrumented, context, { filename: 'net-worth-history.js' });

const chart = context.__netWorthHistoryTest;
const points = Array.from({ length: 100000 }, function (_, index) {
  return { at: index, value: Math.sin(index / 300) };
});
points[54321].value = 100;
points[87654].value = -100;

const width = 866;
const sampled = chart.samplePoints(points, points[0].at, points[points.length - 1].at, width);
assert(sampled.length <= width * 2 + 2, 'path sample should scale with chart width');
assert.equal(sampled[0], points[0], 'path sample should retain its first point');
assert.equal(sampled[sampled.length - 1], points[points.length - 1], 'path sample should retain its last point');
assert(sampled.includes(points[54321]), 'path sample should preserve a local peak');
assert(sampled.includes(points[87654]), 'path sample should preserve a local trough');

chart.setActive({ points });
const visible = chart.visiblePoints({ start: 54321, end: 54330 });
assert.equal(visible.length, 10);
assert.equal(visible[0], points[54321]);
assert.equal(visible[visible.length - 1], points[54330]);

console.log('net worth history performance checks passed');
