'use strict';
// Home account list: account cards and the list with paging and filters.

// Home-style account card, shared by the home list and group mains.
// rows come from the joint engine run (same data as the totals). scopeIds
// widens the figures to the whole group (main first); omitted means the
// single account. Standalone rendering is unchanged by construction.
function accountCardEl(st, acc, rows, dtrades, main, withSelect, scopeIds) {
  rows = rows || [];
  var scope = (scopeIds && scopeIds.length) ? scopeIds : [acc.id];
  var scopeSet = {};
  scope.forEach(function (sid) { if (typeof sid === 'string' && sid !== '') scopeSet[sid] = true; });
  var card = document.createElement('article');
  card.className = 'account-card';
  card.setAttribute('data-account', acc.id);
  card.setAttribute('data-account-nav', acc.id);
  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'link');
  card.setAttribute('aria-label', 'Open ' + acc.name + ', ' + String(acc.ticker).toUpperCase());
  var grip = document.createElement('span');
  grip.className = 'drag-handle';
  grip.title = 'Drag to reorder';
  grip.setAttribute('aria-hidden', 'true');
  card.appendChild(grip);
  var avatar = document.createElement('span');
  avatar.className = 'acct-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = String(acc.ticker || '?').substring(0, 4).toUpperCase();
  if (acc.color && isValidHexColor(acc.color)) {
    card.setAttribute('data-colored', '1');
    try {
      card.style.setProperty('--acct-color', String(acc.color).trim().toUpperCase());
      avatar.style.color = contrastText(acc.color);
    } catch (e) { /* ignore */ }
  }
  card.appendChild(avatar);
  var mid = document.createElement('span');
  mid.className = 'acct-mid';
  var nameEl = document.createElement('span');
  nameEl.className = 'account-name';
  nameEl.textContent = acc.name;
  mid.appendChild(nameEl);
  var tickEl = document.createElement('span');
  tickEl.className = 'account-ticker';
  tickEl.textContent = String(acc.ticker).toUpperCase();
  mid.appendChild(tickEl);
  card.appendChild(mid);
  // Scope figures: asset rows arrive pre-folded; cash balances sum across
  // scope cash accounts (native only when every balance shares one fiat).
  var scopeTrades = 0;
  var cashMain = 0;
  var cashKnown = false;
  var cashNative = 0;
  var cashTickers = {};
  var cashContrib = 0;
  var seenTrade = {};
  (dtrades || []).forEach(function (t) {
    if (!t) return;
    if (!Object.keys(scopeSet).some(function (id) { return transferInvolvesAccount(t, id); })) return;
    if (t.id) {
      if (seenTrade[t.id]) return;
      seenTrade[t.id] = true;
    }
    scopeTrades++;
  });
  scope.forEach(function (sid) {
    var sa = null;
    try { sa = accountById(st, sid); } catch (e) { sa = null; }
    if (!sa || !isCashKind(sa.kind)) return;
    var at = accountTrades({ trades: dtrades }, sid);
    if (!at.length) return;
    cashContrib++;
    var b = cashBalance(dtrades, sid, main);
    if (isFinite(Number(b.main))) { cashMain += Number(b.main); cashKnown = true; }
    cashNative += Number(b.native) || 0;
    cashTickers[String(sa.ticker || '').toUpperCase()] = true;
  });
  var pl = 0;
  var mv = 0;
  var mvKnown = false;
  rows.forEach(function (r) {
    pl += r.totalPL;
    if (r.marketValue !== null) { mv += r.marketValue; mvKnown = true; }
  });
  var grossValKnown = mvKnown || cashKnown;
  var grossValNum = (mvKnown ? mv : 0) + (cashKnown ? cashMain : 0);
  var scopeAccounts = scope.map(function (sid) { return accountById(st, sid); }).filter(Boolean);
  var debtInfo = currentDebtValuation(scopeAccounts, main, livePrices);
  var rewardInfo = currentStakeRewardValuation(scopeAccounts, main, livePrices);
  var reportedNet = reportedBalancesNet(debtInfo, rewardInfo);
  var grossIncomplete = rows.some(function (row) { return Number(row.qtyHeld) > 0 && row.marketValue === null; });
  scopeAccounts.forEach(function (account) {
    if (!isCashKind(account.kind)) return;
    var cashHasTrades = accountTrades({ trades: dtrades || [] }, account.id).length > 0;
    if (cashHasTrades) {
      var balance = cashBalance(dtrades || [], account.id, main);
      if (!balance || !isFinite(Number(balance.main))) grossIncomplete = true;
    }
  });
  if (debtInfo.hasDebt) {
    var debtIndicator = document.createElement('span');
    debtIndicator.className = 'acct-debt-indicator';
    debtIndicator.textContent = 'Debt · ' + debtInfo.positionCount;
    mid.appendChild(debtIndicator);
  }
  if (rewardInfo.hasRewards) {
    var rewardIndicator = document.createElement('span');
    rewardIndicator.className = 'acct-debt-indicator acct-reward-indicator';
    rewardIndicator.textContent = 'Rewards · ' + rewardInfo.positionCount;
    mid.appendChild(rewardIndicator);
  }
  var valKnown = reportedNet.has
    ? (reportedNet.complete && !grossIncomplete)
    : grossValKnown;
  var valNum = reportedNet.has
    ? (grossValNum + (reportedNet.complete ? reportedNet.value : 0))
    : grossValNum;
  var figs = document.createElement('span');
  figs.className = 'acct-figs';
  var valv = document.createElement('span');
  valv.className = 'acct-value';
  var plv = document.createElement('span');
  var accTick = String(acc.ticker || '').toUpperCase();
  var debtLoading = reportedNet.has && !reportedNet.complete &&
    (scopeAccounts.some(debtPricesLoading) || scopeAccounts.some(stakeRewardPricesLoading));
  var accLoading = (!valKnown) && (debtLoading || (!!scopeTrades && isPriceLoading(accTick, acc.id)));
  valv.textContent = valKnown ? fmtMoney(valNum, main) : (reportedNet.has || scopeTrades ? (accLoading ? PRICE_LOADING_TEXT : '—') : 'New');
  paintLoading(valv, accLoading, acc.name + ' value');
  if (cashKnown && isFinite(Number(valNum))) valv.setAttribute('data-value', String(Number(valNum)));
  var hasKnownPl = rows.some(function (r) { return r.unrealized !== null || Math.abs(r.realized || 0) > 1e-9; });
  if (hasKnownPl) {
    plv.className = 'acct-pl ' + plClass(pl);
    plv.textContent = fmtMoney(pl, main);
    if (isFinite(Number(pl))) plv.setAttribute('data-value', String(Number(pl)));
  } else if (cashKnown) {
    plv.className = 'acct-pl';
    var tickList = Object.keys(cashTickers);
    if (tickList.length === 1 && scope.length === 1) {
      var only = null;
      try { only = accountById(st, scope[0]); } catch (e) { only = null; }
      var cb0 = cashBalance(dtrades, scope[0], main);
      plv.textContent = fmtQty(cb0.native, cb0.ticker || (only && only.ticker) || '') + ' ' + String(cb0.ticker || (only && only.ticker) || '').toUpperCase();
    } else if (tickList.length === 1) {
      plv.textContent = fmtQty(cashNative, tickList[0]) + ' ' + tickList[0];
    } else {
      plv.textContent = cashContrib + (cashContrib === 1 ? ' account' : ' accounts');
    }
  } else {
    plv.className = 'acct-pl';
    var plLoading = !!scopeTrades && isPriceLoading(accTick, acc.id);
    plv.textContent = scopeTrades ? (plLoading ? PRICE_LOADING_TEXT : '—') : 'New';
    paintLoading(plv, plLoading, acc.name + ' profit');
  }
  figs.appendChild(valv);
  // Cut figures read in full on tap (same overflow-gated popup as the
  // summary cards): narrow phones trim figures around the card's slot, and
  // the cash balance line can hold a long '0.163762314531 XMR' text. There
  // is no label on a home card, so the number itself is the tap target —
  // placeholders ('—', 'New', the '…' loading state) never wire at all.
  if (valKnown && !valv.classList.contains('is-loading') && valv.textContent !== '—') wireTruncTap(valv, 'Account value');
  if (hasKnownPl || cashKnown) wireTruncTap(plv, 'Account P&L');
  figs.appendChild(plv);
  card.appendChild(figs);
  if (withSelect && selectionMode) {
    var cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.className = 'card-check';
    cbx.setAttribute('data-select-check', acc.id);
    cbx.checked = !!selectedAccounts[acc.id];
    cbx.setAttribute('aria-label', 'Select ' + acc.name);
    cbx.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); });
    cbx.addEventListener('change', function () { toggleAccountSelect(acc.id); });
    if (cbx.checked) card.classList.add('selected');
    card.appendChild(cbx);
  }
  // Cards open on click (see nav wiring); the per-card buttons stay in the
  // DOM hidden for programmatic/test use so they never clutter the card.
  var tradeBtn = document.createElement('button');
  tradeBtn.type = 'button';
  tradeBtn.className = 'quiet';
  tradeBtn.textContent = '+ Record';
  tradeBtn.setAttribute('data-account-trade', acc.id);
  tradeBtn.setAttribute('aria-label', 'Add record to ' + acc.name);
  tradeBtn.hidden = true;
  card.appendChild(tradeBtn);
  var openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'quiet acct-open';
  openBtn.textContent = 'Open ›';
  openBtn.setAttribute('data-account-open', acc.id);
  openBtn.setAttribute('aria-label', 'Open ' + acc.name);
  openBtn.hidden = true;
  card.appendChild(openBtn);
  return card;
}

