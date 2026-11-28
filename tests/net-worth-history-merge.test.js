#!/usr/bin/env node
'use strict';
// A finished history load replaces every saved chart point inside the
// interval it valued. Merging on equal timestamps only let points from
// earlier loads (other sample times, other price sources, old live readings)
// stay interleaved with the new build: the line turned into a saw-tooth after
// a few app sessions with nothing changed in the ledger.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'net-worth-chart.js'), 'utf8');
const marker = '  root.NetWorthHistory = { update: update, refresh: refresh };';
assert(src.includes(marker), 'chart test hook marker missing');
const instrumented = src.replace(marker, [
  '  root.__netWorthHistoryTest = { mergeLoadedPoints: mergeLoadedPoints };',
  marker
].join('\n'));
const context = { Promise, Date, Math, isFinite };
context.window = context;
vm.createContext(context);
vm.runInContext(instrumented, context, { filename: 'net-worth-chart.js' });
const merge = context.__netWorthHistoryTest.mergeLoadedPoints;

const H = 3600000;
const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);
const pt = (at, value, live) => ({ at, value, prices: {}, live: !!live });
const ats = points => points.map(p => p.at);

// Earlier sessions left samples at shifting times plus live readings, all at
// a different level than the new build.
const outside = pt(T0 - 5 * H, 100);
const earlier = [outside];
for (let i = 0; i < 24; i++) earlier.push(pt(T0 + i * H + 17 * 60000, i % 2 ? 140 : 60));
earlier.push(pt(T0 + 3 * H + 5 * 60000, 150, true), pt(T0 + 20 * H, 55, true));
earlier.sort((a, b) => a.at - b.at);
const build = [];
for (let i = 0; i <= 24; i++) build.push(pt(T0 + i * H, 100 + i));
build[24].live = true;
const range = { start: T0, end: T0 + 24 * H };

const merged = merge(earlier, build, range);
assert.deepEqual(ats(merged), [outside.at].concat(ats(build)),
  'inside the loaded interval only the new build remains; points before it are kept');
assert.equal(merged.filter(p => p.value === 140 || p.value === 60 || p.value === 150 || p.value === 55).length, 0,
  'no earlier sample or live reading is interleaved with the new build');
for (let i = 1; i < merged.length; i++) assert(merged[i].at > merged[i - 1].at, 'points stay sorted');

// Loading the same interval again replaces point for point: no growth.
const again = merge(merged, build.map(p => pt(p.at, p.value + 1, p.live)), range);
assert.equal(again.length, merged.length, 'repeated loads of one interval do not accumulate points');
assert.equal(again[1].value, 101, 'the newest build wins');

// An unknown value in the new build never erases a known value saved for the
// same moment (a price source that is down must not punch holes in the line).
const partial = build.map(p => pt(p.at, p.at === T0 + 5 * H ? null : p.value, p.live));
const keptKnown = merge(merged, partial, range);
const atFive = keptKnown.filter(p => p.at === T0 + 5 * H);
assert.equal(atFive.length, 1, 'one point per moment');
assert.equal(atFive[0].value, 105, 'the saved known value survives an unknown one at the same moment');

// A build without a single known value leaves the saved values in place.
const allUnknown = build.map(p => pt(p.at, null, p.live));
const untouched = merge(merged, allUnknown, range);
assert.deepEqual(untouched.filter(p => p.value !== null).map(p => p.value), merged.map(p => p.value),
  'a load that valued nothing keeps the saved values');

// Nothing loaded: nothing changes.
assert.equal(merge(merged, [], range), merged);

// Points after the interval (live readings taken while it loaded) are kept.
const later = pt(T0 + 24 * H + 10 * 60000, 130, true);
const withLater = merge(merged.concat([later]), build, range);
assert.equal(withLater[withLater.length - 1], later, 'readings after the loaded interval are kept');

// Live readings taken after the build's last market sample are intraday
// detail the build does not have: they stay. One exactly at the build's own
// end point gives way to it.
const fresh = [pt(T0 + 23 * H + 10 * 60000, 120, true), pt(T0 + 23 * H + 40 * 60000, 121, true)];
const withFresh = merge(merged.concat(fresh), build, range);
assert.ok(fresh.every(p => withFresh.indexOf(p) !== -1), 'readings after the last sample are kept');
assert.equal(withFresh.filter(p => p.at === build[24].at).length, 1, 'one point at the build end');

// A new profile whose only record is from today: a daily build has no market
// sample yet, only its end point, so the readings that draw the line stay.
const today = [pt(T0 + 1 * H, 4000, true), pt(T0 + 1 * H + 5 * 60000, 4010, true), pt(T0 + 1 * H + 10 * 60000, 4020, true)];
const endOnly = [pt(T0 + 1 * H + 12 * 60000, 4030, true)];
const newProfile = merge(today, endOnly, { start: T0, end: T0 + 1 * H + 12 * 60000 });
assert.deepEqual(newProfile.map(p => p.value), [4000, 4010, 4020, 4030], 'a new profile keeps its line');

// The 1D sample times are checked in live-price-fallback.test.js.
const history = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'net-worth.js'), 'utf8');
assert.match(history, /chartPointsModel: 3/, 'saved chart points from the saw-tooth and copied-rate eras are rebuilt');

console.log('net worth history merge checks passed');
