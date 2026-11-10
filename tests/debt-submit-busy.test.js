#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

// Verify styles.css extends is-busy and btn-spin to .t-dock button.primary.is-busy
assert.ok(
  cssSrc.includes('.t-dock button.primary.is-busy'),
  'styles.css must style .t-dock button.primary.is-busy'
);

// Verify dialog markup includes the save button IDs
assert.ok(
  appSrc.includes("dockMarkup('debt-position-error', 'Save reported balance', 'debt-position-save')"),
  'debt-position-dialog must assign debt-position-save ID'
);
assert.ok(
  appSrc.includes("dockMarkup('debt-snapshot-error', 'Save changes', 'debt-snapshot-save')"),
  'debt-snapshot-dialog must assign debt-snapshot-save ID'
);

// Test setTradeSubmitBusy behavior on dummy DOM elements
function makeBtn(id, text) {
  const classes = new Set();
  const attrs = {};
  const children = [];
  return {
    id: id || '',
    textContent: text || '',
    disabled: false,
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c)
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    appendChild: (c) => { children.push(c); },
    querySelector: (sel) => {
      if (sel === '.btn-spin') return children.find(c => c.className === 'btn-spin') || null;
      return null;
    }
  };
}

const sandbox = {
  document: {
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      className: '',
      setAttribute: (k, v) => {},
      textContent: ''
    })
  }
};
vm.createContext(sandbox);

// Extract setTradeSubmitBusy
const fnStart = appSrc.indexOf('function setTradeSubmitBusy(');
const fnEnd = appSrc.indexOf('function deferTradeSubmitWork(');
const helperCode = appSrc.slice(fnStart, fnEnd);
vm.runInContext('var tradeSubmitBusy = false;\n' + helperCode, sandbox);

// Test setting busy on a debt position save button
const debtBtn = makeBtn('debt-position-save', 'Save reported balance');
sandbox.setTradeSubmitBusy(debtBtn, true, 'Saving…');
assert.equal(debtBtn.disabled, true);
assert.equal(debtBtn.classList.contains('is-busy'), true);
assert.equal(debtBtn.getAttribute('aria-busy'), 'true');
assert.equal(debtBtn.getAttribute('data-idle-label'), 'Save reported balance');
assert.equal(sandbox.tradeSubmitBusy, false, 'Non-trade button must not flip tradeSubmitBusy flag');

// Unlock
sandbox.setTradeSubmitBusy(debtBtn, false, 'Save reported balance');
assert.equal(debtBtn.disabled, false);
assert.equal(debtBtn.classList.contains('is-busy'), false);
assert.equal(debtBtn.getAttribute('aria-busy'), null);
assert.equal(debtBtn.textContent, 'Save reported balance');

console.log('debt submit busy tests passed');
