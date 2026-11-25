'use strict';
// Filters: account ticker filter on the home list and the per-account record
// type and date-interval filters.

var accountFilterOpen = false;
var accountFilterFocus = null;
var accountFilterOutsideWired = false;

// View filter: null = show every asset, otherwise exactly these tickers.
// Persisted in settings (backup/restore carry it); absent key means all.
function selectedTickers(st) {
  var f = st && st.settings ? st.settings.accountFilter : null;
  if (f === undefined || f === null) return null;
  return normalizeAccountFilter(f);
}

function accountTickers(accounts) {
  var seen = {};
  var out = [];
  (accounts || []).forEach(function (a) {
    var t = String((a && a.ticker) || '').toUpperCase();
    if (!t || seen[t]) return;
    seen[t] = true;
    out.push(t);
  });
  return out.sort();
}

function setAccountFilter(next, focusTicker) {
  var st = loadState();
  st.settings = st.settings || { mainCurrency: 'EUR', costMethod: 'average' };
  if (next === null) {
    try {
      delete st.settings.accountFilter;
    } catch (e) {
      st.settings.accountFilter = null;
    }
  } else {
    st.settings.accountFilter = next;
  }
  accountFilterFocus = focusTicker || null;
  if (!saveStateGuarded(st)) return;
  render();
}

function closeAccountFilter(moveFocus) {
  if (!accountFilterOpen) return;
  accountFilterOpen = false;
  accountFilterFocus = null;
  var host = document.getElementById('accounts');
  var panel = host && host.querySelector ? host.querySelector('[data-filter-panel]') : null;
  var btn = host && host.querySelector ? host.querySelector('[data-filter-btn]') : null;
  if (panel) panel.hidden = true;
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    if (moveFocus && btn.focus) {
      try { btn.focus(); } catch (e) { /* ignore */ }
    }
  }
}

function restoreAccountFilterFocus() {
  if (!accountFilterOpen || !accountFilterFocus) {
    accountFilterFocus = null;
    return;
  }
  try {
    var host = document.getElementById('accounts');
    var el = host && host.querySelector ? host.querySelector('[data-ticker="' + cssAttrValue(accountFilterFocus) + '"]') : null;
    if (el && el.focus) el.focus();
  } catch (e) { /* ignore */ }
  accountFilterFocus = null;
}

