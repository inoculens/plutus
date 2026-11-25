'use strict';
// Bulk selection of accounts and records (survives page flips) and the bulk
// action menus (color, group, delete).

var selectionMode = false;
var selectedAccounts = {}; // id -> true; survives page flips and re-renders (in-memory working set)
var accountActionOpen = false;

// Trade selection (account detail view)
var tradeSelectionMode = false;
var selectedTrades = {}; // tradeId -> true; survives page flips and re-renders
var tradeActionOpen = false;

function selectedCount() {
  return Object.keys(selectedAccounts).length;
}

function cancelSelection() {
  selectionMode = false;
  selectedAccounts = {};
  accountActionOpen = false;
  render();
}

function toggleAccountSelect(id) {
  if (!id) return;
  if (selectedAccounts[id]) delete selectedAccounts[id];
  else selectedAccounts[id] = true;
  syncSelectionUI();
}

// Paint-only sync (no re-render): every rendered card, count and Action
// follow the set — home list and group sub-lists alike — so rapid
// multi-select keeps focus and panels stay open.
function syncSelectionUI() {
  var n = selectedCount();
  try {
    Array.prototype.forEach.call(document.querySelectorAll('.account-card'), function (card) {
      var id = card.getAttribute ? card.getAttribute('data-account') : null;
      var on = !!id && !!selectedAccounts[id];
      if (card.classList) card.classList.toggle('selected', on);
      var cb = card.querySelector ? card.querySelector('[data-select-check]') : null;
      if (cb) cb.checked = on;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-select-count]'), function (count) {
      count.textContent = n + ' selected';
      count.hidden = !(selectionMode && n > 0);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-action-wrap]'), function (awrap) {
      awrap.hidden = !(selectionMode && n > 0);
    });
  } catch (e) { /* ignore */ }
}

// --- Trade selection helpers (mirrors account selection) ---
function selectedTradeCount() {
  return Object.keys(selectedTrades).length;
}

function cancelTradeSelection() {
  tradeSelectionMode = false;
  selectedTrades = {};
  tradeActionOpen = false;
  render();
}

function toggleTradeSelect(id) {
  if (!id) return;
  if (selectedTrades[id]) delete selectedTrades[id];
  else selectedTrades[id] = true;
  syncTradeSelectionUI();
}

function syncTradeSelectionUI() {
  var n = selectedTradeCount();
  try {
    Array.prototype.forEach.call(document.querySelectorAll('.trade-block'), function (card) {
      var id = card.getAttribute ? card.getAttribute('data-trade') : null;
      var on = !!id && !!selectedTrades[id];
      if (card.classList) card.classList.toggle('selected', on);
      var cb = card.querySelector ? card.querySelector('[data-select-check]') : null;
      if (cb) cb.checked = on;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-trade-select-count]'), function (count) {
      count.textContent = n + ' selected';
      count.hidden = !(tradeSelectionMode && n > 0);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-trade-action-wrap]'), function (awrap) {
      awrap.hidden = !(tradeSelectionMode && n > 0);
    });
  } catch (e) { /* ignore */ }
}

function closeTradeAction() {
  if (!tradeActionOpen) return;
  tradeActionOpen = false;
  try {
    Array.prototype.forEach.call(document.querySelectorAll('[data-trade-action-panel]'), function (panel) {
      panel.hidden = true;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-trade-action-btn]'), function (btn) {
      btn.setAttribute('aria-expanded', 'false');
    });
  } catch (e) { /* ignore */ }
}

function closeAccountAction() {
  if (!accountActionOpen) return;
  accountActionOpen = false;
  try {
    Array.prototype.forEach.call(document.querySelectorAll('[data-action-panel]'), function (panel) {
      panel.hidden = true;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-action-btn]'), function (btn) {
      btn.setAttribute('aria-expanded', 'false');
    });
  } catch (e) { /* ignore */ }
}

