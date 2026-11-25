'use strict';
// Ledger views: ledger rows, group and asset ledgers, the ledger dialog and
// ledger rename / delete.

function ledgerRowEl(code, label, total, main, depth, opts) {
  var o = opts || {};
  var unlabeled = (code === '—');
  var d = document.createElement('div');
  d.className = 'stat-row ledger-row' + (o.isParent ? ' is-parent' : '') + (unlabeled ? ' is-unlabeled' : '');
  d.setAttribute('data-label', 'ledger');
  d.setAttribute('data-ledger', code);
  if (isFinite(Number(total))) d.setAttribute('data-value', String(Number(total)));
  try { d.style.paddingLeft = 'calc(0.6rem + ' + (depth * 1.9) + 'rem)'; } catch (e) { /* ignore */ }
  // Parents collapse to the top ledger only: the arrow hides the whole subtree.
  // Every row reserves the arrow slot (spacer when childless) so labels sit
  // on one x per depth and never jump when a ledger gains children later.
  // Virtual Unlabeled rows can never have children: no slot, label starts
  // at the very beginning of the row.
  if (o.hasKids) {
    var tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'quiet ledger-toggle';
    tog.textContent = o.collapsed ? '▸' : '▾';
    tog.setAttribute('data-ledger-toggle', code);
    tog.setAttribute('aria-expanded', o.collapsed ? 'false' : 'true');
    tog.setAttribute('aria-label', (o.collapsed ? 'Expand ledger ' : 'Collapse ledger ') + code);
    d.appendChild(tog);
  } else if (!unlabeled) {
    var sp = document.createElement('span');
    sp.className = 'ledger-toggle-sp';
    sp.setAttribute('aria-hidden', 'true');
    d.appendChild(sp);
  }
  // Fixed slots keep every amount at the same x: long names truncate with
  // ellipsis and an ⓘ popup (same pattern as record notes), never pushing.
  // Virtual Unlabeled rows join code and name with a plain space (no dot).
  var full = unlabeled ? (code + (label ? ' ' + label : '')) : (code + ((label && label !== code) ? ' · ' + label : ''));
  var l = document.createElement('span');
  l.className = 'stat-label ledger-label';
  var lt = document.createElement('span');
  lt.className = 'ledger-label-text';
  lt.textContent = full;
  l.appendChild(lt);
  function openFull() {
    if (!isVisuallyCut(lt)) return;
    openNoteDialog(full, 'Ledger ' + code);
  }
  lt.setAttribute('role', 'button');
  lt.setAttribute('tabindex', '0');
  lt.setAttribute('aria-label', 'Show full ledger name');
  lt.addEventListener('click', openFull);
  lt.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFull(); }
  });
  infoDot(l, openFull, lt);
  d.appendChild(l);
  var side = document.createElement('span');
  side.className = 'ledger-side';
  var v = document.createElement('span');
  // Parent overviews carry a boxed total: income-tinted when the rolled sum
  // is positive, expense-tinted when negative (pill colors, not a pill).
  var boxCls = '';
  if (o.isParent) {
    var tv = Number(total);
    if (isFinite(tv) && tv > 0) boxCls = ' ledger-box-inc';
    else if (isFinite(tv) && tv < 0) boxCls = ' ledger-box-exp';
  }
  v.className = 'stat-val num ledger-amount' + boxCls + ' ' + (plClass(total) || '');
  v.textContent = fmtMoney(total, main);
  side.appendChild(v);
  // Structural rows can be removed from this account's chart (materializes
  // the account's own chart when it still follows the default).
  if (code !== '—') {
    var ed = document.createElement('button');
    ed.type = 'button';
    ed.className = 'quiet';
    ed.textContent = 'Edit';
    ed.setAttribute('data-ledger-edit', code);
    ed.setAttribute('aria-label', 'Edit ledger ' + code + ' in this account');
    side.appendChild(ed);
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'quiet';
    del.textContent = 'Delete';
    del.setAttribute('data-ledger-del', code);
    del.setAttribute('aria-label', 'Delete ledger ' + code + ' from this account');
    side.appendChild(del);
  } else {
    // Unlabeled rows carry no actions, but they must stand exactly as tall:
    // invisible same-box placeholders reserve the Edit/Delete height.
    ['Edit', 'Delete'].forEach(function (t) {
      var ph = document.createElement('button');
      ph.type = 'button';
      ph.className = 'quiet ledger-act-sp';
      ph.textContent = t;
      ph.disabled = true;
      ph.tabIndex = -1;
      ph.setAttribute('aria-hidden', 'true');
      side.appendChild(ph);
    });
  }
  d.appendChild(side);
  return d;
}

