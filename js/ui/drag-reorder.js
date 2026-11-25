'use strict';
// Drag-and-drop reordering (dice-grip handles): accounts on the home list,
// sub-accounts of a group, records of an account.

// --- Account drag-and-drop reorder (dice-grip handle, desktop) ---
// Order is the accounts array itself: saveState persists it to localStorage
// and export/import preserve it, so a reorder survives backup + restore with
// no extra fields. Drags start from the grip only; card clicks still open.
var acctDrag = null; // {id,startX,startY,started,ghost,overId,after,flipTimer,flipCoolUntil,armedBtn}
var suppressCardClick = false;

function clearDropMarks() {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelectorAll) return;
  Array.prototype.forEach.call(host.querySelectorAll('.account-card.drag-src,.account-card.drop-before,.account-card.drop-after'), function (el) {
    el.classList.remove('drag-src', 'drop-before', 'drop-after');
  });
}

function clearCardMarks() {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelectorAll) return;
  Array.prototype.forEach.call(host.querySelectorAll('.account-card.drop-before,.account-card.drop-after'), function (el) {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function acctDragCardEl(id) {
  var host = document.getElementById('accounts');
  if (!host || !host.querySelector) return null;
  try {
    return host.querySelector('[data-account="' + cssAttrValue(id) + '"]');
  } catch (e) {
    return null;
  }
}

function visibleAccountIds(st) {
  var f = selectedTickers(st);
  return (st.accounts || []).filter(function (a) {
    return f === null || f.indexOf(String(a.ticker).toUpperCase()) !== -1;
  }).map(function (a) { return a.id; });
}

function pagerTargetPage(btn) {
  if (!btn || !btn.hasAttribute) return accountPage;
  if (btn.hasAttribute('data-page-prev')) return accountPage - 1;
  if (btn.hasAttribute('data-page-next')) return accountPage + 1;
  if (btn.hasAttribute('data-page-goto')) {
    var p = Number(btn.getAttribute('data-page-goto'));
    return isFinite(p) ? p : accountPage;
  }
  return accountPage;
}

function acctDragCleanup() {
  if (acctDrag && acctDrag.flipTimer) {
    try { clearTimeout(acctDrag.flipTimer); } catch (e) {}
  }
  if (acctDrag && acctDrag.ghost && acctDrag.ghost.parentNode) {
    try { acctDrag.ghost.parentNode.removeChild(acctDrag.ghost); } catch (e) {}
  }
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = '';
  } catch (e) {}
  try {
    var hintHost = (typeof document !== 'undefined') ? document.getElementById('accounts') : null;
    if (hintHost && hintHost.querySelectorAll) {
      Array.prototype.forEach.call(hintHost.querySelectorAll('[data-drag-hint]'), function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
    }
  } catch (e) {}
  clearDropMarks();
  acctDrag = null;
}

function markAcctDragSrc() {
  if (!acctDrag) return;
  var src = acctDragCardEl(acctDrag.id);
  if (src) src.classList.add('drag-src');
}

function acctStartDrag(src) {
  var r = null;
  try { r = src.getBoundingClientRect(); } catch (e) { r = null; }
  var ghost = null;
  try {
    ghost = src.cloneNode(true);
    ghost.classList.remove('drop-before', 'drop-after', 'drag-src');
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('id');
    ghost.style.width = (r && r.width ? r.width : 320) + 'px';
    ghost.style.left = (r ? r.left : 0) + 'px';
    ghost.style.top = (r ? r.top : 0) + 'px';
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(ghost);
    else ghost = null;
  } catch (e) { ghost = null; }
  acctDrag.started = true;
  acctDrag.ghost = ghost;
  suppressCardClick = true;
  acctShowDragHint();
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = 'none';
  } catch (e) {}
  markAcctDragSrc();
}

function acctShowDragHint() {
  try {
    var host = document.getElementById('accounts');
    if (!host) return;
    var st = loadState();
    if (visibleAccountIds(st).length <= ACCOUNT_PAGE_SIZE) return;
    if (host.querySelector && host.querySelector('[data-drag-hint]')) return;
    var hint = document.createElement('div');
    hint.className = 'pager-hint';
    hint.setAttribute('data-drag-hint', '1');
    hint.textContent = 'Drop on ‹ Prev, a page number, or Next › to move the card there';
    host.appendChild(hint);
  } catch (e) {}
}

function acctDisarmFlip() {
  if (acctDrag && acctDrag.flipTimer) {
    try { clearTimeout(acctDrag.flipTimer); } catch (e) {}
    acctDrag.flipTimer = null;
  }
  var host = document.getElementById('accounts');
  if (host && host.querySelectorAll) {
    Array.prototype.forEach.call(host.querySelectorAll('.page-btn.hot'), function (b) { b.classList.remove('hot'); });
  }
  if (acctDrag) acctDrag.armedBtn = null;
}

function acctFlipTo(page) {
  var st = loadState();
  var vis = visibleAccountIds(st);
  var pages = Math.max(1, Math.ceil(vis.length / ACCOUNT_PAGE_SIZE));
  if (page < 0 || page > pages - 1) return false;
  accountPage = page;
  render();
  if (acctDrag) {
    acctDrag.flipCoolUntil = Date.now() + 900;
    acctDrag.overId = null;
    acctDrag.after = false;
    markAcctDragSrc();
  }
  return true;
}

function wireAccountDnD() {
  var host = document.getElementById('accounts');
  if (!host || host.getAttribute('data-dnd-wired')) return;
  host.setAttribute('data-dnd-wired', '1');
  host.addEventListener('pointerdown', function (e) {
    var grip = e.target && e.target.closest ? e.target.closest('.drag-handle') : null;
    if (!grip) return;
    var card = grip.closest('.account-card');
    if (!card || !card.getAttribute('data-account')) return;
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    if (typeof e.clientX !== 'number') return;
    acctDrag = { id: card.getAttribute('data-account'), startX: e.clientX, startY: e.clientY, started: false, ghost: null, overId: null, after: false, flipTimer: null, flipCoolUntil: 0, armedBtn: null };
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
  });
  host.addEventListener('pointermove', function (e) {
    if (!acctDrag || !e || typeof e.clientX !== 'number') return;
    var dx = e.clientX - acctDrag.startX;
    var dy = e.clientY - acctDrag.startY;
    if (!acctDrag.started) {
      if (dx * dx + dy * dy < 49) return;
      var src = acctDragCardEl(acctDrag.id);
      if (!src) { acctDragCleanup(); return; }
      acctStartDrag(src);
    }
    if (acctDrag.ghost) {
      acctDrag.ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    var under = null;
    try {
      under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
    } catch (err) { under = null; }
    // Cross-page targets: pager buttons (prev, numbers, next) glow blue;
    // lingering on one flips the page while you keep holding.
    var pgBtn = under && under.closest ? under.closest('[data-page-prev],[data-page-next],[data-page-goto]') : null;
    var pgTarget = pgBtn ? pagerTargetPage(pgBtn) : accountPage;
    if (pgBtn && !pgBtn.disabled && pgTarget !== accountPage && Date.now() >= (acctDrag.flipCoolUntil || 0)) {
      if (acctDrag.armedBtn !== pgBtn) {
        acctDisarmFlip();
        acctDrag.armedBtn = pgBtn;
        pgBtn.classList.add('hot');
        acctDrag.flipTimer = setTimeout(function () {
          if (!acctDrag) return;
          acctDisarmFlip();
          acctFlipTo(pgTarget);
        }, 650);
      }
    } else {
      acctDisarmFlip();
    }
    clearCardMarks();
    var card = under && under.closest ? under.closest('.account-card') : null;
    acctDrag.overId = null;
    if (card && card.getAttribute('data-account') !== acctDrag.id) {
      var r = null;
      try { r = card.getBoundingClientRect(); } catch (err2) { r = null; }
      acctDrag.after = !!(r && (e.clientY - r.top) > r.height / 2);
      acctDrag.overId = card.getAttribute('data-account');
      card.classList.add(acctDrag.after ? 'drop-after' : 'drop-before');
    }
  });
  function acctFinishDrop(e) {
    if (!acctDrag) return;
    var wasStarted = acctDrag.started;
    var id = acctDrag.id;
    var overId = null;
    var after = false;
    var onPager = null;
    if (wasStarted && e && typeof e.clientX === 'number') {
      try {
        var under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
        var pb = under && under.closest ? under.closest('[data-page-prev],[data-page-next],[data-page-goto]') : null;
        if (pb && !pb.disabled) onPager = pb;
        else {
          var card = under && under.closest ? under.closest('.account-card') : null;
          if (card && card.getAttribute('data-account') !== id) {
            overId = card.getAttribute('data-account');
            var r = null;
            try { r = card.getBoundingClientRect(); } catch (err) { r = null; }
            after = !!(r && (e.clientY - r.top) > r.height / 2);
          }
        }
      } catch (err2) {}
    }
    acctDragCleanup();
    if (!wasStarted) return; // plain click: the nav handler opens the card
    var st = loadState();
    var vis = visibleAccountIds(st);
    if (vis.indexOf(id) === -1) { render(); return; }
    var fullIds = (st.accounts || []).map(function (a) { return a && a.id; });
    var fullFrom = fullIds.indexOf(id);
    var insertFull = -1;
    if (onPager) {
      var targetPage = pagerTargetPage(onPager);
      var pages = Math.max(1, Math.ceil(vis.length / ACCOUNT_PAGE_SIZE));
      if (targetPage < 0) targetPage = 0;
      if (targetPage > pages - 1) targetPage = pages - 1;
      if (targetPage === accountPage) { render(); return; } // dropped on the current page number
      // Prev + page numbers land at the page start, Next at the page end.
      var atEnd = onPager.hasAttribute && onPager.hasAttribute('data-page-next');
      accountPage = targetPage;
      var visIx = atEnd ? Math.min(vis.length, (targetPage + 1) * ACCOUNT_PAGE_SIZE) : targetPage * ACCOUNT_PAGE_SIZE;
      insertFull = visIx >= vis.length ? fullIds.length : fullIds.indexOf(vis[visIx]);
      if (insertFull === -1) insertFull = atEnd ? fullIds.length : 0;
    } else if (overId) {
      var visTo = vis.indexOf(overId);
      if (visTo === -1) { render(); return; }
      var wantVis = after ? visTo + 1 : visTo;
      insertFull = wantVis >= vis.length ? fullIds.length : fullIds.indexOf(vis[wantVis]);
      if (insertFull === -1) insertFull = fullIds.length;
    } else {
      render(); // released over nothing meaningful: snap back
      return;
    }
    var moved = st.accounts.splice(fullFrom, 1)[0];
    if (fullFrom < insertFull) insertFull--;
    if (insertFull !== fullFrom) {
      st.accounts.splice(insertFull, 0, moved);
      if (!saveStateGuarded(st)) { render(); return; }
    }
    render();
  }
  host.addEventListener('pointerup', acctFinishDrop);
  host.addEventListener('pointercancel', function () { acctDragCleanup(); });
}

// --- Sub-account drag-and-drop reorder (group mains) ---
// Same dice-grip pattern as the home list, scoped to one group's member
// cards. Order is the accounts array itself, so a sub reorder persists
// exactly like a home reorder (members stay hidden on home, so the home
// order is unaffected). Drags start from the grip only; card clicks still
// open the sub-account.
var subDrag = null; // {id,startX,startY,started,ghost,overId,after}

function subDragCleanup(wrap) {
  if (subDrag && subDrag.ghost && subDrag.ghost.parentNode) {
    try { subDrag.ghost.parentNode.removeChild(subDrag.ghost); } catch (e) {}
  }
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = '';
  } catch (e) {}
  try {
    var scope = (wrap && wrap.querySelectorAll) ? wrap : ((typeof document !== 'undefined') ? document.getElementById('account-detail') : null);
    if (scope && scope.querySelectorAll) {
      Array.prototype.forEach.call(scope.querySelectorAll('.account-card.drag-src,.account-card.drop-before,.account-card.drop-after'), function (el) {
        el.classList.remove('drag-src', 'drop-before', 'drop-after');
      });
    }
  } catch (e) {}
  subDrag = null;
}

function subStartDrag(wrap, src) {
  var r = null;
  try { r = src.getBoundingClientRect(); } catch (e) { r = null; }
  var ghost = null;
  try {
    ghost = src.cloneNode(true);
    ghost.classList.remove('drop-before', 'drop-after', 'drag-src');
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('id');
    ghost.style.width = (r && r.width ? r.width : 320) + 'px';
    ghost.style.left = (r ? r.left : 0) + 'px';
    ghost.style.top = (r ? r.top : 0) + 'px';
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(ghost);
    else ghost = null;
  } catch (e) { ghost = null; }
  subDrag.started = true;
  subDrag.ghost = ghost;
  suppressCardClick = true;
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = 'none';
  } catch (e) {}
  try {
    var cur = wrap && wrap.querySelector ? wrap.querySelector('[data-account="' + cssAttrValue(subDrag.id) + '"]') : null;
    if (cur) cur.classList.add('drag-src');
  } catch (e) {}
}

