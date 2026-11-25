'use strict';
// Pagers: account list (6 per page) and per-account record list, in the compact
// first / current / last shape with ellipses.

// Compact pager shape shared by the account list and the per-account trade
// list: at most three numeric buttons (first, current, last) with ellipses
// standing in for the gaps. Returns 0-based page indexes, null for a gap;
// the current page is always one of the numbers.
function compactPagerItems(current, total) {
  if (!isFinite(total) || total <= 0) return [];
  current = Math.max(0, Math.min(total - 1, Number(current) || 0));
  if (total <= 3) {
    var all = [];
    for (var i = 0; i < total; i++) all.push(i);
    return all;
  }
  if (current <= 1) return [0, 1, null, total - 1];
  if (current >= total - 2) return [0, null, total - 2, total - 1];
  return [0, null, current, null, total - 1];
}

function pagerEllipsisEl() {
  var gap = document.createElement('span');
  gap.className = 'pager-ellipsis';
  gap.setAttribute('aria-hidden', 'true');
  gap.textContent = '…';
  return gap;
}

function buildAccountPager(pageCount, current) {
  var pager = document.createElement('div');
  pager.className = 'pager account-pager';
  pager.setAttribute('role', 'navigation');
  pager.setAttribute('aria-label', 'Account pages');
  if (typeof current !== 'number' || !isFinite(current)) current = accountPage;
  current = Math.max(0, Math.min(pageCount - 1, current));
  function pgBtn(label, attrs, disabled, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost page-btn';
    b.textContent = label;
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) b.setAttribute(k, attrs[k]);
    }
    if (disabled) b.disabled = true;
    b.addEventListener('click', fn);
    return b;
  }
  pager.appendChild(pgBtn('‹ Prev', { 'data-page-prev': '1', 'aria-label': 'Previous account page' }, current <= 0, function () {
    if (accountPage > 0) { accountPage--; render(); }
  }));
  // Compact shape: first, current and last, ellipses for the gaps.
  compactPagerItems(current, pageCount).forEach(function (p) {
    if (p === null) { pager.appendChild(pagerEllipsisEl()); return; }
    var nb = pgBtn(String(p + 1), { 'data-page-goto': String(p), 'aria-label': 'Go to account page ' + (p + 1) }, false, function () {
      if (accountPage !== p) { accountPage = p; render(); }
    });
    if (p === current) nb.setAttribute('aria-current', 'page');
    pager.appendChild(nb);
  });
  pager.appendChild(pgBtn('Next ›', { 'data-page-next': '1', 'aria-label': 'Next account page' }, current >= pageCount - 1, function () {
    if (accountPage < pageCount - 1) { accountPage++; render(); }
  }));
  return pager;
}

function buildTradePager(accountId, total, pageCount, page) {
  var pager = document.createElement('div');
  pager.className = 'pager trade-pager';
  pager.setAttribute('role', 'navigation');
  pager.setAttribute('aria-label', 'Trade pages');
  function pgBtn(label, attrs, disabled, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost page-btn';
    b.textContent = label;
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) b.setAttribute(k, attrs[k]);
    }
    if (disabled) b.disabled = true;
    b.addEventListener('click', fn);
    return b;
  }
  function go(p) {
    tradePageSetFor(accountId, p, total);
    render();
    try {
      var bar = document.querySelector('#account-detail .trade-bottom-bar');
      if (bar && bar.scrollIntoView) bar.scrollIntoView({ block: 'nearest' });
    } catch (e) { /* ignore */ }
  }
  pager.appendChild(pgBtn('‹ Prev', { 'data-tpage-prev': '1', 'aria-label': 'Previous trade page' }, page <= 0, function () {
    if (page > 0) go(page - 1);
  }));
  // Compact shape like the account pager: first, current and last, ellipses
  // for the gaps (never more than three numbers).
  var shown = Math.max(0, Math.min(pageCount - 1, page));
  compactPagerItems(shown, pageCount).forEach(function (p) {
    if (p === null) { pager.appendChild(pagerEllipsisEl()); return; }
    var nb = pgBtn(String(p + 1), { 'data-tpage-goto': String(p), 'aria-label': 'Go to trade page ' + (p + 1) }, false, function () {
      if (tradePageGet(accountId, total) !== p) go(p);
    });
    if (p === shown) nb.setAttribute('aria-current', 'page');
    pager.appendChild(nb);
  });
  pager.appendChild(pgBtn('Next ›', { 'data-tpage-next': '1', 'aria-label': 'Next trade page' }, page >= pageCount - 1, function () {
    if (page < pageCount - 1) go(page + 1);
  }));
  return pager;
}

var ACCOUNT_PAGE_SIZE = 6;
var accountPage = 0;
// --- Trade pagination (per-account record list) ---
// Only the current page is ever built into DOM (DocumentFragment of at most
// pageSize tradeBlocks); this bounds the expensive per-record DOM +
// resolveExecPrice work per paint.
var TRADE_PAGE_SIZES = [15, 25, 50, 100];
var TRADE_PAGE_DEFAULT = 25;
var TRADE_PAGE_KEY = 'inoculens.tradepagesize.v1';
var tradePageSize = TRADE_PAGE_DEFAULT;
var tradePageByAccount = {}; // accountId -> 0-based page index
try {
  if (typeof localStorage !== 'undefined') {
    var _tps = Number(localStorage.getItem(TRADE_PAGE_KEY));
    if (TRADE_PAGE_SIZES.indexOf(_tps) !== -1) tradePageSize = _tps;
  }
} catch (e) { /* ignore: default stands */ }

function tradePageSizeGet() { return tradePageSize; }

function tradePageSizeSet(n) {
  var v = Number(n);
  if (TRADE_PAGE_SIZES.indexOf(v) === -1) return tradePageSize;
  tradePageSize = v;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TRADE_PAGE_KEY, String(v));
  } catch (e) { /* ignore */ }
  return tradePageSize;
}

function tradePageCountFor(total) {
  var t = Number(total) || 0;
  if (t <= 0) return 1;
  return Math.max(1, Math.ceil(t / tradePageSize));
}

function tradePageGet(accountId, total) {
  var pc = tradePageCountFor(total);
  var p = tradePageByAccount[accountId];
  if (!isFinite(p) || p < 0) p = 0;
  if (p > pc - 1) p = pc - 1;
  tradePageByAccount[accountId] = p;
  return p;
}

function tradePageSetFor(accountId, p, total) {
  var pc = tradePageCountFor(total);
  if (!isFinite(p) || p < 0) p = 0;
  if (p > pc - 1) p = pc - 1;
  tradePageByAccount[accountId] = p;
  return p;
}