// One-line cleanup hint for overview-rule breakers. Never throws.
function appendLedgerWarn(host, viol) {
  try {
    if (!viol || !viol.length) return;
    var shown = viol.slice(0, 3).map(function (c) { return '"' + c + '"'; }).join(', ');
    var wn = document.createElement('p');
    wn.className = 'muted ledger-warn';
    wn.textContent = 'Heads-up: ' + shown + (viol.length > 3 ? ', …' : '') +
      (viol.length === 1 ? ' holds' : ' hold') + ' records and sub-ledgers — move ' +
      (viol.length === 1 ? 'its' : 'their') + ' records to a child so ' +
      (viol.length === 1 ? 'it stays' : 'they stay') + ' a pure total.';
    host.appendChild(wn);
  } catch (e) { /* hint never breaks render */ }
}

// Shared ledger list: tree rows (collapse per key) plus the Unlabeled
// buckets that exist. Edit/delete run on chartId across the whole scope
// (the main's chart for groups); toggles are view-only collapse state.
function appendLedgerList(host, tree, ccy, opts) {
  var o = opts || {};
  var key = o.key;
  var chartId = o.chartId;
  var scope = (o.scope && o.scope.length) ? o.scope : [chartId];
  var list = document.createElement('div');
  list.className = 'ledger-list';
  list.setAttribute('data-ledger-account', chartId);
  var collapsed = (key && ledgerCollapsed[key]) || {};
  (function walk(nodes, depth) {
    nodes.forEach(function (n) {
      var kids = (n.kids && n.kids.length) ? n.kids : [];
      var isCol = !!collapsed[n.code];
      list.appendChild(ledgerRowEl(n.code, n.label, n.total, ccy, depth, { hasKids: kids.length > 0, collapsed: isCol, isParent: kids.length > 0 }));
      if (kids.length && !isCol) walk(kids, depth + 1);
    });
  })(tree.roots, 0);
  if (tree.unassignedIncomeCount) list.appendChild(ledgerRowEl('—', 'Unlabeled income', tree.unassignedIncome, ccy, 0));
  if (tree.unassignedExpenseCount) list.appendChild(ledgerRowEl('—', 'Unlabeled expenses', tree.unassignedExpense, ccy, 0));
  if (tree.unassignedAssetsCount) list.appendChild(ledgerRowEl('—', 'Unlabeled assets', tree.unassignedAssets, ccy, 0));
  list.addEventListener('click', function (e) {
    if (!e || !e.target || !e.target.closest) return;
    var tog = e.target.closest('[data-ledger-toggle]');
    if (tog) {
      var tc = tog.getAttribute('data-ledger-toggle');
      var set = (key && ledgerCollapsed[key]) || (ledgerCollapsed[key] = {});
      if (set[tc]) delete set[tc]; else set[tc] = true;
      render();
      return;
    }
    var be = e.target.closest('[data-ledger-edit]');
    if (be) { openLedgerDialog(chartId, be.getAttribute('data-ledger-edit'), scope); return; }
    var btn = e.target.closest('[data-ledger-del]');
    if (!btn) return;
    deleteAccountLedger(chartId, btn.getAttribute('data-ledger-del'), scope);
  });
  host.appendChild(list);
  return list;
}