function subFinishDrop(wrap, e) {
  if (!subDrag) return;
  var wasStarted = subDrag.started;
  var id = subDrag.id;
  var overId = null;
  var after = false;
  if (wasStarted && e && typeof e.clientX === 'number') {
    try {
      var under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
      var card = under && under.closest ? under.closest('.group-subs .account-card') : null;
      if (card && wrap && typeof wrap.contains === 'function' && !wrap.contains(card)) card = null;
      if (card && card.getAttribute('data-account') !== id) {
        var r = null;
        try { r = card.getBoundingClientRect(); } catch (err) { r = null; }
        after = !!(r && (e.clientY - r.top) > r.height / 2);
        overId = card.getAttribute('data-account');
      }
    } catch (err2) {}
  }
  subDragCleanup(wrap);
  if (!wasStarted) return; // plain click: the wrap handler opens the card
  if (!overId) return; // released over nothing meaningful: snap back
  var st = null;
  try { st = loadState(); } catch (e2) { return; }
  var draggedAcc = accountById(st, id);
  var targetAcc = accountById(st, overId);
  var mainId = draggedAcc && typeof draggedAcc.groupId === 'string' ? draggedAcc.groupId : '';
  if (!draggedAcc || !targetAcc || !mainId || targetAcc.groupId !== mainId) return;
  var before = groupMembers(st, mainId).map(function (m) { return m.id; });
  if (before.indexOf(id) === -1 || before.indexOf(overId) === -1) return;
  var from = -1;
  for (var fi = 0; fi < st.accounts.length; fi++) {
    if (st.accounts[fi] && st.accounts[fi].id === id) { from = fi; break; }
  }
  if (from === -1) return;
  var moved = st.accounts.splice(from, 1)[0];
  var to = -1;
  for (var ti = 0; ti < st.accounts.length; ti++) {
    if (st.accounts[ti] && st.accounts[ti].id === overId) { to = ti; break; }
  }
  if (to === -1) return;
  if (after) to++;
  st.accounts.splice(to, 0, moved);
  var afterOrder = groupMembers(st, mainId).map(function (m) { return m.id; });
  var changed = afterOrder.length !== before.length ||
    afterOrder.some(function (mid, i) { return mid !== before[i]; });
  if (!changed) return; // adjacent no-op: visuals already match
  if (!saveStateGuarded(st)) { render(); return; }
  clearBanner();
  render();
}