function renderAccounts(st) {
  var host = document.getElementById('accounts');
  if (!host) return;
  var method = st.settings.costMethod;
  var main = st.settings.mainCurrency;
  var accounts = Array.isArray(st.accounts) ? st.accounts : [];
  // View filter: only the selected assets render (cards + totals).
  // Grouped sub-accounts never render on home: their figures and rows fold
  // into the main, so every trade counts exactly once in cards and totals.
  var filter = selectedTickers(st);
  var visibleAccounts = (filter === null
    ? accounts
    : accounts.filter(function (a) { return filter.indexOf(String(a.ticker).toUpperCase()) !== -1; }))
    .filter(function (a) { return !groupMainOf(st, a.id); });
  // Display conversion: native amounts stay in stone; everything shown is
  // converted into the CURRENT main at historical ECB rates (cached).
  var dtrades = convertTrades(st.trades, main);
  // Cash accounts are balance ledgers, never positions: the joint run below
  // stays whole (so cross-account transfer basis never shifts), but cash
  // rows are dropped at aggregation — cards and the hero add cash balances
  // explicitly instead.
  var cashIds = cashAccountIds(st);
  // Joint portfolio engine: one date-ordered pass keeps per-account cost
  // queues separate (so AGGREGATE-BEATS-GLOBAL holds for buy/sell), while
  // transfers move basis from source to dest at the source's basis — the
  // on-chain network fee + any fiat fee land as real losses. Each account's
  // rows are read from the joint run and reused for its card below, so
  // cards and grand totals agree by construction.
  var pf = null;
  try { pf = computePortfolio(dtrades, livePrices, method); } catch (e) { pf = null; }
  function engineRowsFor(accId) {
    if (cashIds[accId]) return []; // cash ledgers skip the engine
    if (pf && pf.byAccount) {
      var m = pf.byAccount[accId];
      if (!m) return [];
      var arr = [];
      m.forEach(function (r) { arr.push(r); });
      arr.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
      return arr;
    }
    // Fallback: independent per-account run (no transfers in legacy data).
    var acc = null;
    try { acc = accountById(st, accId); } catch (e) { acc = null; }
    if (acc && isCashKind(acc.kind)) return [];
    return computePositions(accountTrades({ trades: dtrades }, accId), livePrices, method);
  }
  var scopeRows = {};
  accounts.forEach(function (acc) { scopeRows[acc.id] = engineRowsFor(acc.id); });
  // Mains fold their members' rows in: cards and grand totals agree, and no
  // member trade is ever counted twice.
  var perAcctRows = visibleAccounts.map(function (acc) {
    var rows = (scopeRows[acc.id] || []).slice();
    groupMembers(st, acc.id).forEach(function (m) {
      (scopeRows[m.id] || []).forEach(function (r) { rows.push(r); });
    });
    return rows;
  });
  var grandRows = [];
  perAcctRows.forEach(function (rows) {
    rows.forEach(function (r) { grandRows.push(r); });
  });
  renderSummaryCards(st, grandRows, dtrades, visibleAccounts.length, visibleAccounts);
  // Paged cards, global totals: only the current page renders, while hero,
  // summary and counts always cover every visible account.
  var rowsById = {};
  visibleAccounts.forEach(function (acc, vi) { rowsById[acc.id] = perAcctRows[vi]; });
  var pageCount = Math.max(1, Math.ceil(visibleAccounts.length / ACCOUNT_PAGE_SIZE));
  if (accountPage > pageCount - 1) accountPage = pageCount - 1;
  if (accountPage < 0) accountPage = 0;
  var pageAccounts = visibleAccounts.slice(accountPage * ACCOUNT_PAGE_SIZE, accountPage * ACCOUNT_PAGE_SIZE + ACCOUNT_PAGE_SIZE);
  host.innerHTML = '';
  var landing = document.getElementById('landing');
  var hero = document.getElementById('hero');
  var history = document.getElementById('networth-history');
  var overview = document.getElementById('overview');
  var fab = document.getElementById('fab-trade');
  var emptyState = !accounts.length;
  var hasDebtPositions = accounts.some(function (account) { return accountBalancePositions(account).length > 0; });
  var noTrades = !emptyState && !(st.trades || []).length && !hasDebtPositions;
  if (landing) landing.hidden = !emptyState;
  var landingTicker = document.getElementById('landing-ticker-wrap');
  if (landingTicker) landingTicker.hidden = !emptyState;
  if (hero) hero.hidden = emptyState || noTrades;
  if (history) history.hidden = emptyState || noTrades;
  if (overview) overview.hidden = emptyState || noTrades;
  if (fab) fab.hidden = emptyState || noTrades;
  document.body.classList.toggle('is-empty', emptyState);
  document.body.classList.toggle('has-no-trades', noTrades);
  if (emptyState) {
    wireLanding();
    return;
  }
  if (noTrades) {
    host.appendChild(buildGuidePanel());
  }
  var headRow = document.createElement('div');
  headRow.className = 'section-head';
  var h2 = document.createElement('h2');
  h2.textContent = 'Accounts';
  h2.className = 'section-title';
  headRow.appendChild(h2);
  var actions = document.createElement('div');
  actions.className = 'section-actions';
  var tickers = accountTickers(accounts);
  var effective = filter === null ? tickers : filter;
  var nSel = selectedCount();
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
  selectBtn.setAttribute('data-select-btn', '1');
  selectBtn.textContent = 'Select';
  selectBtn.setAttribute('aria-label', 'Select accounts');
  selectBtn.setAttribute('aria-pressed', selectionMode ? 'true' : 'false');
  selectBtn.addEventListener('click', function () {
    if (selectionMode) cancelSelection();
    else { selectionMode = true; render(); }
  });
  actions.appendChild(selectBtn);
  actions.appendChild(buildAccountFilter(st, tickers, effective));
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ghost';
  addBtn.textContent = '+ Account';
  addBtn.setAttribute('aria-label', 'Create account');
  addBtn.addEventListener('click', function () { openAccountDialog(); });
  actions.appendChild(addBtn);
  headRow.appendChild(actions);
  host.appendChild(headRow);
  if (!visibleAccounts.length) {
    if (hero) hero.hidden = true;
    if (overview) overview.hidden = true;
    if (fab) fab.hidden = true;
    var noneNote = document.createElement('p');
    noneNote.className = 'muted';
    noneNote.textContent = 'No accounts match this filter — pick assets in Filter above.';
    host.appendChild(noneNote);
    restoreAccountFilterFocus();
    return;
  }
  pageAccounts.forEach(function (acc) {
    host.appendChild(accountCardEl(st, acc, rowsById[acc.id] || [], dtrades, main, true, [acc.id].concat(groupMembers(st, acc.id).map(function (m) { return m.id; }))));
  });
  if (pageCount > 1) host.appendChild(buildAccountPager(pageCount, accountPage));
  restoreAccountFilterFocus();
}