// Cash account detail: balance cards plus the bookkeeping ledger tree
// (prefix roll-up). No cost-basis cards, no spent/fees lines — the flows
// below plus the tree are the accounting view. opts.skipLedgers hides the
// Ledgers section (grouped members show it on their main instead).
function buildCashDetailStats(st, acc, dtrades, main, stats, host, opts) {
  stats.innerHTML = ''; // drop the cost-basis grid (built for assets above)
  var bal = cashBalance(dtrades, acc.id, main);
  stats.appendChild(statCard('Balance', fmtQty(bal.native, bal.ticker || acc.ticker) + ' ' + String(bal.ticker || acc.ticker || '').toUpperCase(), bal.native));
  stats.appendChild(statCard('Value', fmtMoney(bal.main, main), bal.main));
  // Two cards in a four-track box: center the pair (see cards-duo).
  stats.classList.add('cards-duo');
  host.appendChild(stats);
  if (opts && opts.skipLedgers) return;
  var labels = ledgerChartFor(st, acc.id);
  var tree = ledgerTree(dtrades, acc.id, main, labels);
  var sec = document.createElement('div');
  sec.className = 'section-head ledgers-head';
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = 'Ledgers';
  sec.appendChild(h);
  var ladd = document.createElement('button');
  ladd.type = 'button';
  ladd.className = 'ghost';
  ladd.textContent = '+ Ledger';
  ladd.setAttribute('aria-label', 'Add ledger to ' + acc.name);
  ladd.addEventListener('click', function () { openLedgerDialog(acc.id); });
  sec.appendChild(ladd);
  host.appendChild(sec);
  // Empty or not, a created chart always shows: tree.roots carries chart
  // codes with zero of their own, so an empty 1000 still renders its row.
  // Unlabeled buckets never render alone — without roots there is no table,
  // only the note below (never an Unlabeled-only table for no reason).
  if (!tree.roots.length) {
    var noneNote = document.createElement('p');
    noneNote.className = 'muted';
    noneNote.textContent = 'No ledgers yet — add a parent code like 1000, then post to subledgers.';
    host.appendChild(noneNote);
    return;
  }
  appendLedgerList(host, tree, main, { key: acc.id, chartId: acc.id, scope: [acc.id] });
  // Legacy cleanup hint: a parent that still holds records breaks the
  // overview rule — point at it once so it can be moved to a child.
  try { appendLedgerWarn(host, ledgerViolations(st, acc.id)); } catch (e) { /* ignore */ }
}

// Group mains: merged ledgers across the main + members, then home-style
// sub-account cards instead of the trade history.
function groupLedgerCurrency(st, mainAcc) {
  var g = mainAcc && typeof mainAcc.groupCurrency === 'string' ? mainAcc.groupCurrency.trim().toUpperCase() : '';
  if (MAIN_CURRENCIES.indexOf(g) !== -1) return g;
  return defaultGroupCurrency(st, mainAcc);
}

// Visibility gate: the Ledgers panel shows when there is something to
// show — a chart code or at least one in-scope record carrying a ledger
// code (income/expense/buy/sell plus labeled transfers, which also post
// tree rows). Unlabeled buckets alone never open the panel.
function groupHasLabels(allTrades, ids) {
  var set = dict();
  (ids || []).forEach(function (id) { if (typeof id === 'string' && id !== '') set[id] = true; });
  return (allTrades || []).some(function (t) {
    if (!t || !set[t.accountId]) return false;
    if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'buy' && t.type !== 'sell' && t.type !== 'transfer') return false;
    return String(t.ledger || '').trim() !== '';
  });
}