// --- Trade drag-and-drop reorder (dice-grip handle, account detail) ---
// Always available — every record card carries its grip at all times, like
// the account cards on home. Two hard constraints:
// 1. Only records of the SAME date may swap places — a record can never
//    move across a date boundary, so the timeline order stays truthful.
// 2. The math must still book: the reordered timeline may never leave an
//    outflow unfunded (selling before the funds arrive). The same timeline
//    engine the edit dialog uses decides, so the app never disagrees with
//    itself about what "the funds are not there yet" means.
//
// Order lives in the trades array itself (like the accounts array for
// account cards): the engine walks trades in date order and keeps the
// existing order for equal dates, so permuting the same-date records of an
// account permutes exactly what the math sees.
var tradeDrag = null; // {id,startX,startY,started,ghost,overId,after,date,accId}

function tradeDragCleanup() {
  if (tradeDrag && tradeDrag.ghost && tradeDrag.ghost.parentNode) {
    try { tradeDrag.ghost.parentNode.removeChild(tradeDrag.ghost); } catch (e) {}
  }
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = '';
  } catch (e) {}
  try {
    var host = document.getElementById('account-detail');
    if (host && host.querySelectorAll) {
      Array.prototype.forEach.call(host.querySelectorAll('.trade-block.drag-src,.trade-block.drop-before,.trade-block.drop-after'), function (el) {
        el.classList.remove('drag-src', 'drop-before', 'drop-after');
      });
    }
  } catch (e) {}
  tradeDrag = null;
}

