#!/usr/bin/env node
'use strict';

// Deferred work (save and chart-load kick-off) must run exactly once even when
// the browser never fires animation frames, as in hidden or occluded tabs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeClock(withFrames) {
  const timers = [];
  const frames = [];
  const clock = {
    setTimeout: function (callback, delay) { timers.push({ callback, delay: delay || 0 }); },
    requestAnimationFrame: withFrames ? function (callback) { frames.push(callback); } : undefined,
    runFrames: function () { while (frames.length) frames.shift()(); },
    runTimers: function () {
      while (timers.length) {
        timers.sort(function (a, b) { return a.delay - b.delay; });
        timers.shift().callback();
      }
    }
  };
  return clock;
}

function load(file, startMarker, endMarker) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert(start >= 0 && end > start, file + ': ' + startMarker + ' not found');
  return src.slice(start, end);
}

const targets = [
  {
    name: 'app.js deferTradeSubmitWork',
    code: load('app.js', 'function deferTradeSubmitWork(', 'function tradeFormError('),
    call: function (context, work) { context.deferTradeSubmitWork(work); },
    install: function (clock) {
      return { setTimeout: clock.setTimeout, requestAnimationFrame: clock.requestAnimationFrame };
    }
  },
  {
    name: 'net-worth-history.js runAfterPaint',
    code: load('js/net-worth-history.js', 'function runAfterPaint(', 'function byId('),
    call: function (context, work) { context.runAfterPaint(work); },
    install: function (clock) {
      return { root: { setTimeout: clock.setTimeout, requestAnimationFrame: clock.requestAnimationFrame } };
    }
  }
];

targets.forEach(function (target) {
  function runsAfter(withFrames, scenario) {
    let count = 0;
    const clock = fakeClock(withFrames);
    const context = Object.assign({}, target.install(clock));
    vm.createContext(context);
    vm.runInContext(target.code, context, { filename: target.name });
    target.call(context, function () { count++; });
    assert.equal(count, 0, target.name + ': work must not run synchronously');
    scenario(clock);
    return count;
  }

  assert.equal(runsAfter(true, function (clock) { clock.runTimers(); }), 1,
    target.name + ': runs once when animation frames never fire (hidden tab)');
  assert.equal(runsAfter(true, function (clock) { clock.runFrames(); clock.runTimers(); }), 1,
    target.name + ': runs exactly once when the frame fires before the fallback timer');
  assert.equal(runsAfter(true, function (clock) { clock.runTimers(); clock.runFrames(); clock.runTimers(); }), 1,
    target.name + ': runs exactly once when the frame fires after the fallback timer');
  assert.equal(runsAfter(false, function (clock) { clock.runTimers(); }), 1,
    target.name + ': runs once without animation frame support');
});

console.log('deferred work checks passed');