function buildGroupLedgers(st, mainAcc, members, host, dtrades, headerMain) {
  var ids = [mainAcc.id];
  members.forEach(function (m) { ids.push(m.id); });
  var gCcy = groupLedgerCurrency(st, mainAcc);
  var sec = document.createElement('div');
  sec.className = 'section-head ledgers-head';
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = 'Ledgers';
  sec.appendChild(h);
  var cur = document.createElement('select');
  cur.setAttribute('aria-label', 'Group ledger currency');
  MAIN_CURRENCIES.forEach(function (c) {
    var op = document.createElement('option');
    op.value = c;
    op.textContent = c;
    if (c === gCcy) op.selected = true;
    cur.appendChild(op);
  });
  cur.addEventListener('change', function () {
    var v = String(cur.value || '').toUpperCase();
    if (MAIN_CURRENCIES.indexOf(v) === -1) return;
    var s2 = loadState();
    var m2 = accountById(s2, mainAcc.id);
    if (!m2) return;
    m2.groupCurrency = v;
    if (!saveStateGuarded(s2)) return;
    clearBanner();
    render();
  });
  sec.appendChild(cur);
  var ladd = document.createElement('button');
  ladd.type = 'button';
  ladd.className = 'ghost';
  ladd.textContent = '+ Ledger';
  ladd.setAttribute('aria-label', 'Add ledger to ' + mainAcc.name);
  ladd.addEventListener('click', function () { openLedgerDialog(mainAcc.id, null, ids); });
  sec.appendChild(ladd);
  host.appendChild(sec);
  // The head (currency + first-ledger entry) always renders; rows show as
  // soon as the chart exists (even empty of records, like standalone
  // accounts) or something is actually labeled.
  var groupChart = null;
  try { groupChart = ledgerChartFor(st, mainAcc.id); } catch (e) { groupChart = null; }
  var hasGroupChart = !!(groupChart && Object.keys(groupChart).length);
  if (!hasGroupChart && !groupHasLabels(st.trades, ids)) {
    var gateNote = document.createElement('p');
    gateNote.className = 'muted';
    gateNote.textContent = 'No labeled records yet — post records with ledger codes in the sub-accounts.';
    host.appendChild(gateNote);
    return;
  }
  var gdtrades = (gCcy === headerMain) ? dtrades : convertTrades(st.trades, gCcy);
  var kinds = dict();
  ids.forEach(function (id) {
    var a = accountById(st, id);
    kinds[id] = (a && typeof a.kind === 'string') ? a.kind : '';
  });
  var tree = ledgerTreeMulti(gdtrades, ids, gCcy, ledgerChartFor(st, mainAcc.id), kinds);
  // Roots carry chart codes (even empty) plus posted codes: an Unlabeled
  // bucket alone never renders a table.
  if (!tree.roots.length) {
    var noneNote = document.createElement('p');
    noneNote.className = 'muted';
    noneNote.textContent = 'No labeled records yet — post records with ledger codes in the sub-accounts.';
    host.appendChild(noneNote);
    return;
  }
  appendLedgerList(host, tree, gCcy, { key: mainAcc.id, chartId: mainAcc.id, scope: ids });
  try {
    var vset = {};
    ids.forEach(function (sid) {
      ledgerViolations(st, sid).forEach(function (c) { vset[c] = true; });
    });
    appendLedgerWarn(host, Object.keys(vset).sort());
  } catch (e) { /* ignore */ }
}