function tradeDragCardEl(id) {
  var host = document.getElementById('account-detail');
  if (!host || !host.querySelector) return null;
  try {
    return host.querySelector('[data-trade="' + cssAttrValue(id) + '"]');
  } catch (e) {
    return null;
  }
}

function clearTradeCardMarks() {
  var host = document.getElementById('account-detail');
  if (!host || !host.querySelectorAll) return;
  Array.prototype.forEach.call(host.querySelectorAll('.trade-block.drop-before,.trade-block.drop-after'), function (el) {
    el.classList.remove('drop-before', 'drop-after');
  });
}

// The records one account's list shows for a single date: its own records
// plus every transfer that touches it (as primary, source or recipient). This
// is the same predicate the list is built from (accountTrades), so a reorder
// always permutes exactly the cards on screen, whichever account of a
// multi-account transfer the user is looking at.
function tradeInReorderScope(t, accId, date) {
  return !!t && t.date === date && transferInvolvesAccount(t, accId);
}

// Failsafe for the record reorder: a proposed order is only accepted when
// the ledger timeline still books every outflow in full. This is what stops
// "add funds → spend those funds" from being reordered into
// "spend → add funds" (which would fake the spend out of existence).
//
// newOrderIds is EXECUTION order: the id that acted first of the day first in
// the array. The list feeds each date newest-execution-first, so the drop
// handler converts the displayed order (top = latest) with a reverse before
// calling in.
//
// Reuses the same timeline engine the edit dialog uses, so the check and
// the app can never disagree about what "the funds are not there yet" means.
// Returns { ok: true } or { ok: false, reason: 'shortfall' }.
function validateTradeReorder(st, accId, date, newOrderIds) {
  var trades = st.trades || [];
  // The proposed order must cover exactly the date's records: a missing id
  // means the caller built a broken order, so refuse it.
  var dateTrades = trades.filter(function (t) {
    return tradeInReorderScope(t, accId, date);
  });
  var knownIds = dateTrades.map(function (t) { return t.id; });
  if (newOrderIds.length !== knownIds.length) return { ok: false, reason: 'incomplete' };
  for (var k = 0; k < newOrderIds.length; k++) {
    if (knownIds.indexOf(newOrderIds[k]) === -1) return { ok: false, reason: 'unknown' };
  }

  // Rebuild the store order: the account's records of that date take their
  // slots from the proposed order, every other record keeps its place.
  var tradeMap = {};
  dateTrades.forEach(function (t) { if (t && t.id) tradeMap[t.id] = t; });
  var slots = [];
  trades.forEach(function (t, ix) {
    if (tradeInReorderScope(t, accId, date)) slots.push(ix);
  });
  var rebuilt = trades.slice();
  for (var s = 0; s < slots.length; s++) {
    var srcTrade = tradeMap[newOrderIds[s]];
    if (srcTrade) rebuilt[slots[s]] = srcTrade;
  }

  // Only records up to (and including) the target date matter: later
  // records are untouched by a reorder inside this date group.
  var upto = rebuilt.filter(function (t) {
    return t && typeof t.date === 'string' && t.date <= date;
  });
  var base = trades.filter(function (t) {
    return t && typeof t.date === 'string' && t.date <= date;
  });

  // Compare against the same timeline run before the reorder. A reorder that
  // only reshuffles records whose outflows were already funded is fine; one
  // that starves an outflow is not. (Legacy books that already contain an
  // unfunded outflow are tolerated — a reorder must not make things worse.)
  var baseMap = new Map();
  timelineOutflowShortfalls(base).forEach(function (e) {
    var m = baseMap.get(e.key);
    if (!m) { m = new Map(); baseMap.set(e.key, m); }
    m.set(e.trade, e.shortfall);
  });
  var next = timelineOutflowShortfalls(upto);
  for (var i = 0; i < next.length; i++) {
    var ev = next[i];
    var prevMap = baseMap.get(ev.key);
    var prevShort = prevMap ? (prevMap.get(ev.trade) || 0) : 0;
    if (ev.shortfall > prevShort + ledgerQtyEpsilon(ev.symbol)) {
      return { ok: false, reason: 'shortfall', shortfall: ev };
    }
  }
  return { ok: true };
}

