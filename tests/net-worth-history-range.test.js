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
  '    setActive: function (data) { active = data; },',
  '    setRangeDrag: function (drag) { rangeDrag = drag; },',
  '    moveRangeFromPointer: moveRangeFromPointer,',
  '  };',
  marker
].join('\n'));

const handles = {
  'history-range-start': {
    attributes: { 'aria-valuenow': '500' },
    style: {},
    setAttribute: function (name, value) { this.attributes[name] = value; }
  },
  'history-range-end': {
    attributes: { 'aria-valuenow': '1000' },
    style: {},
    setAttribute: function (name, value) { this.attributes[name] = value; }
  }
};
const context = { Promise, Date, Math, isFinite };
context.window = context;
context.document = {
  getElementById: function (id) { return handles[id] || null; }
};
vm.createContext(context);
vm.runInContext(instrumented, context, { filename: 'net-worth-history.js' });

const chart = context.__netWorthHistoryTest;
chart.setActive({ points: [] });
chart.setRangeDrag({ startChanged: true, pointerOffset: 6 });
const track = { getBoundingClientRect: function () { return { left: 100, width: 200 }; } };

chart.moveRangeFromPointer({ clientX: 206 }, track);
assert.equal(handles['history-range-start'].attributes['aria-valuenow'], '500',
  'clicking off-center on the thumb should keep its position');
assert.equal(handles['history-range-start'].style.left, '50%');

chart.moveRangeFromPointer({ clientX: 226 }, track);
assert.equal(handles['history-range-start'].attributes['aria-valuenow'], '600',
  'dragging should move the thumb by the pointer delta');

console.log('net worth history range checks passed');