function buildGroupSubs(st, members, host, dtrades, main, method) {
  var sec = document.createElement('div');
  sec.className = 'section-head';
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = 'Sub-accounts';
  sec.appendChild(h);
  var count = document.createElement('span');
  count.className = 'muted';
  count.textContent = String(members.length);
  sec.appendChild(count);
  var actions = document.createElement('div');
  actions.className = 'section-actions';
  var nSel = 0;
  try { nSel = selectedCount(); } catch (e) { nSel = 0; }
  if (selectionMode) {
    var countEl = document.createElement('span');
    countEl.className = 'muted select-count';
    countEl.setAttribute('data-select-count', '1');
    countEl.textContent = nSel + ' selected';
    countEl.hidden = nSel === 0;
    actions.appendChild(countEl);
    actions.appendChild(buildAccountAction());
  }
  var selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'ghost' + (selectionMode ? ' select-on' : '');
  selectBtn.textContent = 'Select';
  selectBtn.setAttribute('aria-label', 'Select sub-accounts');
  selectBtn.setAttribute('aria-pressed', selectionMode ? 'true' : 'false');
  selectBtn.addEventListener('click', function () {
    if (selectionMode) cancelSelection();
    else { selectionMode = true; render(); }
  });
  actions.appendChild(selectBtn);
  sec.appendChild(actions);
  host.appendChild(sec);
  var wrap = document.createElement('div');
  wrap.className = 'group-subs';
  var cashIds = {};
  try { cashIds = cashAccountIds(st); } catch (e) { cashIds = {}; }
  var perRows = {};
  try {
    var pf = computePortfolio(dtrades, livePrices, method);
    members.forEach(function (m) {
      if (cashIds[m.id]) { perRows[m.id] = []; return; }
      var mm = (pf && pf.byAccount) ? pf.byAccount[m.id] : null;
      var arr = [];
      if (mm) mm.forEach(function (r) { arr.push(r); });
      arr.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
      perRows[m.id] = arr;
    });
  } catch (e) {
    members.forEach(function (m) { perRows[m.id] = []; });
  }
  members.forEach(function (m) {
    wrap.appendChild(accountCardEl(st, m, perRows[m.id] || [], dtrades, main, true, [m.id]));
  });
  wrap.addEventListener('click', function (e) {
    if (!e || !e.target || !e.target.closest) return;
    if (suppressCardClick) { suppressCardClick = false; return; } // just finished a sub drag
    if (selectionMode) {
      var scard = e.target.closest('.account-card');
      if (scard && scard.getAttribute('data-account')) {
        toggleAccountSelect(scard.getAttribute('data-account'));
        return;
      }
    }
    if (e.target.closest('button')) return;
    var nav = e.target.closest('[data-account-nav]');
    if (nav && nav.getAttribute('data-account-nav')) navTo(nav.getAttribute('data-account-nav'));
  });
  wrap.addEventListener('keydown', function (e) {
    if (!e || (e.key !== 'Enter' && e.key !== ' ')) return;
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('button')) return;
    var nav = e.target.closest('[data-account-nav]');
    if (nav && nav.getAttribute('data-account-nav')) {
      e.preventDefault();
      navTo(nav.getAttribute('data-account-nav'));
    }
  });
  host.appendChild(wrap);
  try { wireGroupSubsDnD(wrap); } catch (e) { /* subs render without drag */ }
}

// Standalone asset accounts with the global switch on: their labeled
// income/expense rolls into a Ledgers section (same rows as cash); the
// unlabeled rest pools into Unlabeled assets. The panel shows as soon as
// anything is created — a chart code (even empty, e.g. 1000 with no
// records) or a posted code — and never as an Unlabeled-only table: with
// no roots there is no section at all (the Trades head keeps the
// + Ledger bootstrap instead).
function buildAssetLedgers(st, acc, dtrades, main, host) {
  var ids = [acc.id];
  var kinds = dict();
  kinds[acc.id] = (acc && typeof acc.kind === 'string') ? acc.kind : '';
  var tree = ledgerTreeMulti(dtrades, ids, main, ledgerChartFor(st, acc.id), kinds);
  if (!tree.roots.length) return false;
  var sec = document.createElement('div');
  sec.className = 'section-head ledgers-head';
  var h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = 'Ledgers';
  sec.appendChild(h);
  var ladd = document.createElement('button');
  ladd.type = 'button';
  ladd.className = 'ghost';
  ladd.textContent = '+ Ledger';
  ladd.setAttribute('aria-label', 'Add ledger to ' + acc.name);
  ladd.addEventListener('click', function () { openLedgerDialog(acc.id); });
  sec.appendChild(ladd);
  host.appendChild(sec);
  appendLedgerList(host, tree, main, { key: acc.id, chartId: acc.id, scope: ids });
  try { appendLedgerWarn(host, ledgerViolations(st, acc.id)); } catch (e) { /* ignore */ }
  return true;
}