// Apply a validated same-date reorder to the store: the account's records of
// that date take their slots from the new order (execution order, same
// contract as validateTradeReorder), everything else keeps its place.
// Returns the new trades array (or null when the order is invalid).
function applyTradeReorder(st, accId, date, newOrderIds) {
  var check = validateTradeReorder(st, accId, date, newOrderIds);
  if (!check || !check.ok) return { ok: false, reason: check && check.reason, shortfall: check && check.shortfall };
  var trades = st.trades || [];
  var dateTrades = trades.filter(function (t) {
    return tradeInReorderScope(t, accId, date);
  });
  var tradeMap = {};
  dateTrades.forEach(function (t) { if (t && t.id) tradeMap[t.id] = t; });
  var slots = [];
  trades.forEach(function (t, ix) {
    if (tradeInReorderScope(t, accId, date)) slots.push(ix);
  });
  var rebuilt = trades.slice();
  for (var s = 0; s < slots.length; s++) {
    var srcTrade = tradeMap[newOrderIds[s]];
    if (srcTrade) rebuilt[slots[s]] = srcTrade;
  }
  return { ok: true, trades: rebuilt };
}

function wireTradeDnD() {
  var host = document.getElementById('account-detail');
  if (!host) return;
  // The host element survives re-renders (only its children are replaced),
  // so the listeners are wired ONCE and read the account from the dragged
  // record at event time. Wiring per account would pile up listeners on
  // every navigation.
  if (!host.getAttribute('data-trade-dnd-wired')) {
    host.setAttribute('data-trade-dnd-wired', '1');
    wireTradeDnDEvents(host);
  }
}

