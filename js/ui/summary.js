'use strict';
// Totals panel: summary cards and debt valuations. Grand totals are the sum
// of the per-account runs.

function uniqueSymbols(trades) {
  var seen = {};
  var out = [];
  (trades || []).forEach(function (t) {
    var s = String((t && t.symbol) || '').toUpperCase();
    if (!s || seen[s]) return;
    seen[s] = true;
    out.push(s);
  });
  return out;
}

// gain/loss tint for P&L figures (Revolut-style): '' for zero/unknown.
function plClass(n) {
  var v = Number(n);
  if (!isFinite(v) || v === 0) return '';
  return v > 0 ? 'gain' : 'loss';
}

function statCard(label, text, raw, loading) {
  var d = document.createElement('div');
  d.className = 'card';
  d.setAttribute('data-label', label);
  var l = document.createElement('span');
  l.className = 'card-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'card-value num';
  v.textContent = text;
  if (raw !== null && raw !== undefined && isFinite(Number(raw))) {
    d.setAttribute('data-value', String(Number(raw)));
    v.setAttribute('data-value', String(Number(raw)));
  }
  if (loading) paintLoading(v, true, label);
  // Summary values live in fixed cells and phone grids cut them mid-string
  // (an XMR Quantity shows '1.1627635427…  X…' — the symbol trimmed too).
  // The standard overflow-gated popup hands over the full string from the
  // DOM; placeholders ('—', the '…' loading state) stay inert.
  var cardTxt = String(text === undefined || text === null ? '' : text);
  if (!loading && cardTxt.trim() !== '' && cardTxt.trim() !== '—') {
    wireTruncTap(v, label, l);
  }
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

// Auto-fit hero digits: fixed box, fluid numbers. The digits live in an
// inner span sized here; the outer line keeps its CSS size, so the strut —
// and therefore the box — never moves. Starts from the CSS clamp size and
// steps down until the amount fits one line (floor ~1.4rem); ellipsis
// remains as the last resort. Re-run on render + resize.
function fitHeroValue() {
  try {
    var el = null;
    try { el = document.getElementById('hero-value-num'); } catch (e0) { el = null; }
    if (!el) el = document.getElementById('hero-value');
    if (!el || !el.style) return;
    el.style.fontSize = '';
    if (typeof getComputedStyle !== 'function') return;
    var size = parseFloat(getComputedStyle(el).fontSize);
    if (!isFinite(size) || size <= 0) return;
    var floor = 22;
    var guard = 0;
    while (guard < 30 && size > floor && el.scrollWidth > el.clientWidth + 1) {
      size -= 2;
      el.style.fontSize = size + 'px';
      guard++;
    }
  } catch (e) { /* ignore */ }
}

function summaryLifetimeCost(st, rows, dtrades, visibleAccounts) {
  var cashIds = cashAccountIds(st);
  var included = dict();
  (visibleAccounts || []).forEach(function (account) {
    if (!account || !account.id) return;
    included[account.id] = true;
    groupMembers(st, account.id).forEach(function (member) { included[member.id] = true; });
  });
  var buyBySym = {};
  (dtrades || []).forEach(function (t) {
    if (!t || !included[t.accountId] || cashIds[t.accountId] || (t.type !== 'buy' && t.type !== 'income')) return;
    var symbol = String(t.symbol || '').toUpperCase();
    var qty = Number(t.qty);
    if (!symbol || !isFinite(qty) || qty <= 0) return;
    var normalized = normalizeTrade(t);
    buyBySym[symbol] = (buyBySym[symbol] || 0) + normalized.netMain + normalized.feeLossMain;
  });
  var knownSyms = {};
  (rows || []).forEach(function (position) {
    if (position.unrealized !== null || Math.abs(position.realized || 0) > 1e-9) knownSyms[position.symbol] = true;
  });
  var lifetime = 0;
  Object.keys(buyBySym).forEach(function (symbol) {
    if (knownSyms[symbol]) lifetime += buyBySym[symbol];
  });
  if (!(lifetime > 0)) {
    (rows || []).forEach(function (position) {
      if (position.marketValue !== null && position.unrealized !== null) lifetime += position.marketValue - position.unrealized;
    });
  }
  return lifetime > 0 ? lifetime : 0;
}

// Current liability valuation is separate from holdings/trade accounting.
// Prices are already denominated in the selected main currency; fiat debt
// uses the same date-pinned FX cache as other cash balance displays.
function debtPositionValuation(position, main, prices, asOf, owningAccount) {
  if (!position) return { value: null, known: false, amount: 0 };
  var cutoff = asOf === undefined || asOf === null ? Date.now() : asOf;
  var snapshot = latestDebtBalanceSnapshot(position, cutoff);
  var amount = snapshot ? Number(snapshot.amount) : 0;
  if (!(amount > 0)) return { value: 0, known: true, amount: 0 };
  var ticker = String(position.assetTicker || (owningAccount && owningAccount.ticker) || '').trim().toUpperCase();
  var kind = String(position.assetKind || (owningAccount && owningAccount.kind) || 'crypto').trim().toLowerCase();
  if (!ticker) return { value: null, known: false, amount: amount };
  var day = todayStr();
  var mainUp = String(main || '').trim().toUpperCase();
  var value = null;
  if (isCashKind(kind)) {
    var rate = ticker === mainUp ? { rate: 1 } : getCachedRate(day, ticker, mainUp);
    if (rate && isFinite(Number(rate.rate)) && Number(rate.rate) > 0) value = amount * Number(rate.rate);
  } else {
    var priceMap = prices || livePrices || {};
    var key = priceKeyOf(ticker, kind);
    var price = Number(priceMap[key]);
    if (!(isFinite(price) && price > 0) && !PRICE_COLLISIONS[ticker]) price = Number(priceMap[ticker]);
    if (isFinite(price) && price > 0) value = amount * price;
    else if (stableToUsd(ticker)) {
      if (mainUp === 'USD') value = amount;
      else {
        var fx = getCachedRate(day, 'USD', mainUp);
        if (fx && isFinite(Number(fx.rate)) && Number(fx.rate) > 0) value = amount * Number(fx.rate);
      }
    }
  }
  return {
    value: (value !== null && isFinite(value)) ? value : null,
    known: (value !== null && isFinite(value)),
    amount: amount
  };
}

function currentDebtValuation(accounts, main, prices, asOf) {
  var source = Array.isArray(accounts) ? accounts : [];
  var priceMap = prices || livePrices || {};
  var cutoff = asOf === undefined || asOf === null ? Date.now() : asOf;
  var seen = Object.create(null);
  var total = 0;
  var hasDebt = false;
  var complete = true;
  var positionCount = 0;
  source.forEach(function (account) {
    if (!account || !account.id || seen[account.id]) return;
    seen[account.id] = true;
    var positions = accountDebtPositions(account);
    if (!positions.length) return;
    positionCount += positions.length;
    hasDebt = true;
    positions.forEach(function (position) {
      var posVal = debtPositionValuation(position, main, priceMap, cutoff, account);
      if (!(posVal.amount > 0)) return;
      if (!posVal.known || posVal.value === null) complete = false;
      else total += posVal.value;
    });
  });
  return {
    value: complete ? total : null,
    partialValue: total,
    hasDebt: hasDebt,
    complete: complete,
    positionCount: positionCount
  };
}

function currentAccountGrossValue(accounts, rows, trades, main) {
  var total = 0;
  var complete = true;
  (rows || []).forEach(function (row) {
    if (!(Number(row.qtyHeld) > 0)) return;
    if (row.marketValue === null || !isFinite(Number(row.marketValue))) complete = false;
    else total += Number(row.marketValue);
  });
  (accounts || []).forEach(function (account) {
    if (!account || !isCashKind(account.kind)) return;
    var balance = null;
    try { balance = cashBalance(trades || [], account.id, main); } catch (e) { balance = null; }
    if (!balance || !isFinite(Number(balance.main))) complete = false;
    else total += Number(balance.main);
  });
  return { value: complete ? total : null, partialValue: total, complete: complete };
}

function debtAccountsForScope(st, baseAccounts) {
  var list = [];
  var seen = dict();
  (baseAccounts || []).forEach(function (account) {
    if (!account || !account.id) return;
    var scope = [account].concat(groupMembers(st, account.id) || []);
    scope.forEach(function (item) {
      if (!item || !item.id || seen[item.id]) return;
      seen[item.id] = true;
      list.push(item);
    });
  });
  return list;
}

function renderSummaryCards(st, rows, dtradesOpt, nAcctsOpt, visibleAccounts) {
  var main = st.settings.mainCurrency;
  var mv = 0;
  var un = 0;
  var rz = 0;
  var pl = 0;
  var mvKnown = false;
  var unKnown = false;
  var hasRealized = false;
  // Cash ledgers: balances count toward total Value only — never toward
  // Unrealized/Realized/Return/Invested/Spent. Same asset filter as cards.
  var cashIdsS = {};
  try { cashIdsS = cashAccountIds(st); } catch (e) { cashIdsS = {}; }
  var cashTickers = {};
  try {
    ((st && st.accounts) || []).forEach(function (a) {
      if (a && a.id && cashIdsS[a.id] && a.ticker) cashTickers[a.id] = String(a.ticker).toUpperCase();
    });
  } catch (e) { cashTickers = {}; }
  var cashFilter = null;
  try { cashFilter = selectedTickers(st); } catch (e) { cashFilter = null; }
  function cashVisible(aid) {
    if (!cashIdsS[aid]) return false;
    if (cashFilter === null) return true;
    return cashFilter.indexOf(cashTickers[aid] || '') !== -1;
  }
  var dtrCash = null;
  try { dtrCash = dtradesOpt || convertTrades(st.trades, main); } catch (e) { dtrCash = []; }
  var cashTrades = 0;
  (dtrCash || []).forEach(function (t) {
    if (!t) return;
    if (Object.keys(cashIdsS).some(function (id) { return cashVisible(id) && transferInvolvesAccount(t, id); })) cashTrades++;
  });
  var cashBalTotal = 0;
  var cashBalKnown = false;
  Object.keys(cashIdsS).forEach(function (aid) {
    if (!cashVisible(aid)) return;
    var hasAny = (dtrCash || []).some(function (t) { return transferInvolvesAccount(t, aid); });
    if (!hasAny) return;
    var b = cashBalance(dtrCash, aid, main);
    if (isFinite(b.main)) { cashBalTotal += b.main; cashBalKnown = true; }
  });
  if (cashBalKnown) { mv += cashBalTotal; mvKnown = true; }
  var debtAccountsForSummary = debtAccountsForScope(st, visibleAccounts || st.accounts || []);
  var debtSummary = currentDebtValuation(debtAccountsForSummary, main, livePrices);
  var grossIncomplete = rows.some(function (p) { return Number(p.qtyHeld) > 0 && p.marketValue === null; });
  var anyContent = rows.length > 0 || cashTrades > 0 || debtSummary.hasDebt;
  rows.forEach(function (p) {
    rz += p.realized;
    if (Math.abs(p.realized || 0) > 1e-9) hasRealized = true;
    if (p.unrealized === null && Math.abs(p.realized || 0) <= 1e-9) {
      if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
      return; // unknown open position: value may count, P&L stays unknown
    }
    pl += p.totalPL;
    if (p.marketValue !== null) { mv += p.marketValue; mvKnown = true; }
    if (p.unrealized !== null) { un += p.unrealized; unKnown = true; }
  });
  if (debtSummary.hasDebt) {
    if (!debtSummary.complete || grossIncomplete) mvKnown = false;
    else { mv -= debtSummary.value; mvKnown = true; }
  }
  var lifetime = 0;
  try { lifetime = summaryLifetimeCost(st, rows, dtradesOpt || convertTrades(st.trades, main), visibleAccounts || []); } catch (e) { lifetime = 0; }
  var plKnown = unKnown || hasRealized;
  var tb = document.getElementById('tb-totals');
  if (tb) {
    var nAccts = (typeof nAcctsOpt === 'number' && isFinite(nAcctsOpt)) ? nAcctsOpt : (st.accounts || []).length;
    tb.textContent = anyContent
      ? (nAccts + (nAccts === 1 ? ' account' : ' accounts') + ' · ' +
        (st.settings.costMethod === 'fifo' ? 'FIFO' : 'Average cost') + ' · in ' + main)
      : '';
  }
  var host = document.getElementById('summary-cards');
  if (!host) return;
  var historyValueKnown = mvKnown;
  rows.forEach(function (position) {
    if (Number(position.qtyHeld) > 0 && position.marketValue === null) historyValueKnown = false;
  });
  updateNetWorthHistory(st, historyValueKnown ? mv : null, main);
  host.innerHTML = '';
  if (!anyContent) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No trades yet — add your first trade.';
    host.appendChild(p);
    return;
  }
  var ret = lifetime > 0 ? ((un + rz) / lifetime) * 100 : null;
  // Unknown aggregates show the loading placeholder while a live fetch is
  // still in flight (never an error); manual-by-design unknowns keep '—'.
  var loadAny = anyPriceLoading();
  [['Value', mvKnown ? fmtMoney(mv, main) : (loadAny ? PRICE_LOADING_TEXT : '—'), mvKnown ? mv : null, (!mvKnown && loadAny)],
   ['Unrealized', unKnown ? fmtMoney(un, main) : (loadAny ? PRICE_LOADING_TEXT : '—'), unKnown ? un : null, (!unKnown && loadAny)],
   ['Realized', fmtMoney(rz, main), rz, false],
   ['Return', ret !== null ? fmtPct(ret) : (loadAny ? PRICE_LOADING_TEXT : '—'), ret, (ret === null && loadAny)]].forEach(function (c) {
    var cardEl = statCard(c[0], c[1], c[2], c[3]);
    if (c[0] !== 'Value') {
      var sc = plClass(c[2]);
      if (sc) cardEl.querySelector('.card-value').classList.add(sc);
    }
    host.appendChild(cardEl);
  });
  var hv = document.getElementById('hero-value');
  var hvn = null;
  try { hvn = document.getElementById('hero-value-num'); } catch (e0) { hvn = null; }
  var hvTarget = hvn || hv;
  if (hvTarget) {
    var heroLoading = !!(anyContent && !mvKnown && anyPriceLoading());
    hvTarget.textContent = anyContent ? (mvKnown ? fmtMoney(mv, main) : (heroLoading ? PRICE_LOADING_TEXT : '—')) : '—';
    paintLoading(hvTarget, heroLoading, 'Total balance');
    // The tap-to-full rule needs the live full string wherever the element
    // re-renders in place: the wiring snapshot never goes stale, the hero
    // never trims its text (fitHeroValue only shrinks the type size), so
    // the popup carries exactly the painted balance.
    var hvTxt = String(hvTarget.textContent || '');
    if (hvTxt !== '' && hvTxt !== '—' && hvTxt !== PRICE_LOADING_TEXT) hvTarget.setAttribute('data-full', hvTxt);
    else hvTarget.removeAttribute('data-full');
  }
  if (hv && (!hvTarget || !hvTarget.classList.contains('is-loading'))) hv.title = hvTarget ? hvTarget.textContent : '';
  // Tap for the full total too: the desktop tooltip is not a popup — phones
  // never see titles. Same overflow-gated door as every other cut value;
  // the wiring is idempotent because the hero is static markup that only
  // re-renders in place. Placeholders never wire.
  if (hvTarget && anyContent && hvTarget.textContent !== '—' && hvTarget.textContent !== PRICE_LOADING_TEXT) {
    wireTruncTap(hvTarget, 'Total balance');
  }
  fitHeroValue();
  // Invested amount: lifetime gross in (every buy + valued income at its
  // locked historical rate) — never reduced by sells, fees or transfers.
  // Sits between value and pill on one small line; truncates, never resizes
  // the box.
  var hi = document.getElementById('hero-invested');
  if (hi) {
    if (!anyContent) {
      hi.textContent = '';
      hi.hidden = true;
    } else {
      var inv = 0;
      try {
        var dtrInv = dtradesOpt || convertTrades(st.trades, main);
        dtrInv.forEach(function (t) {
          if (!t || (t.type !== 'buy' && t.type !== 'income')) return;
          if (t.accountId && cashIdsS[t.accountId]) return; // cash is balance-only
          var q = Number(t.qty);
          if (!isFinite(q) || q <= 0) return;
          var nn = normalizeTrade(t);
          if (isFinite(nn.netMain) && nn.netMain > 0) inv += nn.netMain;
        });
      } catch (e) { inv = 0; }
      hi.hidden = false;
      hi.textContent = 'INVESTED AMOUNT: ' + fmtMoney(inv, main);
    }
  }
  // Spent amount: lifetime fiat out — the cash legs of expense and transfer
  // records, plus crypto fees and crypto expenses
  // valued at the frozen tx-date rate (the same ≈ the cards show; 0 while
  // the rate is unknown, never a guess). Each leg uses its locked
  // historical rate. Never reduced by anything; appreciation can push it
  // above invested. feeMain is never added: the all-in totals include it.
  var hs = document.getElementById('hero-spent');
  if (hs) {
    if (!anyContent) {
      hs.textContent = '';
      hs.hidden = true;
    } else {
      var spent = 0;
      try {
        var dtrSpent = dtradesOpt || convertTrades(st.trades, main);
        var kindsSpent = {};
        try {
          (st.accounts || []).forEach(function (a) {
            if (a && a.ticker) kindsSpent[String(a.ticker).toUpperCase()] = a.kind;
          });
        } catch (e) { kindsSpent = {}; }
        dtrSpent.forEach(function (t) {
          if (!t) return;
          if (t.accountId && cashIdsS[t.accountId]) return; // cash is balance-only
          var sn = normalizeTrade(t);
          if (t.type === 'expense' && isCryptoQtyExpense(t)) {
            var kdExp = kindsSpent[String(t.symbol || '').toUpperCase()];
            spent += expenseSpentMain(t, main, (typeof kdExp === 'string') ? kdExp : undefined);
          } else if (t.type === 'expense' || t.type === 'transfer') {
            if (isFinite(sn.netMain) && sn.netMain > 0) spent += sn.netMain;
            var cq;
            if (t.type === 'transfer') {
              var nfSpent = (t.networkFee === undefined || t.networkFee === null || String(t.networkFee).trim() === '') ? 0 : Number(t.networkFee);
              cq = (isFinite(nfSpent) && nfSpent > 0 ? nfSpent : 0) + transferExternalQtyOf(t);
            } else {
              cq = (t.qty === undefined || t.qty === null || String(t.qty).trim() === '') ? 0 : Number(t.qty);
            }
            if (isFinite(cq) && cq > 0) {
              var sym = String(t.symbol || '').toUpperCase();
              var kd = kindsSpent[sym];
              var kr = null;
              try { kr = resolveExecPrice(t, main, (typeof kd === 'string') ? kd : undefined); } catch (e) { kr = null; }
              if (kr !== null && isFinite(Number(kr.price)) && Number(kr.price) > 0) {
                spent += cq * Number(kr.price);
              }
            }
          }
        });
      } catch (e) { spent = 0; }
      hs.hidden = false;
      hs.textContent = 'SPENT AMOUNT: ' + fmtMoney(spent, main);
    }
  }
  var hp = document.getElementById('hero-pl');
  if (hp) {
    if (!anyContent || !plKnown) {
      hp.textContent = '';
      hp.className = 'hero-pl';
    } else {
      // Arrow carries the direction; show magnitude so signs never glue (▼-€0.14).
      hp.textContent = fmtMoney(Math.abs(pl), main);
      hp.className = 'hero-pl pill ' + plClass(pl);
    }
  }
}