// Per-account ledger management: add/rename writes the account's own
// chart (snapshotting the default first); delete removes the code plus its
// whole subtree from the account's chart and clears those codes off the
// account's records, which then surface under Unlabeled income/expenses.
// Collapse state is per-account and in-session: toggling a parent hides its
// whole subtree until expanded again (render rebuilds from this map).
var ledgerCollapsed = {};
var ledgerDialogAccountId = null;
var ledgerDialogEditingCode = null;
var ledgerDialogScope = null;

function buildLedgerDialog() {
  var host = document.getElementById('ledger-dialog-body');
  if (!host || document.getElementById('ld-save')) return;
  wireDialog('ledger-dialog');
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<label for="ld-code">Code</label>' +
    '<input id="ld-code" autocomplete="off" spellcheck="false" placeholder="e.g. 1100" maxlength="24">' +
    '<label for="ld-label">Label</label>' +
    '<input id="ld-label" autocomplete="off" spellcheck="false" placeholder="e.g. Projects" maxlength="80">' +
    dockMarkup('ld-error', 'Save ledger', 'ld-save', 'button');
  host.appendChild(wrap);
  document.getElementById('ld-save').addEventListener('click', function () {
    function fail(msg) { dockError('ld-error', msg); }
    dockError('ld-error', '');
    var accId = ledgerDialogAccountId;
    var editing = ledgerDialogEditingCode;
    var code = uiVal('ld-code', '').trim();
    var label = uiVal('ld-label', '').trim();
    if (!code || !isValidLedgerCode(code) || code === '') { fail('Ledger needs a code (e.g. 1100).'); return; }
    if (!label) { fail('Ledger needs a label (e.g. Projects).'); return; }
    if (!isValidLedgerLabel(label)) { fail('Ledger label is too long — up to 80 characters.'); return; }
    var st = loadState();
    if (!accountById(st, accId)) { fail('Account not found.'); return; }
    if (editing) {
      var rerr = renameAccountLedger(st, accId, editing, code, label, ledgerDialogScope);
      if (rerr) { fail(rerr); return; }
      if (code !== editing && ledgerCollapsed[accId] && ledgerCollapsed[accId][editing]) {
        ledgerCollapsed[accId][code] = true;
        try { delete ledgerCollapsed[accId][editing]; } catch (e) { /* ignore */ }
      }
    } else {
      var map = ensureAccountChart(st, accId);
      if (Object.prototype.hasOwnProperty.call(map, code)) { fail('Ledger code already exists — pick a new code or edit it.'); return; }
      if (Object.keys(map).length >= 500) { fail('This account already holds 500 codes.'); return; }
      map[String(code).trim()] = String(label).trim();
    }
    if (!saveStateGuarded(st)) { fail('Storage unavailable — ledger was not saved.'); return; }
    ledgerDialogEditingCode = null;
    ledgerDialogScope = null;
    uiSetVal('ld-code', '');
    uiSetVal('ld-label', '');
    closeDialog('ledger-dialog');
    clearBanner();
    render();
  });
}

function openLedgerDialog(accountId, editCode, scopeIds) {
  ledgerDialogAccountId = accountId;
  ledgerDialogEditingCode = (editCode === undefined || editCode === null) ? null : String(editCode).trim();
  ledgerDialogScope = (scopeIds && scopeIds.length) ? scopeIds.slice() : null;
  buildLedgerDialog();
  var title = document.getElementById('ledger-dialog-title');
  var save = document.getElementById('ld-save');
  if (ledgerDialogEditingCode) {
    var lbl = '';
    try {
      var st = loadState();
      lbl = findLedgerLabel(st, accountId, ledgerDialogEditingCode, ledgerDialogScope) || '';
    } catch (e) { lbl = ''; }
    uiSetVal('ld-code', ledgerDialogEditingCode);
    uiSetVal('ld-label', lbl);
    if (title) title.textContent = 'Edit ledger';
    if (save) save.textContent = 'Save changes';
  } else {
    uiSetVal('ld-code', '');
    uiSetVal('ld-label', '');
    if (title) title.textContent = 'New ledger';
    if (save) save.textContent = 'Save ledger';
  }
  dockError('ld-error', '');
  openDialog('ledger-dialog');
}

