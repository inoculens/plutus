#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const activeRule = css.match(/\.history-range-thumb:active\s*\{([^}]*)\}/);
assert(activeRule, 'range thumb needs an active-state rule');
assert.match(activeRule[1], /transform:\s*translate\(-50%,\s*-50%\)/,
  'pressing the handle must preserve its centering transform');

console.log('net worth history range active-state checks passed');