function wireTradeDnDEvents(host) {
  host.addEventListener('pointerdown', function (e) {
    var grip = e.target && e.target.closest ? e.target.closest('.drag-handle') : null;
    if (!grip) return;
    var card = grip.closest('.trade-block');
    if (!card || !card.getAttribute('data-trade')) return;
    var tradeId = card.getAttribute('data-trade');
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    if (typeof e.clientX !== 'number') return;
    // The record's own date is the boundary: it may only swap with records
    // that carry the very same date. The account whose list is open pins the
    // scope (not the record's primary account), so a transfer can be moved
    // among that account's same-date records from any account it appears
    // under; the grip decides everything — no mode flags needed.
    var st = loadState();
    var trade = findTradeById(st, tradeId);
    if (!trade) return;
    var viewAcc = host.getAttribute('data-view-account') || '';
    if (!viewAcc || !transferInvolvesAccount(trade, viewAcc)) viewAcc = trade.accountId;
    tradeDrag = { id: tradeId, startX: e.clientX, startY: e.clientY, started: false, ghost: null, overId: null, after: false, date: trade.date, accId: viewAcc };
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
  });
  host.addEventListener('pointermove', function (e) {
    if (!tradeDrag || !e || typeof e.clientX !== 'number') return;
    var dx = e.clientX - tradeDrag.startX;
    var dy = e.clientY - tradeDrag.startY;
    if (!tradeDrag.started) {
      if (dx * dx + dy * dy < 49) return;
      var src = tradeDragCardEl(tradeDrag.id);
      if (!src) { tradeDragCleanup(); return; }
      tradeStartDrag(src);
    }
    if (tradeDrag.ghost) {
      tradeDrag.ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    var under = null;
    try {
      under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
    } catch (err) { under = null; }
    clearTradeCardMarks();
    var card = under && under.closest ? under.closest('.trade-block') : null;
    tradeDrag.overId = null;
    if (card && card.getAttribute('data-trade') !== tradeDrag.id) {
      var targetTradeId = card.getAttribute('data-trade');
      var st = loadState();
      var targetTrade = findTradeById(st, targetTradeId);
      // Same date only: a record never crosses a date boundary.
      if (targetTrade && targetTrade.date === tradeDrag.date) {
        var r = null;
        try { r = card.getBoundingClientRect(); } catch (err2) { r = null; }
        tradeDrag.after = !!(r && (e.clientY - r.top) > r.height / 2);
        tradeDrag.overId = targetTradeId;
        card.classList.add(tradeDrag.after ? 'drop-after' : 'drop-before');
      }
    }
  });
  function tradeFinishDrop(e) {
    if (!tradeDrag) return;
    var accId = tradeDrag.accId;
    var wasStarted = tradeDrag.started;
    var id = tradeDrag.id;
    var date = tradeDrag.date;
    var overId = null;
    var after = false;
    if (wasStarted && e && typeof e.clientX === 'number') {
      try {
        var under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
        var card = under && under.closest ? under.closest('.trade-block') : null;
        if (card && card.getAttribute('data-trade') !== id) {
          var targetTradeId = card.getAttribute('data-trade');
          var st = loadState();
          var targetTrade = findTradeById(st, targetTradeId);
          if (targetTrade && targetTrade.date === date) {
            overId = targetTradeId;
            var r = null;
            try { r = card.getBoundingClientRect(); } catch (err) { r = null; }
            after = !!(r && (e.clientY - r.top) > r.height / 2);
          }
        }
      } catch (err2) {}
    }
    tradeDragCleanup();
    if (!wasStarted) return; // plain click
    if (!overId) return; // released over nothing meaningful: snap back

    // Build the proposed order for this date in DISPLAY order: the list feeds
    // each date newest-execution-first (top = the latest move), so a drop
    // above the target books the record LATER in the day and a drop below
    // books it EARLIER — which is exactly where the shortfall check must
    // bite. The validator/engine speak execution order (store order), i.e.
    // the displayed group read bottom-up, so reverse before applying.
    var st = loadState();
    if (!accountById(st, accId)) return;
    var dateTrades = (st.trades || []).filter(function (t) {
      return tradeInReorderScope(t, accId, date);
    });
    var displayIds = dateTrades.map(function (t) { return t.id; }).reverse();
    var fromIdx = displayIds.indexOf(id);
    if (fromIdx === -1) return;
    displayIds.splice(fromIdx, 1);
    var toIdx = displayIds.indexOf(overId);
    if (toIdx === -1) return;
    if (after) toIdx++;
    displayIds.splice(toIdx, 0, id);

    // The failsafe: the reordered timeline may never leave an outflow
    // unfunded (selling before the funds arrive).
    var applied = applyTradeReorder(st, accId, date, displayIds.slice().reverse());
    if (!applied || !applied.ok) {
      showBanner('Cannot rearrange these records even though they share a date, this order would spend funds that are not there yet.');
      render();
      return;
    }
    st.trades = applied.trades;
    if (!saveStateGuarded(st)) { render(); return; }
    clearBanner();
    // A done reorder is just a paint: no mode to leave, only a re-render
    // so the list and the totals reflect the new book order.
    tradeDragCleanup();
    render();
  }
  host.addEventListener('pointerup', tradeFinishDrop);
  host.addEventListener('pointercancel', tradeDragCleanup);
}

function tradeStartDrag(src) {
  var r = null;
  try { r = src.getBoundingClientRect(); } catch (e) { r = null; }
  var ghost = null;
  try {
    ghost = src.cloneNode(true);
    ghost.classList.remove('drop-before', 'drop-after', 'drag-src');
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('id');
    ghost.style.width = (r && r.width ? r.width : 320) + 'px';
    ghost.style.left = (r ? r.left : 0) + 'px';
    ghost.style.top = (r ? r.top : 0) + 'px';
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(ghost);
    else ghost = null;
  } catch (e) { ghost = null; }
  tradeDrag.started = true;
  tradeDrag.ghost = ghost;
  suppressCardClick = true;
  try {
    if (typeof document !== 'undefined' && document.body && document.body.style) document.body.style.userSelect = 'none';
  } catch (e) {}
  var cur = tradeDragCardEl(tradeDrag.id);
  if (cur) cur.classList.add('drag-src');
}


function wireGroupSubsDnD(wrap) {
  if (!wrap || wrap.getAttribute('data-dnd-wired')) return;
  wrap.setAttribute('data-dnd-wired', '1');
  wrap.addEventListener('pointerdown', function (e) {
    var grip = e.target && e.target.closest ? e.target.closest('.drag-handle') : null;
    if (!grip) return;
    var card = grip.closest('.account-card');
    if (!card || !card.getAttribute('data-account')) return;
    if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
    if (typeof e.clientX !== 'number') return;
    subDrag = { id: card.getAttribute('data-account'), startX: e.clientX, startY: e.clientY, started: false, ghost: null, overId: null, after: false };
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
  });
  wrap.addEventListener('pointermove', function (e) {
    if (!subDrag || !e || typeof e.clientX !== 'number') return;
    var dx = e.clientX - subDrag.startX;
    var dy = e.clientY - subDrag.startY;
    if (!subDrag.started) {
      if (dx * dx + dy * dy < 49) return;
      var src = null;
      try { src = wrap.querySelector('[data-account="' + cssAttrValue(subDrag.id) + '"]'); } catch (e2) { src = null; }
      if (!src) { subDragCleanup(wrap); return; }
      subStartDrag(wrap, src);
    }
    if (subDrag.ghost) {
      subDrag.ghost.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    }
    Array.prototype.forEach.call(wrap.querySelectorAll('.account-card.drop-before,.account-card.drop-after'), function (el) {
      el.classList.remove('drop-before', 'drop-after');
    });
    var under = null;
    try {
      under = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(e.clientX, e.clientY) : null;
    } catch (err) { under = null; }
    var card = under && under.closest ? under.closest('.group-subs .account-card') : null;
    if (card && typeof wrap.contains === 'function' && !wrap.contains(card)) card = null;
    subDrag.overId = null;
    if (card && card.getAttribute('data-account') !== subDrag.id) {
      var r = null;
      try { r = card.getBoundingClientRect(); } catch (err2) { r = null; }
      subDrag.after = !!(r && (e.clientY - r.top) > r.height / 2);
      subDrag.overId = card.getAttribute('data-account');
      card.classList.add(subDrag.after ? 'drop-after' : 'drop-before');
    }
  });
  wrap.addEventListener('pointerup', function (e) { subFinishDrop(wrap, e); });
  wrap.addEventListener('pointercancel', function () { subDragCleanup(wrap); });
}