function applyColorToSelection(hex) {
  var st = loadState();
  var ids = Object.keys(selectedAccounts).filter(function (id) { return !!accountById(st, id); });
  if (!ids.length) return;
  if (hex !== null) {
    if (!isValidHexColor(hex)) {
      showBanner('Pick a valid color, e.g. #F7931A.');
      return;
    }
    hex = String(hex).trim().toUpperCase();
  }
  ids.forEach(function (id) {
    var a = accountById(st, id);
    if (!a) return;
    if (hex === null) {
      try {
        delete a.color;
      } catch (e) {
        a.color = undefined;
      }
    } else {
      a.color = hex;
    }
  });
  if (!saveStateGuarded(st)) return;
  clearBanner();
  closeDialog('color-dialog');
  render(); // stay in selection mode with the set intact
}

function buildAccountAction() {
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  wrap.setAttribute('data-action-wrap', '1');
  var n = selectedCount();
  wrap.hidden = !(selectionMode && n > 0);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-action-btn', '1');
  btn.textContent = 'Action';
  btn.setAttribute('aria-label', 'Bulk actions for selected accounts');
  btn.setAttribute('aria-expanded', accountActionOpen ? 'true' : 'false');
  btn.addEventListener('click', function () {
    accountActionOpen = !accountActionOpen;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel';
  panel.setAttribute('data-action-panel', '1');
  panel.hidden = !accountActionOpen;
  var col = document.createElement('button');
  col.type = 'button';
  col.className = 'action-opt';
  col.textContent = 'Change color';
  col.setAttribute('aria-label', 'Change color of selected accounts');
  col.addEventListener('click', function () {
    accountActionOpen = false;
    panel.hidden = true;
    var host = document.getElementById('accounts');
    var tgl = host && host.querySelector ? host.querySelector('[data-action-btn]') : null;
    if (tgl) tgl.setAttribute('aria-expanded', 'false');
    openDialog('color-dialog');
  });
  panel.appendChild(col);
  // Group… is offered only for grouping-clean selections: mains regroup
  // through Ungroup, and sub-accounts have no regroup option at all — the
  // button simply isn't there when one is selected.
  var grpBlocked = false;
  try {
    var stG = loadState();
    grpBlocked = Object.keys(selectedAccounts).some(function (id) {
      return !!accountById(stG, id) && (isGroupMain(stG, id) || groupMainOf(stG, id));
    });
  } catch (e) { grpBlocked = false; }
  if (!grpBlocked) {
  var grp = document.createElement('button');
  grp.type = 'button';
  grp.className = 'action-opt';
  grp.textContent = 'Group…';
  grp.setAttribute('aria-label', 'Group selected accounts under one main');
  grp.addEventListener('click', function () {
    accountActionOpen = false;
    panel.hidden = true;
    var host = document.getElementById('accounts');
    var tgl = host && host.querySelector ? host.querySelector('[data-action-btn]') : null;
    if (tgl) tgl.setAttribute('aria-expanded', 'false');
    var st = loadState();
    var ids = Object.keys(selectedAccounts).filter(function (id) { return !!accountById(st, id); });
    if (!ids.length) return;
    for (var i = 0; i < ids.length; i++) {
      if (isGroupMain(st, ids[i])) { showBanner('"' + accountById(st, ids[i]).name + '" is already a main account — ungroup it first.'); return; }
      if (groupMainOf(st, ids[i])) { showBanner('"' + accountById(st, ids[i]).name + '" is a sub-account and cannot be grouped.'); return; }
    }
    openGroupDialog(ids);
  });
  panel.appendChild(grp);
  }
  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'action-del';
  del.textContent = 'Delete';
  del.setAttribute('aria-label', 'Delete selected accounts and their trades');
  del.addEventListener('click', function () {
    accountActionOpen = false;
    var s0 = loadState();
    var picked = Object.keys(selectedAccounts).filter(function (id) { return !!accountById(s0, id); });
    var full = expandDeleteIds(s0, picked);
    var bulkDebtBlock = debtAccountDeleteBlock(s0, full);
    if (bulkDebtBlock) { showBanner(bulkDebtBlock); return; }
    var extra = full.length - picked.length;
    confirmAction('Delete accounts', 'Delete ' + full.length + (full.length === 1 ? ' account' : ' accounts') +
      (extra > 0 ? ' (including ' + extra + ' sub-account' + (extra === 1 ? '' : 's') + ')' : '') +
      ' and all their trades?' + sharedTransfersNote(sharedTransfersOutside(s0, full)) + ' This cannot be undone.', 'Delete', true).then(function (ok) {
      if (!ok) return;
      var s2 = loadState();
      var inSet = {};
      expandDeleteIds(s2, Object.keys(selectedAccounts)).forEach(function (id) { inSet[id] = true; });
      var bulkDebtBlockNow = debtAccountDeleteBlock(s2, Object.keys(inSet));
      if (bulkDebtBlockNow) { showBanner(bulkDebtBlockNow); return; }
      if (!Object.keys(inSet).length) {
        selectedAccounts = {};
        selectionMode = false;
        render();
        return;
      }
      // Owned trades go; transfers pointing into the set go too — otherwise
      // the next load would silently drop the survivors' half of the move.
      s2.trades = (s2.trades || []).filter(function (t) {
        if (!t) return true;
        return !Object.keys(inSet).some(function (id) { return transferInvolvesAccount(t, id); });
      });
      s2.accounts = (s2.accounts || []).filter(function (a) { return !a || !inSet[a.id]; });
      selectedAccounts = {};
      selectionMode = false;
      if (!saveStateGuarded(s2)) return;
      try { Object.keys(inSet).forEach(function (id) { delete tradePageByAccount[id]; clearTradeTypeFilterState(id); }); } catch (e) { /* ignore */ }
      clearBanner();
      render();
    });
  });
  panel.appendChild(del);
  wrap.appendChild(panel);
  return wrap;
}

function applyTradeColorToSelection(hex) {
  var st = loadState();
  var ids = Object.keys(selectedTrades);
  if (!ids.length) return;
  if (hex !== null) {
    if (!isValidHexColor(hex)) {
      showBanner('Pick a valid color, e.g. #F7931A.');
      return;
    }
    hex = String(hex).trim().toUpperCase();
  }
  ids.forEach(function (id) {
    var t = findTradeById(st, id);
    if (!t) return;
    if (hex === null) {
      try {
        delete t.color;
      } catch (e) {
        t.color = undefined;
      }
    } else {
      t.color = hex;
    }
  });
  if (!saveStateGuarded(st)) return;
  clearBanner();
  closeDialog('color-dialog');
  render(); // stay in selection mode with the set intact
}

function findTradeById(st, id) {
  if (!id) return null;
  return (st.trades || []).find(function (t) { return t && t.id === id; });
}

function buildTradeAction(accId) {
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  wrap.setAttribute('data-trade-action-wrap', '1');
  var n = selectedTradeCount();
  wrap.hidden = !(tradeSelectionMode && n > 0);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-trade-action-btn', '1');
  btn.textContent = 'Action';
  btn.setAttribute('aria-label', 'Bulk actions for selected records');
  btn.setAttribute('aria-expanded', tradeActionOpen ? 'true' : 'false');
  btn.addEventListener('click', function () {
    tradeActionOpen = !tradeActionOpen;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel';
  panel.setAttribute('data-trade-action-panel', '1');
  panel.hidden = !tradeActionOpen;
  var col = document.createElement('button');
  col.type = 'button';
  col.className = 'action-opt';
  col.textContent = 'Change color';
  col.setAttribute('aria-label', 'Change color of selected records');
  col.addEventListener('click', function () {
    tradeActionOpen = false;
    panel.hidden = true;
    var host = document.getElementById('account-detail');
    var tgl = host && host.querySelector ? host.querySelector('[data-trade-action-btn]') : null;
    if (tgl) tgl.setAttribute('aria-expanded', 'false');
    openDialog('color-dialog');
  });
  panel.appendChild(col);
  // Rearranging is not a bulk action: the grip on every record card is live
  // at all times (like the account cards), so no selection mode is needed.
  wrap.appendChild(panel);
  return wrap;
}
