'use strict';
// Account detail page.

function renderAccountDetail(st, id) {
  var host = document.getElementById('account-detail');
  if (!host) return;
  var acc = accountById(st, id);
  if (!acc) {
    navHome();
    return;
  }
  var main = st.settings.mainCurrency;
  var method = st.settings.costMethod;
  var allDtrades = convertTrades(st.trades, main);
  var members = groupMembers(st, acc.id);
  var mainOf = groupMainOf(st, acc.id);
  var isCashAccD = isCashKind(acc.kind);
  var dateFilter = tradeDateFilterFor(id);
  var dtrades = filterTradesByDateRange(allDtrades, dateFilter);
  var atrades = accountTrades({ trades: dtrades }, acc.id);
  var scopeIds = [acc.id];
  members.forEach(function (m) { scopeIds.push(m.id); });
  var scopeTrades = [];
  var seenScopeTrades = {};
  scopeIds.forEach(function (sid) {
    accountTrades({ trades: dtrades }, sid).forEach(function (t) {
      if (!t) return;
      if (t.id) {
        if (seenScopeTrades[t.id]) return;
        seenScopeTrades[t.id] = true;
      }
      scopeTrades.push(t);
    });
  });
  var rangeIssue = dateFilter ? dateRangeOutflowIssue(scopeTrades, scopeIds, st, dtrades) : null;
  var historicalEnd = !!(dateFilter && dateFilter.to && dateFilter.to < todayStr());
  var detailPrices = livePrices;
  var historySymbols = [];
  var historyKinds = {};
  if (historicalEnd) {
    var historySymbolSet = {};
    function addHistorySymbol(raw) {
      var symbol = String(raw || '').trim().toUpperCase();
      if (symbol && !historySymbolSet[symbol]) {
        historySymbolSet[symbol] = true;
        historySymbols.push(symbol);
      }
    }
    (st.accounts || []).forEach(function (a) {
      if (!a || scopeIds.indexOf(a.id) === -1) return;
      var symbol = String(a.ticker || '').trim().toUpperCase();
      if (symbol) {
        addHistorySymbol(symbol);
        historyKinds[symbol] = a.kind || '';
      }
      accountBalancePositions(a).forEach(function (position) {
        var debtTicker = String(position.assetTicker || a.ticker || '').trim().toUpperCase();
        var debtKind = String(position.assetKind || a.kind || 'crypto').trim().toLowerCase();
        if (!debtTicker || isCashKind(debtKind)) return;
        addHistorySymbol(debtTicker);
        historyKinds[debtTicker] = debtKind;
      });
    });
    scopeTrades.forEach(function (t) {
      addHistorySymbol(t.symbol);
      if (Array.isArray(t.outputs)) {
        t.outputs.forEach(function (o) { if (o) addHistorySymbol(o.toSymbol); });
      }
      addHistorySymbol(t.toSymbol);
    });
    detailPrices = {};
    historySymbols.forEach(function (symbol) {
      var hit = getHistoricalExec(symbol, dateFilter.to, main, historyKinds[symbol]);
      detailPrices[symbol] = hit && isFinite(Number(hit.price)) && Number(hit.price) > 0
        ? Number(hit.price)
        : null;
    });
    // A ticker held under several asset kinds is priced per kind
    // (see "Price identity"): the bare entry above is never read for it.
    historySymbols.forEach(function (symbol) {
      if (!PRICE_COLLISIONS[symbol]) return;
      Object.keys(PRICE_KINDS_BY_SYMBOL[symbol] || {}).forEach(function (kind) {
        var kh = getHistoricalExec(symbol, dateFilter.to, main, kind);
        detailPrices[priceKeyOf(symbol, kind)] = kh && isFinite(Number(kh.price)) && Number(kh.price) > 0
          ? Number(kh.price)
          : null;
      });
    });
    if (!rangeIssue && historySymbols.length) {
      var historyRequests = historySymbols.map(function (symbol) {
        return { type: 'buy', symbol: symbol, date: dateFilter.to, qty: 1, accountId: id };
      });
      ensureHistoricalExec(historyRequests, main, historyKinds).then(function (changed) {
        if (changed) render();
      });
    }
  }
  var swapInfo = {};
  try { swapInfo = buildSwapPairMap(dtrades); } catch (e) { swapInfo = {}; }
  var rows = [];
  try {
    var pfDet = computePortfolio(dtrades, detailPrices, method);
    var mDet = pfDet.byAccount[id];
    if (mDet && !isCashAccD) mDet.forEach(function (r) { rows.push(r); });
    rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
  } catch (e) {
    rows = isCashAccD ? [] : computePositions(accountTrades({ trades: dtrades }, acc.id), detailPrices, method);
  }
  // Group role: mains aggregate (merged ledgers + sub cards, no trade
  // history), members show transactions without their Ledgers section.
  // Mains fold member engine rows into the stat grid, and member trades
  // into lifetime denominators — cards describe the group, never the
  // (often empty) main alone.
  if (members.length && !isCashAccD) {
    try {
      if (typeof pfDet !== 'undefined' && pfDet && pfDet.byAccount) {
        members.forEach(function (m) {
          var mm = pfDet.byAccount[m.id];
          if (mm) mm.forEach(function (r) { rows.push(r); });
        });
        rows.sort(function (a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
      } else {
        members.forEach(function (m) {
          computePositions(accountTrades({ trades: dtrades }, m.id), detailPrices, method).forEach(function (r) { rows.push(r); });
        });
      }
    } catch (e) { /* aggregation never breaks the view */ }
  }
  var assetLedgersShown = false;
  // FIFO lot linkage, resolved once for every visible card: every trade by
  // id (all accounts, so cross-account transfer closes still resolve) and
  // every closed lot grouped by opening / closing trade. Average pools cost
  // and links nothing — fifoCtx stays null there.
  var tradeById = {};
  (allDtrades || []).forEach(function (t) {
    if (t && typeof t.id === 'string' && t.id !== '') tradeById[t.id] = t;
  });
  var fifoLinks = { byBuy: {}, byClose: {} };
  if (method === 'fifo' && pfDet && pfDet.byAccount) {
    try {
      var lotsAll = [];
      Object.keys(pfDet.byAccount).forEach(function (aid) {
        var mm = pfDet.byAccount[aid];
        function grab(r) { ((r && r.lots) || []).forEach(function (l) { lotsAll.push(l); }); }
        if (mm && typeof mm.forEach === 'function') {
          if (typeof Map !== 'undefined' && mm instanceof Map) mm.forEach(function (r) { grab(r); });
          else if (Array.isArray(mm)) mm.forEach(function (r) { grab(r); });
        }
      });
      fifoLinks = fifoLinksFor(lotsAll);
    } catch (e) { fifoLinks = { byBuy: {}, byClose: {} }; }
  }
  host.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'account-head detail-head';
  var nameEl = document.createElement('h1');
  nameEl.className = 'account-name detail-name';
  nameEl.textContent = acc.name;
  head.appendChild(nameEl);
  var menu = document.createElement('details');
  menu.className = 'menu';
  var sum = document.createElement('summary');
  sum.textContent = '···';
  sum.setAttribute('aria-label', 'Account options');
  menu.appendChild(sum);
  var mbox = document.createElement('div');
  mbox.className = 'menu-box';
  function menuBtn(text, label, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label + ' ' + acc.name);
    b.addEventListener('click', function () {
      menu.removeAttribute('open');
      fn();
    });
    mbox.appendChild(b);
    return b;
  }
  menuBtn('Rename', 'Rename', function () { startInlineRename(acc.id, head, nameEl); });
  menuBtn('Edit label', 'Edit label for', function () { startInlineLabelEdit(acc.id); });
  menuBtn('Edit description', 'Edit description for', function () { startInlineDescriptionEdit(acc.id); });
  // Flat groups: mains and standalone accounts gain subs; members never do.
  if (!mainOf) menuBtn('Create sub-account', 'Create sub-account in', function () { createSubAccount(acc.id); });
  if (members.length) menuBtn('Ungroup', 'Ungroup', function () { ungroupMain(acc.id); });
  menuBtn('Delete', 'Delete', function () { deleteAccount(acc.id); });
  menu.appendChild(mbox);
  head.appendChild(menu);
  host.appendChild(head);
  // Optional free-text label entered at creation (wallet, note, anything) —
  // shown inside the header box with popup-on-overflow like trade notes.
  // The uncapped description follows it, clamped with a "Show more" popup.
  var metaBlock = null;
  function addMeta(label, text, title) {
    if (!metaBlock) {
      metaBlock = document.createElement('div');
      metaBlock.className = 'detail-meta-block';
      head.appendChild(metaBlock);
    }
    metaBlock.appendChild(detailMetaRow(label, text, title));
  }
  if (acc.address) addMeta('Label', acc.address, 'Label');
  if (acc.description) addMeta('Description', acc.description, 'Description');
  if (acc.note) addMeta('Note', acc.note, 'Account note');
  var stats = document.createElement('div');
  stats.className = 'cards detail-stats';
  var mv = 0;
  var mvKnown = false;
  var un = 0;
  var unKnown = false;
  var rz = 0;
  rows.forEach(function (r) {
    rz += r.realized;
    if (r.marketValue !== null) { mv += r.marketValue; mvKnown = true; }
    if (r.unrealized !== null) { un += r.unrealized; unKnown = true; }
  });
  var cost = mv - un;
  var ret = null;
  // Lifetime return: realized+unrealized vs lifetime buy+income cost (consistent with overview).
  var lifetimeForRet = 0;
  try {
    scopeTrades.forEach(function (t) {
      if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
      var cn = normalizeTrade(t);
      // For transfers-in, cost is already in dest's buy-like inflow? No: transfers carry basis via joint engine, but lifetime here should count original buys+income only (transfers move, not new money).
      // atrades includes transfer-in with no total (total 0) so it adds 0 — safe.
      lifetimeForRet += cn.netMain + cn.feeLossMain;
    });
  } catch (e) { lifetimeForRet = 0; }
  if (lifetimeForRet <= 0) lifetimeForRet = cost; // fallback to remaining (closed edge handled below)
  if (mvKnown && unKnown && lifetimeForRet > 0) ret = ((un + rz) / lifetimeForRet) * 100;
  // Holding first, then worth, market, cost, gains: Quantity, Value,
  // Live price, Average entry, Unrealized, Realized, Total P&L, Return.
  // (Single ticker per account, so rows[0] is the position.)
  // A closed position states facts, not leftovers: average of nothing is
  // unknown, the notice sits above the grid (never inside it), and final
  // return is realized vs lifetime buy cost.
  var pos = rows.length ? rows[0] : null;
  var closed = !!(pos && pos.qtyHeld === 0);
  var lifetimeCost = 0;
  if (closed || true) {
    scopeTrades.forEach(function (t) {
      if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
      var cn = normalizeTrade(t);
      lifetimeCost += cn.netMain + cn.feeLossMain;
    });
    if (closed && !rangeIssue) {
      var closedFlag = document.createElement('p');
      closedFlag.className = 'muted closed-flag';
      closedFlag.textContent = 'Closed — nothing held.';
      host.appendChild(closedFlag);
    }
  }
  var qtyExactTxt = null;
  if (pos) {
    try { var qtyScopeIds = [acc.id]; members.forEach(function (m) { qtyScopeIds.push(m.id); }); qtyExactTxt = exactQtyHeldString(dtrades, qtyScopeIds, pos.symbol); } catch (eQ) { qtyExactTxt = null; }
  }
  // Pending income in the account's own asset (unclaimed ADA on an ADA
  // wallet) belongs to the address total, as explorers show it: Quantity and
  // Value include it. P&L does not: it has no cost and is not income until
  // it is claimed.
  var ownSym = String((pos && pos.symbol) || acc.ticker || '').toUpperCase();
  var ownAsOf = historicalEnd ? Date.parse(dateFilter.to + 'T23:59:59.999') : Date.now();
  var ownPending = (!isCashAccD && ownSym)
    ? stakeRewardOwnAssetPending([acc].concat(members), ownSym, acc.kind || 'crypto', ownAsOf)
    : { scaled: 0n, amount: 0, entries: [] };
  var hasOwnPending = ownPending.scaled > 0n;
  var qtyLabel = hasOwnPending ? 'Total quantity' : 'Quantity';
  if (hasOwnPending) {
    var ownDec = qtyDecimals(ownSym);
    var heldSc = qtyExactTxt !== null && qtyExactTxt !== undefined ? exactScaledOf(qtyExactTxt, ownDec)
      : exactScaledOf(pos ? pos.qtyHeld : 0, ownDec);
    var totalSc = (heldSc === null ? 0n : heldSc) + ownPending.scaled;
    var totalTxt = exactToStringFixed(totalSc, ownDec);
    stats.appendChild(statCard(qtyLabel, qtyDisplayTrim(totalTxt, ownSym) + ' ' + ownSym, Number(totalTxt)));
  } else {
    stats.appendChild(statCard('Quantity', pos ? ((qtyExactTxt !== null && qtyExactTxt !== undefined ? qtyDisplayTrim(qtyExactTxt, pos.symbol) : fmtQty(pos.qtyHeld, pos.symbol)) + ' ' + String(pos.symbol || '').toUpperCase()) : '—', pos ? pos.qtyHeld : null));
  }
  if (hasOwnPending) {
    var ownValueKnown = true;
    var ownValue = 0;
    ownPending.entries.forEach(function (entry) {
      var v = debtPositionValuation(entry.reward, main, detailPrices, ownAsOf, entry.owner);
      if (!v.known || v.value === null) ownValueKnown = false;
      else ownValue += v.value;
    });
    // A held position with an unknown price stays unknown; pending alone
    // (nothing held yet) still has a value of its own.
    if (ownValueKnown && (mvKnown || !pos || !(pos.qtyHeld > 0))) { mv += ownValue; mvKnown = true; }
    else if (!ownValueKnown) mvKnown = false;
  }
  // Full grid even with no records yet: unknowns show —, and the live price
  // resolves from the ticker alone so a fresh account already quotes.
  var tickSym = acc && acc.ticker ? String(acc.ticker).toUpperCase() : '';
  var lvRaw = tickSym ? (detailPrices ? detailPrices[tickSym] : null) : null;
  var lvNum = Number(lvRaw);
  var liveShow = pos ? pos.livePrice : ((isFinite(lvNum) && lvNum > 0) ? lvNum : null);
  var detLoading = !historicalEnd && isPriceLoading(tickSym, acc.id);
  stats.appendChild(statCard('Value', mvKnown ? fmtMoney(mv, main) : (detLoading ? PRICE_LOADING_TEXT : '—'), mvKnown ? mv : null, !mvKnown && detLoading));
  stats.appendChild(statCard(historicalEnd ? 'Price on ' + fmtDateDmy(dateFilter.to) : 'Live price', liveShow !== null ? fmtMoney(liveShow, main) : (detLoading ? PRICE_LOADING_TEXT : '—'), liveShow, liveShow === null && detLoading));
  stats.appendChild(statCard('Average entry', (pos && !closed) ? fmtMoney(pos.avgEntry, main) : '—', (pos && !closed) ? pos.avgEntry : null));
  stats.appendChild(statCard('Unrealized', unKnown ? fmtMoney(un, main) : (detLoading ? PRICE_LOADING_TEXT : '—'), unKnown ? un : null, !unKnown && detLoading));
  stats.appendChild(statCard('Realized', fmtMoney(rz, main), rz));
  if (pos) {
    var tplCard = statCard('Total P&L', fmtMoney(pos.totalPL, main), pos.totalPL);
    var tsc = plClass(pos.totalPL);
    if (tsc) tplCard.querySelector('.card-value').classList.add(tsc);
    stats.appendChild(tplCard);
  } else {
    stats.appendChild(statCard('Total P&L', '—', null));
  }
  if (closed && lifetimeCost > 0) ret = (rz / lifetimeCost) * 100;
  var retCard = statCard('Return', ret !== null ? fmtPct(ret) : '—', ret);
  var rsc = plClass(ret);
  if (rsc) retCard.querySelector('.card-value').classList.add(rsc);
  stats.appendChild(retCard);
  // Fee info lives below the 8-card grid as one line (display-only: the fee
  // is already baked into the calculated Real price, zero P&L drag).
  var feesSum = 0, incomeSum = 0;
  rows.forEach(function (r) { feesSum += Number(r.fees) || 0; incomeSum += Number(r.income) || 0; });
  if (Math.abs(incomeSum) > 1e-9) stats.appendChild(statCard('Income', fmtMoney(incomeSum, main), incomeSum));
  if (rangeIssue) {
    var rangeWarning = document.createElement('p');
    rangeWarning.className = 'date-range-warning';
    rangeWarning.setAttribute('role', 'status');
    rangeWarning.textContent = dateRangeIssueMessage(rangeIssue);
    host.appendChild(rangeWarning);
  } else if (isCashAccD) {
    if (members.length) {
      // Main aggregates the group in the header display fiat — like every
      // other card; the Ledgers table below keeps the group currency.
      stats.innerHTML = '';
      var gIds = [acc.id];
      members.forEach(function (m) { gIds.push(m.id); });
      var gNative = 0, gValue = 0, gTick = {}, gHas = false, gContrib = 0;
      gIds.forEach(function (cid) {
        var at = accountTrades({ trades: dtrades }, cid);
        if (!at.length) return;
        gContrib++;
        var cb = null;
        var ckind = '';
        try {
          var cacc = accountById(st, cid);
          ckind = (cacc && typeof cacc.kind === 'string') ? cacc.kind : '';
        } catch (e) { ckind = ''; }
        try { cb = cashBalance(dtrades, cid, main, isCashKind(ckind)); } catch (e) { cb = null; }
        if (!cb) return;
        if (isFinite(Number(cb.main))) { gValue += Number(cb.main); gHas = true; }
        gNative += Number(cb.native) || 0;
        var ca = null;
        try { ca = accountById(st, cid); } catch (e) { ca = null; }
        if (ca && ca.ticker) gTick[String(ca.ticker).toUpperCase()] = true;
      });
      var gTickList = Object.keys(gTick);
      stats.appendChild(statCard('Balance', gHas ? (gTickList.length === 1 ? (fmtQty(gNative, gTickList[0]) + ' ' + gTickList[0]) : (gContrib + (gContrib === 1 ? ' account' : ' accounts'))) : 'New', gHas ? gNative : null));
      stats.appendChild(statCard('Value', gHas ? fmtMoney(gValue, main) : 'New', gHas ? gValue : null));
      stats.classList.add('cards-duo');
      host.appendChild(stats);
    } else {
      buildCashDetailStats(st, acc, dtrades, main, stats, host, mainOf ? { skipLedgers: true } : null);
    }
  } else {
    host.appendChild(stats);
    // Standalone asset accounts show Ledgers while the global switch is on
    // (grouped members and mains are covered by the group view instead).
    // assetLedgersShown feeds the + Ledger bootstrap in the Trades head.
    assetLedgersShown = false;
    if (!mainOf && !members.length) {
      try {
        if (assetLedgersOn(st)) assetLedgersShown = buildAssetLedgers(st, acc, dtrades, main, host) === true;
      } catch (e) { /* Ledgers never break the detail view */ }
    }
  }
  var debtSummaryForDetail = null;
  if (!historicalEnd) {
    var detailScopeAccounts = scopeIds.map(function (scopeId) { return accountById(st, scopeId); }).filter(Boolean);
    var detailGross = currentAccountGrossValue(detailScopeAccounts, rows, allDtrades, main);
    var detailDebt = currentDebtValuation(detailScopeAccounts, main, livePrices);
    var detailRewards = currentStakeRewardValuation(detailScopeAccounts, main, livePrices);
    var detailLent = currentLentOutValuation(detailScopeAccounts, main, livePrices);
    debtSummaryForDetail = { gross: detailGross, debt: detailDebt, rewards: detailRewards, lent: detailLent };
  }
  var debtSection = buildDebtPositionsSection(st, acc, members, host, stats, debtSummaryForDetail);
  buildStakeRewardsSection(st, acc, members, host, debtSection);
  // Group mains: merged ledgers in the group currency plus sub-account
  // cards instead of the spent/fees lines and the trade history below.
  if (members.length) {
    if (!rangeIssue) {
      buildGroupLedgers(st, acc, members, host, dtrades, main);
      buildGroupSubs(st, members, host, dtrades, main, method);
    }
    return;
  }
  // Per-account spent (this account only): lifetime cash legs of expense and
  // transfer records, plus crypto fees and crypto expenses at the frozen
  // tx-date rate — same definition as the home SPENT AMOUNT, scoped to
  // atrades. Sales and swap legs are conversions, never spending: they land
  // in Realized. Orange pill above the red fees pill.
  var spentSum = 0;
  try {
    atrades.forEach(function (t) {
      if (!t) return;
      var sn = normalizeTrade(t);
      if (t.type === 'transfer') {
        var sourceQty = transferSourceQtyFor(t, acc.id);
        if (!(sourceQty > 0)) return; // destination-only views do not count as spending
        var sourceShare = transferSourceShareOf(t, acc.id);
        // Any fiat-valued transfer fields follow the source's net contribution.
        if (isFinite(sn.netMain) && sn.netMain > 0) spentSum += sn.netMain * sourceShare;
        var sourceFee = transferSourceFeeFor(t, acc.id);
        var externalShare = transferExternalQtyOf(t) * sourceShare;
        var cq = sourceFee + externalShare;
        if (isFinite(cq) && cq > 0) {
          var kr = null;
          try { kr = resolveExecPrice(t, main, accKind); } catch (e) { kr = null; }
          if (kr !== null && isFinite(Number(kr.price)) && Number(kr.price) > 0) spentSum += cq * Number(kr.price);
        }
      } else if (t.accountId === acc.id && t.type === 'expense') {
        spentSum += expenseSpentMain(t, main, accKind);
      }
    });
  } catch (e) { spentSum = 0; }
  if (!rangeIssue && !isCashAccD && spentSum > 1e-9) {
    var spentLine = document.createElement('p');
    spentLine.className = 'spent-line';
    spentLine.setAttribute('data-label', 'Spent amount');
    spentLine.setAttribute('data-value', String(spentSum));
    spentLine.textContent = 'Spent amount: ' + fmtMoney(spentSum, main);
    host.appendChild(spentLine);
  }
  if (!rangeIssue && !isCashAccD && Math.abs(feesSum) > 1e-9) {
    var feesLine = document.createElement('p');
    feesLine.className = 'fees-line';
    feesLine.setAttribute('data-label', 'Total fees paid');
    feesLine.setAttribute('data-value', String(feesSum));
    feesLine.textContent = 'Total fees paid: ' + fmtMoney(feesSum, main);
    host.appendChild(feesLine);
  }
  var tHead = document.createElement('div');
  tHead.className = 'section-head trades-head' + (tradeSelectionMode ? ' is-selecting' : '');
  var tTitle = document.createElement('h2');
  tTitle.className = 'section-title';
  tTitle.textContent = 'Trades';
  tHead.appendChild(tTitle);
  if (atrades.length || dateFilter) {
    var tAdd = document.createElement('button');
    tAdd.type = 'button';
    tAdd.className = 'ghost t-add';
    tAdd.textContent = '+ Record';
    tAdd.setAttribute('aria-label', 'Add record to ' + acc.name);
    tAdd.addEventListener('click', function () { openPrefillTrade(acc.id, true); });
    // Keep Select in its original position; the filter and add controls stay
    // aligned at the right edge as before.
    var tradeSelectBtn = document.createElement('button');
    tradeSelectBtn.type = 'button';
    tradeSelectBtn.className = 'ghost' + (tradeSelectionMode ? ' select-on' : '');
    tradeSelectBtn.setAttribute('data-trade-select-btn', '1');
    tradeSelectBtn.textContent = 'Select';
    tradeSelectBtn.setAttribute('aria-label', 'Select records');
    tradeSelectBtn.setAttribute('aria-pressed', tradeSelectionMode ? 'true' : 'false');
    tradeSelectBtn.addEventListener('click', function () {
      if (tradeSelectionMode) cancelTradeSelection();
      else { tradeSelectionMode = true; render(); }
    });
    if (atrades.length) tHead.appendChild(tradeSelectBtn);
    tHead.appendChild(buildTradeTypeFilter(acc, atrades));
    // Bootstrap: standalone asset accounts with nothing labeled yet get
    // their + Ledger here (filter … + Ledger … + Record); once the Ledgers
    // section exists it owns the button instead.
    if (!isCashAccD && !mainOf && !members.length && !assetLedgersShown) {
      var showBoot = false;
      try { showBoot = assetLedgersOn(st); } catch (e) { showBoot = false; }
      if (showBoot) {
        var lBoot = document.createElement('button');
        lBoot.type = 'button';
        lBoot.className = 'ghost';
        lBoot.textContent = '+ Ledger';
        lBoot.setAttribute('data-ledger-add', acc.id);
        lBoot.setAttribute('aria-label', 'Add ledger to ' + acc.name);
        lBoot.addEventListener('click', function () { openLedgerDialog(acc.id); });
        tHead.appendChild(lBoot);
      }
    }
    tHead.appendChild(tAdd);
    if (tradeSelectionMode) {
      var nSel = selectedTradeCount();
      var countEl = document.createElement('span');
      countEl.className = 'muted select-count';
      countEl.setAttribute('data-trade-select-count', '1');
      countEl.textContent = nSel + ' selected';
      countEl.hidden = nSel === 0;
      tHead.appendChild(countEl);
      tHead.appendChild(buildTradeAction(acc.id));
    }
  host.appendChild(tHead);
    var nameById = function (aid) { var a = accountById(st, aid); return a ? a.name : ''; };
    var accKind = (acc && typeof acc.kind === 'string') ? acc.kind : undefined;
    // Paged records: sort once, then build DOM only for the visible slice.
    // Off-page records cost nothing per paint (no tradeBlock, no exec-rate
    // resolution, single fragment insert) while totals above still use all.
    // Record-type filter only changes this list. The date interval also
    // scopes the calculations above, while both filters remain independent.
    var typeFilter = tradeTypeFilterFor(acc.id);
    // Newest date first. Within one date the engines walk the store slice as
    // execution order, while the list feeds it newest-execution-first: the
    // latest move of the day sits on top, the day's first move at the bottom —
    // a feed the reader reads top-is-latest. The drag translates the displayed
    // order back to execution order before validating/booking (see the drop
    // handler); the store itself is never reordered for display.
    var allAtrades = accountTrades({ trades: allDtrades }, acc.id);
    var allSorted = reversePerDateBlocks(allAtrades.slice().sort(function (a, b) {
      var da = (a && typeof a.date === 'string') ? a.date : '';
      var db = (b && typeof b.date === 'string') ? b.date : '';
      if (da < db) return 1;
      if (da > db) return -1;
      return 0; // stable: same-date records keep their store order
    }));
    var fullSorted = filterTradesByDateRange(allSorted, dateFilter);
    var sortedTrades = filterTradesByType(fullSorted, typeFilter);
    var tradeTotal = sortedTrades.length;
    var tradePageCount = tradePageCountFor(tradeTotal);
    var tradePage = tradePageGet(acc.id, tradeTotal);
    var tradeStart = tradePage * tradePageSize;
    var tradeEnd = Math.min(tradeStart + tradePageSize, tradeTotal);
    // Bottom bar, always on one line: range + pager + per-page selector.
    // The bar renders after the records (always at the bottom, even with a
    // single page); only the pager numbers hide when everything fits.
    var bottomBar = document.createElement('div');
    bottomBar.className = 'trade-bottom-bar';
    bottomBar.setAttribute('data-trade-bottom', '1');
    var rangeEl = document.createElement('span');
    rangeEl.className = 'muted trade-range';
    rangeEl.setAttribute('data-trade-range', '1');
    rangeEl.textContent = tradeTotal
      ? 'Showing ' + (tradeStart + 1) + '–' + tradeEnd + ' of ' + tradeTotal
      : 'No records match this filter';
    bottomBar.appendChild(rangeEl);
    if (tradePageCount > 1) bottomBar.appendChild(buildTradePager(acc.id, tradeTotal, tradePageCount, tradePage));
    var perWrap = document.createElement('label');
    perWrap.className = 'per-page';
    var perTxt = document.createElement('span');
    perTxt.className = 'muted';
    perTxt.textContent = 'Per page';
    perWrap.appendChild(perTxt);
    var perSel = document.createElement('select');
    perSel.setAttribute('data-trade-per-page', '1');
    perSel.setAttribute('aria-label', 'Records per page');
    TRADE_PAGE_SIZES.forEach(function (n) {
      var o = document.createElement('option');
      o.value = String(n);
      o.textContent = String(n);
      if (n === tradePageSize) o.selected = true;
      perSel.appendChild(o);
    });
    perSel.addEventListener('change', function () {
      tradePageSizeSet(perSel.value);
      tradePageSetFor(acc.id, 0, tradeTotal);
      render();
    });
    perWrap.appendChild(perSel);
    bottomBar.appendChild(perWrap);
    var frag = (typeof document.createDocumentFragment === 'function')
      ? document.createDocumentFragment()
      : null;
    // Linked-record jumps: same-page targets scroll + flash in place, while
    // off-page (paged-out) targets jump to their page first, then flash.
    var flashTradeCard = function (el) {
      // Phones: open first, then scroll — a lot-link jump should reveal the
      // record's facts, not flash a collapsed stub. (setTradeCardOpen runs the
      // ⓘ gate itself; desktop is untouched.)
      try { if (isMobileView()) setTradeCardOpen(el, true); } catch (e) { /* ignore */ }
      try {
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      } catch (e) { /* ignore */ }
      try {
        el.classList.add('flash');
        setTimeout(function () { try { el.classList.remove('flash'); } catch (e4) { /* ignore */ } }, 1600);
      } catch (e5) { /* ignore */ }
    };
    var gotoTrade = function (id) {
      if (typeof id !== 'string' || id === '') return;
      var target = null;
      try {
        var cards = host.querySelectorAll('[data-trade]');
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].getAttribute('data-trade') === id) { target = cards[i]; break; }
        }
      } catch (e) { target = null; }
      if (target) { flashTradeCard(target); return; }
      var idx = -1;
      for (var k = 0; k < sortedTrades.length; k++) {
        if (sortedTrades[k] && sortedTrades[k].id === id) { idx = k; break; }
      }
      if (idx < 0) {
        // Not in the filtered view: clear both filters so lot-link jumps land.
        var fullIdx = -1;
        for (var k2 = 0; k2 < allSorted.length; k2++) {
          if (allSorted[k2] && allSorted[k2].id === id) { fullIdx = k2; break; }
        }
        if (fullIdx < 0) return;
        delete tradeDateFilterByAccount[acc.id];
        delete tradeDateDraftByAccount[acc.id];
        setTradeTypeFilter(acc.id, null);
        var fullPage = Math.floor(fullIdx / tradePageSize);
        if (fullPage !== 0) {
          tradePageSetFor(acc.id, fullPage, allSorted.length);
          render();
        }
        try {
          setTimeout(function () {
            var el = null;
            try {
              var cs = document.querySelectorAll('#account-detail [data-trade]');
              for (var j = 0; j < cs.length; j++) {
                if (cs[j].getAttribute('data-trade') === id) { el = cs[j]; break; }
              }
            } catch (e2b) { el = null; }
            if (el) flashTradeCard(el);
          }, 60);
        } catch (e3b) { /* ignore */ }
        return;
      }
      var pg = Math.floor(idx / tradePageSize);
      if (pg === tradePage) return;
      tradePageSetFor(acc.id, pg, tradeTotal);
      render();
      try {
        setTimeout(function () {
          var el = null;
          try {
            var cs = document.querySelectorAll('#account-detail [data-trade]');
            for (var j = 0; j < cs.length; j++) {
              if (cs[j].getAttribute('data-trade') === id) { el = cs[j]; break; }
            }
          } catch (e2) { el = null; }
          if (el) flashTradeCard(el);
        }, 60);
      } catch (e3) { /* ignore */ }
    };
    var fifoCtx = (method === 'fifo')
      ? { links: fifoLinks, byId: tradeById, main: main, go: gotoTrade }
      : null;
    for (var ti = tradeStart; ti < tradeEnd; ti++) {
      var tb = tradeBlock(sortedTrades[ti], main, nameById, accKind, fifoCtx, swapInfo, scopeIds);
      if (frag) frag.appendChild(tb);
      else host.appendChild(tb);
    }
    if (frag) host.appendChild(frag);
    host.appendChild(bottomBar);
    // Record reordering lives on the always-visible grip (like account
    // cards); wireTradeDnD wires the host listeners once, later calls no-op.
    // The open account is stamped on the host so the one-time listeners know
    // which account's list a drag belongs to.
    host.setAttribute('data-view-account', acc.id);
    wireTradeDnD();
    restoreTradeTypeFilterFocus();
  } else {
    host.appendChild(tHead);
    var emptyTrades = document.createElement('div');
    emptyTrades.className = 'empty-trades';
    var muted = document.createElement('p');
    muted.className = 'muted';
    muted.textContent = 'No trades yet — add one to see P&L.';
    emptyTrades.appendChild(muted);
    var eAdd = document.createElement('button');
    eAdd.type = 'button';
    eAdd.className = 'primary';
    eAdd.textContent = '+ Record';
    eAdd.setAttribute('aria-label', 'Add record to ' + acc.name);
    eAdd.addEventListener('click', function () { openPrefillTrade(acc.id, true); });
    emptyTrades.appendChild(eAdd);
    host.appendChild(emptyTrades);
  }
}