function buildAccounts() {
  var host = document.getElementById('accounts');
  if (host && !host.getAttribute('data-wired')) {
    host.setAttribute('data-wired', '1');
    host.addEventListener('click', function (e) {
      var t = e && e.target && e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.id === 'acct-create') {
        createAccount(uiVal('acct-name', ''), uiVal('acct-ticker', ''));
        return;
      }
      if (t.hasAttribute('data-guide-trade')) {
        openPrefillTrade(null);
        return;
      }
      if (t.hasAttribute('data-account-trade')) {
        openPrefillTrade(t.getAttribute('data-account-trade'), true);
        return;
      }
      if (t.hasAttribute('data-account-open')) {
        navTo(t.getAttribute('data-account-open'));
        return;
      }
      if (t.hasAttribute('data-account-rename')) {
        var rid = t.getAttribute('data-account-rename');
        var card = t.closest ? t.closest('[data-account]') : null;
        var headEl = t.closest ? t.closest('.account-head') : null;
        var nameEl = card ? card.querySelector('.account-name') : null;
        startInlineRename(rid, headEl, nameEl);
        return;
      }
      if (t.hasAttribute('data-account-delete')) {
        deleteAccount(t.getAttribute('data-account-delete'));
        return;
      }
      var del = e.target && e.target.closest ? e.target.closest('[data-del]') : null;
      if (del) {
        deleteTrade(del.getAttribute('data-del'));
        return;
      }
    });
  }
  // Folder-card navigation (home → detail). Buttons keep their own
  // behavior; anything else on the card opens the account page.
  // Mousemove spotlight: cursor position feeds the card sheen (CSS vars).
  var navHost = document.getElementById('accounts');
  if (navHost && !navHost.getAttribute('data-nav-wired')) {
    navHost.setAttribute('data-nav-wired', '1');
    navHost.addEventListener('mousemove', function (e) {
      var card = e.target && e.target.closest ? e.target.closest('.account-card') : null;
      if (!card) return;
      var r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
    navHost.addEventListener('click', function (e) {
      if (!e || !e.target || !e.target.closest) return;
      if (suppressCardClick) { suppressCardClick = false; return; } // just finished a drag
      if (selectionMode) {
        var scard = e.target.closest('.account-card');
        if (scard && scard.getAttribute('data-account')) {
          toggleAccountSelect(scard.getAttribute('data-account'));
          return;
        }
      }
      if (e.target.closest('button')) return;
      var nav = e.target.closest('[data-account-nav]');
      if (nav && nav.getAttribute('data-account-nav')) {
        navTo(nav.getAttribute('data-account-nav'));
      }
    });
    navHost.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('button')) return;
      var nav = e.target.closest('[data-account-nav]');
      if (nav && nav.getAttribute('data-account-nav')) {
        e.preventDefault();
        navTo(nav.getAttribute('data-account-nav'));
      }
    });
  }
  wireAccountDnD();
  // Filter panel dismissal: click outside or Escape closes without render.
  if (!accountFilterOutsideWired && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    accountFilterOutsideWired = true;
    document.addEventListener('pointerdown', function (e) {
      var t = e && e.target;
      var inF = t && t.closest && (t.closest('[data-filter-panel]') || t.closest('[data-filter-btn]'));
      var inA = t && t.closest && (t.closest('[data-action-panel]') || t.closest('[data-action-btn]'));
      var inTA = t && t.closest && (t.closest('[data-trade-action-panel]') || t.closest('[data-trade-action-btn]'));
      if (!inF) closeAccountFilter(false);
      if (!inF) closeTradeTypeFilter(false);
      if (!inA) closeAccountAction();
      if (!inTA) closeTradeAction();
    });
    document.addEventListener('keydown', function (e) {
      if (e && (e.key === 'Escape' || e.key === 'Esc')) { closeAccountFilter(true); closeTradeTypeFilter(true); closeAccountAction(); closeTradeAction(); }
    });
  }
}