// Clone just enough state to simulate a ledger rename: account charts +
// record ledgers. The source state is never touched.
function cloneLedgerState(st) {
  function copyObj(o) {
    var n = {};
    if (!o || typeof o !== 'object') return n;
    Object.keys(o).forEach(function (k) { n[k] = o[k]; });
    return n;
  }
  var c = { settings: (st && st.settings) || {}, accounts: [], trades: [], priceOverrides: (st && st.priceOverrides) || {} };
  ((st && st.accounts) || []).forEach(function (a) {
    var n = copyObj(a);
    if (a && a.ledgers && typeof a.ledgers === 'object' && !Array.isArray(a.ledgers)) {
      n.ledgers = copyObj(a.ledgers);
    }
    c.accounts.push(n);
  });
  ((st && st.trades) || []).forEach(function (t) { c.trades.push(copyObj(t)); });
  return c;
}

// Rename (or relabel) one ledger inside an account's own chart: the chart
// entry moves and every record carrying the old code follows it, so the
// tree + totals never lose money. Pure against the passed state (no DOM,
// no save): returns an error string, or null on success. scopeIds widens
// record migration + violation checks to the whole group (main first);
// omitted means the single account.
function renameAccountLedger(st, accountId, oldCode, newCode, newLabel, scopeIds) {
  oldCode = (oldCode === undefined || oldCode === null) ? '' : String(oldCode).trim();
  newCode = (newCode === undefined || newCode === null) ? '' : String(newCode).trim();
  newLabel = (newLabel === undefined || newLabel === null) ? '' : String(newLabel).trim();
  if (!oldCode) return 'Ledger not found.';
  if (!accountById(st, accountId)) return 'Account not found.';
  if (!newCode || !isValidLedgerCode(newCode)) return 'Ledger needs a code (e.g. 1100).';
  if (!newLabel) return 'Ledger needs a label (e.g. Projects).';
  if (!isValidLedgerLabel(newLabel)) return 'Ledger label is too long — up to 80 characters.';
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [accountId];
  // A transfer also belongs to every secondary source account, so a ledger
  // rename/delete reaches records shared into this scope, not just owned ones.
  function inScope(t) {
    if (!t) return false;
    for (var i = 0; i < scope.length; i++) {
      if (t.accountId === scope[i]) return true;
      if (t.type === 'transfer' && transferSourceIds(t).indexOf(scope[i]) !== -1) return true;
    }
    return false;
  }
  function violationsUnion(s) {
    var set = dict();
    scope.forEach(function (sid) {
      var v = [];
      try { v = ledgerViolations(s, sid); } catch (e) { v = []; }
      v.forEach(function (c) { set[c] = true; });
    });
    return Object.keys(set).sort();
  }
  var map = ensureAccountChart(st, accountId);
  if (newCode !== oldCode) {
    if (Object.prototype.hasOwnProperty.call(map, newCode)) return 'Ledger code already exists — pick a new code or edit it.';
    var posted = false;
    (st.trades || []).forEach(function (t) {
      if (inScope(t) && String(t.ledger || '').trim() === newCode) posted = true;
    });
    if (posted) return 'Ledger code already exists — pick a new code or edit it.';
    if (Object.keys(map).length >= 500) return 'This account already holds 500 codes.';
    // Parent-overview rule, judged on the AFTER state: simulate the rename
    // on a clone and block only when it would newly strand records on a
    // parent (a record-free parent renamed under other codes just works).
    var before = violationsUnion(st);
    var sim = cloneLedgerState(st);
    var smap = ensureAccountChart(sim, accountId);
    if (Object.prototype.hasOwnProperty.call(smap, oldCode)) delete smap[oldCode];
    smap[newCode] = newLabel;
    (sim.trades || []).forEach(function (t) {
      if (!t || !inScope(t)) return;
      if (String(t.ledger || '').trim() === oldCode) { t.ledger = newCode; t.ledgerLabel = newLabel; }
    });
    var added = [];
    try {
      added = violationsUnion(sim).filter(function (c) { return before.indexOf(c) === -1; });
    } catch (e) { added = []; }
    if (added.length) return '"' + added[0] + '" would hold records and sub-ledgers after this change — move its records to a child ledger first, keeping parents record-free.';
    if (Object.prototype.hasOwnProperty.call(map, oldCode)) delete map[oldCode];
    map[newCode] = newLabel;
  } else {
    map[oldCode] = newLabel;
  }
  (st.trades || []).forEach(function (t) {
    if (!inScope(t)) return;
    if (String(t.ledger || '').trim() === oldCode) { t.ledger = newCode; t.ledgerLabel = newLabel; }
  });
  return null;
}