function buildAccountFilter(st, tickers, effective) {
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-filter-btn', '1');
  var f = selectedTickers(st);
  btn.textContent = (f === null) ? 'Filter' : ('Filter · ' + f.length);
  btn.setAttribute('aria-label', 'Filter accounts by asset');
  btn.setAttribute('aria-expanded', accountFilterOpen ? 'true' : 'false');
  btn.addEventListener('click', function () {
    accountFilterOpen = !accountFilterOpen;
    accountFilterFocus = null;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel';
  panel.setAttribute('data-filter-panel', '1');
  panel.hidden = !accountFilterOpen;
  var title = document.createElement('p');
  title.className = 'filter-title';
  title.textContent = 'Show assets';
  panel.appendChild(title);
  function optRow(labelText, checked, ticker) {
    var lab = document.createElement('label');
    lab.className = 'filter-opt';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    if (ticker === null) cb.setAttribute('data-filter-all', '1');
    else cb.setAttribute('data-ticker', ticker);
    var sp = document.createElement('span');
    sp.textContent = labelText;
    lab.appendChild(cb);
    lab.appendChild(sp);
    cb.addEventListener('change', function () {
      if (ticker === null) {
        setAccountFilter(cb.checked ? null : [], null);
        return;
      }
      var cur = effective.slice();
      var ix = cur.indexOf(ticker);
      if (cb.checked && ix === -1) cur.push(ticker);
      if (!cb.checked && ix !== -1) cur.splice(ix, 1);
      var coversAll = tickers.length > 0 && tickers.every(function (t) { return cur.indexOf(t) !== -1; });
      setAccountFilter(coversAll ? null : cur.sort(), ticker);
    });
    return lab;
  }
  var counts = {};
  (st.accounts || []).forEach(function (a) {
    var t = String((a && a.ticker) || '').toUpperCase();
    if (t) counts[t] = (counts[t] || 0) + 1;
  });
  panel.appendChild(optRow('All', effective.length === tickers.length && tickers.length > 0, null));
  tickers.forEach(function (t) {
    var n = counts[t] || 0;
    panel.appendChild(optRow(t + (n ? ' · ' + n : ''), effective.indexOf(t) !== -1, t));
  });
  wrap.appendChild(panel);
  return wrap;
}

function tradeTypeLabel(t) {
  if (t === 'swap') return 'Swap';
  if (t === 'sell') return 'Sell';
  if (t === 'transfer') return 'Transfer';
  if (t === 'income') return 'Income';
  if (t === 'expense') return 'Expense';
  return 'Buy';
}

// Record-type filter button for the account detail Trades header. Same look
// and checkbox language as the home asset filter (ghost button, Filter · N
// count, All + per-type rows with counts); only the dimension differs.
function buildTradeTypeFilter(acc, atrades) {
  var id = (acc && acc.id) || '';
  var wrap = document.createElement('div');
  wrap.className = 'filter-wrap';
  var cur = tradeTypeFilterFor(id); // null = all
  var dateFilter = tradeDateFilterFor(id);
  var open = !!tradeTypeFilterOpenByAccount[id];
  var section = tradeFilterSectionByAccount[id] || 'records';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.setAttribute('data-filter-btn', '1');
  btn.textContent = (cur === null)
    ? (dateFilter ? 'Filter · Date' : 'Filter')
    : ('Filter · ' + cur.length + (dateFilter ? ' + Date' : ''));
  btn.setAttribute('aria-label', 'Filter records by type or date');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.addEventListener('click', function () {
    tradeTypeFilterOpenByAccount[id] = !tradeTypeFilterOpenByAccount[id];
    tradeTypeFilterFocus = null;
    render();
  });
  wrap.appendChild(btn);
  var panel = document.createElement('div');
  panel.className = 'filter-panel filter-panel-date';
  panel.setAttribute('data-filter-panel', '1');
  panel.hidden = !open;
  var tabs = document.createElement('div');
  tabs.className = 'filter-section-tabs';
  function sectionButton(label, key) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost filter-section-btn' + (section === key ? ' is-active' : '');
    b.textContent = label;
    b.setAttribute('aria-pressed', section === key ? 'true' : 'false');
    b.addEventListener('click', function () {
      tradeFilterSectionByAccount[id] = key;
      render();
    });
    tabs.appendChild(b);
  }
  sectionButton('Records', 'records');
  sectionButton('Date', 'date');
  panel.appendChild(tabs);

  var recordsSection = document.createElement('div');
  recordsSection.hidden = section !== 'records';
  var title = document.createElement('p');
  title.className = 'filter-title';
  title.textContent = 'Show records';
  recordsSection.appendChild(title);
  var counts = {};
  (atrades || []).forEach(function (t) {
    var k = tradeUiType(t);
    if (TRADE_UI_TYPES.indexOf(k) !== -1) counts[k] = (counts[k] || 0) + 1;
  });
  // Swap is offered only when this account has swaps (or the current filter
  // already targets swaps, so the checkbox stays reachable after deletion).
  var uiTypes = TRADE_TYPES.slice();
  if ((counts.swap || 0) > 0 || (cur && cur.indexOf('swap') !== -1)) uiTypes.push('swap');
  function optRow(labelText, checked, type) {
    var lab = document.createElement('label');
    lab.className = 'filter-opt';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    if (type === null) cb.setAttribute('data-ttfilter-all', '1');
    else cb.setAttribute('data-ttype', type);
    var sp = document.createElement('span');
    sp.textContent = labelText;
    lab.appendChild(cb);
    lab.appendChild(sp);
    cb.addEventListener('change', function () {
      if (type === null) {
        setTradeTypeFilter(id, cb.checked ? null : [], null);
        return;
      }
      var base = tradeTypeFilterFor(id);
      var list = (base === null) ? uiTypes.slice() : base.slice();
      var ix = list.indexOf(type);
      if (cb.checked && ix === -1) list.push(type);
      if (!cb.checked && ix !== -1) list.splice(ix, 1);
      var coversAll = uiTypes.every(function (x) { return list.indexOf(x) !== -1; });
      setTradeTypeFilter(id, coversAll ? null : list.sort(), type);
    });
    return lab;
  }
  recordsSection.appendChild(optRow('All', cur === null, null));
  uiTypes.forEach(function (x) {
    var n = counts[x] || 0;
    recordsSection.appendChild(optRow(tradeTypeLabel(x) + (n ? ' · ' + n : ''), cur === null || cur.indexOf(x) !== -1, x));
  });
  panel.appendChild(recordsSection);

  var dateSection = document.createElement('div');
  dateSection.hidden = section !== 'date';
  var dateTitle = document.createElement('p');
  dateTitle.className = 'filter-title';
  dateTitle.textContent = 'Calculation interval';
  dateSection.appendChild(dateTitle);
  var draft = tradeDateDraftByAccount[id];
  if (!draft) {
    draft = dateFilter
      ? { from: dateFilter.from, to: dateFilter.to }
      : { from: firstRecordedTradeDate(atrades), to: '' };
    tradeDateDraftByAccount[id] = draft;
  }
  var dateFields = document.createElement('div');
  dateFields.className = 'filter-date-fields';
  function dateField(labelText, key) {
    var label = document.createElement('label');
    label.className = 'filter-date-field';
    label.textContent = labelText;
    var input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.placeholder = normalizeDateFormat(activeDateFormat);
    input.value = draft[key] ? fmtDateDmy(draft[key]) : '';
    input.setAttribute('data-date-filter-' + key, '1');
    wireDateInput(input);
    input.addEventListener('input', function () {
      draft[key] = parseDateInput(input.value) || input.value;
    });
    input.addEventListener('blur', function () {
      var iso = parseDateInput(input.value);
      if (!iso) return;
      input.value = fmtDateDmy(iso);
      draft[key] = iso;
    });
    label.appendChild(input);
    dateFields.appendChild(label);
    return input;
  }
  var fromInput = dateField('From', 'from');
  var toInput = dateField('To', 'to');
  dateSection.appendChild(dateFields);
  var dateHelp = document.createElement('p');
  dateHelp.className = 'filter-date-help';
  dateHelp.textContent = 'Leave either date blank to include all records on that side.';
  dateSection.appendChild(dateHelp);
  var dateError = document.createElement('p');
  dateError.className = 'filter-date-error';
  dateError.setAttribute('role', 'alert');
  dateError.hidden = true;
  dateSection.appendChild(dateError);
  var dateActions = document.createElement('div');
  dateActions.className = 'filter-date-actions';
  var applyDate = document.createElement('button');
  applyDate.type = 'button';
  applyDate.className = 'ghost';
  applyDate.textContent = 'Apply interval';
  applyDate.addEventListener('click', function () {
    var fromRaw = fromInput.value.trim();
    var toRaw = toInput.value.trim();
    var from = fromRaw ? parseDateInput(fromRaw) : '';
    var to = toRaw ? parseDateInput(toRaw) : '';
    if ((fromRaw && !from) || (toRaw && !to)) {
      dateError.textContent = 'Enter dates in ' + normalizeDateFormat(activeDateFormat) + ' format.';
      dateError.hidden = false;
      return;
    }
    if ((from && isFutureDateStr(from)) || (to && isFutureDateStr(to))) {
      dateError.textContent = 'Choose dates that are not in the future.';
      dateError.hidden = false;
      return;
    }
    if (from && to && from > to) {
      dateError.textContent = 'The start date must be on or before the end date.';
      dateError.hidden = false;
      return;
    }
    delete tradeDateDraftByAccount[id];
    setTradeDateFilter(id, (from || to) ? { from: from, to: to } : null);
  });
  dateActions.appendChild(applyDate);
  var clearDate = document.createElement('button');
  clearDate.type = 'button';
  clearDate.className = 'ghost';
  clearDate.textContent = 'Clear';
  clearDate.addEventListener('click', function () {
    delete tradeDateDraftByAccount[id];
    setTradeDateFilter(id, null);
  });
  dateActions.appendChild(clearDate);
  dateSection.appendChild(dateActions);
  panel.appendChild(dateSection);
  wrap.appendChild(panel);
  return wrap;
}

// --- Trade-type filter (per-account record list) ---
// View-only multi-select over TRADE_TYPES, mirroring the home asset filter:
// null/absent = show every record, otherwise exactly these types. In-memory
// per account (like the page index, and unlike the home asset filter it is
// deliberately NOT persisted: no settings/export shape change). The date
// filter below also stays in-memory, but scopes both calculations and records.
var tradeTypeFilterByAccount = {}; // accountId -> normalized array of types
var tradeTypeFilterOpenByAccount = {}; // accountId -> bool (panel stays open across renders)
var tradeTypeFilterFocus = null; // type to refocus after render, then cleared
var tradeDateFilterByAccount = {}; // accountId -> {from,to}, inclusive ISO dates
var tradeDateDraftByAccount = {}; // un-applied date input values
var tradeFilterSectionByAccount = {}; // accountId -> records | date

function normalizeTradeDateFilter(v) {
  if (!v || typeof v !== 'object') return null;
  var from = (typeof v.from === 'string' && isValidDateStr(v.from) && !isFutureDateStr(v.from)) ? v.from : '';
  var to = (typeof v.to === 'string' && isValidDateStr(v.to) && !isFutureDateStr(v.to)) ? v.to : '';
  if (!from && !to) return null;
  if (from && to && from > to) return null;
  return { from: from, to: to };
}

function tradeDateFilterFor(accountId) {
  if (typeof accountId !== 'string' || accountId === '') return null;
  if (!Object.prototype.hasOwnProperty.call(tradeDateFilterByAccount, accountId)) return null;
  return normalizeTradeDateFilter(tradeDateFilterByAccount[accountId]);
}

function setTradeDateFilter(accountId, next) {
  if (typeof accountId !== 'string' || accountId === '') return;
  var normalized = normalizeTradeDateFilter(next);
  if (normalized) tradeDateFilterByAccount[accountId] = normalized;
  else delete tradeDateFilterByAccount[accountId];
  if (normalized) tradeDateDraftByAccount[accountId] = { from: normalized.from, to: normalized.to };
  else delete tradeDateDraftByAccount[accountId];
  tradePageByAccount[accountId] = 0;
  render();
}

function firstRecordedTradeDate(trades) {
  var first = '';
  (trades || []).forEach(function (t) {
    if (!t || typeof t.date !== 'string' || !isValidDateStr(t.date)) return;
    if (!first || t.date < first) first = t.date;
  });
  return first;
}

function filterTradesByDateRange(trades, filter) {
  var range = normalizeTradeDateFilter(filter);
  if (!range) return (trades || []).slice();
  return (trades || []).filter(function (t) {
    if (!t || typeof t.date !== 'string' || !isValidDateStr(t.date)) return false;
    return (!range.from || t.date >= range.from) && (!range.to || t.date <= range.to);
  });
}

function dateRangeOutflowIssue(scopeTrades, scopeIds, st, allTrades) {
  var inScope = dict();
  (scopeIds || []).forEach(function (id) {
    if (typeof id === 'string' && id !== '') inScope[id] = true;
  });
  var transferSources = dict();
  (scopeTrades || []).forEach(function (t) {
    if (!t || t.type !== 'transfer') return;
    var linked = (scopeIds || []).some(function (id) { return transferInvolvesAccount(t, id); });
    if (!linked) return;
    transferSourceLegs(t).forEach(function (leg) {
      if (!leg || !leg.accountId || inScope[leg.accountId]) return;
      var key = timelineHeldKey(leg.accountId, ledgerSym(t));
      var prior = transferSources[key];
      if (!prior || String(t.date || '') > prior) transferSources[key] = String(t.date || '');
    });
  });
  var checkedTrades = (allTrades || scopeTrades || []).map(function (t) {
    if (!t || t.type !== 'expense' ||
        !(t.qty === undefined || t.qty === null || String(t.qty).trim() === '')) return t;
    var acc = accountById(st, t.accountId);
    var symbol = String(t.symbol || '').toUpperCase();
    var currency = String(t.currency || '').toUpperCase();
    var total = Number(t.total);
    if (!isCashKind(acc && acc.kind) || !symbol || currency !== symbol || !isFinite(total) || total <= 0) return t;
    var copy = {};
    Object.keys(t).forEach(function (key) { copy[key] = t[key]; });
    copy.qty = total;
    return copy;
  });
  var issues = timelineOutflowShortfalls(checkedTrades);
  for (var i = 0; i < issues.length; i++) {
    var issue = issues[i];
    if (inScope[issue.accountId]) return issue;
    var dependencyKey = timelineHeldKey(issue.accountId, issue.symbol);
    var transferDate = transferSources[dependencyKey];
    if (transferDate && String(issue.trade.date || '') <= transferDate) return issue;
  }
  return null;
}

function dateRangeIssueMessage(issue) {
  var label = issue && issue.trade ? tradeTypeLabel(tradeUiType(issue.trade)) : 'outgoing';
  var date = issue && issue.trade && issue.trade.date ? fmtDateDmy(issue.trade.date) : 'the selected interval';
  var symbol = String((issue && issue.symbol) || '').toUpperCase();
  return 'Calculations are hidden because this interval includes an unfunded ' +
    label.toLowerCase() + (date ? ' on ' + date : '') + (symbol ? ' (' + symbol + ')' : '') +
    '. Widen the start date to include earlier purchases, income, or incoming transfers, or choose another interval.';
}

function normalizeTradeTypeFilter(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return null;
  var seen = {};
  var out = [];
  v.forEach(function (t) {
    var s = String(t === undefined || t === null ? '' : t).trim().toLowerCase();
    if (TRADE_UI_TYPES.indexOf(s) === -1 || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out; // [] = none selected (valid: the list shows the no-match note)
}

function tradeTypeFilterFor(accountId) {
  if (typeof accountId !== 'string' || accountId === '') return null;
  if (!Object.prototype.hasOwnProperty.call(tradeTypeFilterByAccount, accountId)) return null;
  return normalizeTradeTypeFilter(tradeTypeFilterByAccount[accountId]);
}

function setTradeTypeFilter(accountId, next, focusType) {
  if (typeof accountId !== 'string' || accountId === '') return;
  var n = normalizeTradeTypeFilter(next);
  if (n === null) {
    try { delete tradeTypeFilterByAccount[accountId]; } catch (e) { /* ignore */ }
  } else {
    tradeTypeFilterByAccount[accountId] = n;
  }
  tradeTypeFilterFocus = focusType || null;
  try { tradePageByAccount[accountId] = 0; } catch (e) { /* page resets on next paint anyway */ }
  render();
}

function filterTradesByType(trades, filter) {
  if (!filter) return (trades || []).slice();
  return (trades || []).filter(function (t) {
    return !!t && filter.indexOf(tradeUiType(t)) !== -1;
  });
}

function clearTradeTypeFilterState(accountId) {
  try { delete tradeTypeFilterByAccount[accountId]; } catch (e) { /* ignore */ }
  try { delete tradeTypeFilterOpenByAccount[accountId]; } catch (e) { /* ignore */ }
  try { delete tradeDateFilterByAccount[accountId]; } catch (e) { /* ignore */ }
  try { delete tradeDateDraftByAccount[accountId]; } catch (e) { /* ignore */ }
  try { delete tradeFilterSectionByAccount[accountId]; } catch (e) { /* ignore */ }
}

function closeTradeTypeFilter(moveFocus) {
  var anyOpen = Object.keys(tradeTypeFilterOpenByAccount).some(function (id) {
    return !!tradeTypeFilterOpenByAccount[id];
  });
  tradeTypeFilterFocus = null;
  if (!anyOpen) return;
  Object.keys(tradeTypeFilterOpenByAccount).forEach(function (id) {
    tradeTypeFilterOpenByAccount[id] = false;
  });
  try {
    var host = document.getElementById('account-detail');
    var panel = host && host.querySelector ? host.querySelector('[data-filter-panel]') : null;
    if (panel) panel.hidden = true;
    var btn = host && host.querySelector ? host.querySelector('[data-filter-btn]') : null;
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      if (moveFocus && btn.focus) {
        try { btn.focus(); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
}

function restoreTradeTypeFilterFocus() {
  if (!tradeTypeFilterFocus) return;
  var anyOpen = Object.keys(tradeTypeFilterOpenByAccount).some(function (id) {
    return !!tradeTypeFilterOpenByAccount[id];
  });
  if (!anyOpen) { tradeTypeFilterFocus = null; return; }
  try {
    var host = document.getElementById('account-detail');
    var el = host && host.querySelector ? host.querySelector('[data-ttype="' + cssAttrValue(tradeTypeFilterFocus) + '"]') : null;
    if (el && el.focus) el.focus();
  } catch (e) { /* ignore */ }
  tradeTypeFilterFocus = null;
}