function deleteAccountLedger(accountId, code, scopeIds) {
  if (!accountId || !code) return;
  code = String(code).trim();
  if (!code || code === '—') return;
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [accountId];
  // A transfer also belongs to every secondary source account, so a ledger
  // rename/delete reaches records shared into this scope, not just owned ones.
  function inScope(t) {
    if (!t) return false;
    for (var i = 0; i < scope.length; i++) {
      if (t.accountId === scope[i]) return true;
      if (t.type === 'transfer' && transferSourceIds(t).indexOf(scope[i]) !== -1) return true;
    }
    return false;
  }
  var st = loadState();
  var acc = accountById(st, accountId);
  if (!acc) return;
  var effective = ledgerChartFor(st, accountId);
  var allSet = {};
  Object.keys(effective).forEach(function (k) { var ck = String(k).trim(); if (ck) allSet[ck] = true; });
  (st.trades || []).forEach(function (t) {
    if (!inScope(t)) return;
    var kc = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (kc) allSet[kc] = true;
  });
  var subs = ledgerDescendantsOf(code, Object.keys(allSet));
  var doomedSet = {};
  doomedSet[code] = true;
  subs.forEach(function (c) { doomedSet[c] = true; });
  var recCount = 0;
  (st.trades || []).forEach(function (t) {
    if (!inScope(t)) return;
    var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
    if (c && doomedSet[c]) recCount++;
  });
  var label = effective[code] ? code + ' · ' + effective[code] : code;
  var subTxt = subs.length ? ' Also deletes ' + subs.length + ' sub-ledger' + (subs.length === 1 ? '' : 's') + ' underneath (' + subs.slice().sort().join(', ') + ').' : '';
  var unlabeledNoun = scope.length > 1 ? 'the Unlabeled buckets' : 'Unlabeled income/expenses';
  var recTxt = recCount ? ' ' + recCount + ' record' + (recCount === 1 ? '' : 's') + ' lose' + (recCount === 1 ? 's' : '') + ' their ledger and move under ' + unlabeledNoun + ' (totals unchanged).' : ' No records use it.';
  confirmAction('Delete ledger', 'Delete "' + label + '" from ' + acc.name + '?' + subTxt + recTxt, 'Delete', true).then(function (ok) {
    if (!ok) return;
    var s2 = loadState();
    if (!accountById(s2, accountId)) return;
    var map = ensureAccountChart(s2, accountId);
    Object.keys(doomedSet).forEach(function (c) {
      if (Object.prototype.hasOwnProperty.call(map, c)) delete map[c];
    });
    (s2.trades || []).forEach(function (t) {
      if (!inScope(t)) return;
      var c = (t.ledger === undefined || t.ledger === null) ? '' : String(t.ledger).trim();
      if (c && doomedSet[c]) {
        try { delete t.ledger; } catch (e) { t.ledger = undefined; }
        try { delete t.ledgerLabel; } catch (e) { t.ledgerLabel = undefined; }
      }
    });
    if (!saveStateGuarded(s2)) return;
    clearBanner();
    render();
  });
}
