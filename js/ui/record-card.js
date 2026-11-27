'use strict';
// The record card (tradeBlock) and its lot linkage (FIFO sold / closed blocks).

function tradeBlock(t, main, accountNameById, kind, fifoCtx, swapInfo, viewScopeIds) {
  var n = normalizeTrade(t);
  // The two key numbers per type stay visible on a collapsed phone card
  // (buy: Paid + Amount; sell: Received + Amount sold; transfer: Moved +
  // Received; income: Received + Value; expense: Lost + Fiat lost).
  // Everything else drops down on a tap.
  function primary(row) {
    try { row.classList.add('is-primary'); } catch (e) { /* ignore */ }
    return row;
  }
  // The Converted row only earns its place when there is something to
  // convert: same-fiat views would just print the native number twice.
  var tCcy = String(t.currency || '').toUpperCase();
  var showConverted = tCcy === '' || tCcy !== String(main || '').toUpperCase();
  var box = document.createElement('article');
  box.className = 'trade-block';
  box.setAttribute('data-trade', t.id || '');
  // Apply color if set
  if (t.color && isValidHexColor(t.color)) {
    box.setAttribute('data-colored', '1');
    try {
      box.style.setProperty('--trade-color', String(t.color).trim().toUpperCase());
    } catch (e) { /* ignore */ }
  }
  var head = document.createElement('div');
  head.className = 'trade-head';
  var isSwap = !!(t && typeof t.swapId === 'string' && t.swapId !== '');
  var swap = (isSwap && swapInfo) ? swapInfo[t.swapId] : null;
  if (isSwap) { try { box.classList.add('is-swap'); } catch (e) { /* ignore */ } }
  var meta = isSwap ? tradeTypeMeta('swap') : tradeTypeMeta(t.type);
  var side = document.createElement('span');
  side.className = 'side ' + meta.cls;
  side.textContent = meta.label;
  // Drag handle (dice-grip, like account cards): live on every record at all
  // times — no Select trip needed before reordering. It hangs on the CARD
  // itself as a rail along the left edge (dots ride in the rail's vertical
  // middle; positioning lives in css/records.css), and the drop target decides
  // which records may swap, not any selection. Every account a record
  // appears under shows the grip, including the accounts a multi-source
  // transfer only propagates to.
  var grip = document.createElement('span');
  grip.className = 'drag-handle';
  grip.title = 'Drag to reorder (same date only)';
  grip.setAttribute('aria-hidden', 'true');
  box.appendChild(grip);
  var when = document.createElement('span');
  when.className = 'trade-when muted';
  when.textContent = fmtDateDmy(t.date || '');
  head.appendChild(when);
  // Record ids matter for FIFO lot linkage, so the pill only shows in FIFO
  // mode — Average cards stay clean. On swaps the type/pair pills sit right
  // after the date (DOM order below), with the FIFO id following the pair.
  if (fifoCtx && !isSwap) {
    var rid = document.createElement('span');
    rid.className = 'trade-id';
    rid.textContent = tradeDisplayId(t);
    rid.title = 'Record ' + tradeDisplayId(t);
    head.appendChild(rid);
  }
  head.appendChild(side);
  if (isSwap && swap) {
    var pairTxt = swapPairText(swap);
    if (pairTxt) {
      var pairPill = document.createElement('span');
      pairPill.className = 'trade-pair';
      pairPill.textContent = pairTxt;
      pairPill.title = 'Swapped ' + pairTxt;
      head.appendChild(pairPill);
    }
  }
  if (fifoCtx && isSwap) {
    var ridSwap = document.createElement('span');
    ridSwap.className = 'trade-id';
    ridSwap.textContent = tradeDisplayId(t);
    ridSwap.title = 'Record ' + tradeDisplayId(t);
    head.appendChild(ridSwap);
  }
  // "Now worth" fun-fact pill: qty × live price in the current main, with the
  // P&L percent vs the record's own historic cost. Buys read as held
  // gain/loss; sells read as saved/missed against the proceeds (see
  // tradeNowMeta). Buys and sells only; display-only (never stored, never
  // booked). Hidden while the live price is unknown instead of printing a
  // fictitious loss.
  if (t.type === 'buy' || t.type === 'sell' || (t.type === 'expense' && !isCashKind(kind) && isCryptoQtyExpense(t))) {
    var nowMeta = null;
    try {
      var nwSym = String(t.symbol || '').toUpperCase();
      var lvRaw = (typeof livePrices !== 'undefined' && livePrices) ? livePriceFor(livePrices, nwSym, t.accountId) : null;
      nowMeta = tradeNowMeta(t, main, lvRaw, kind);
    } catch (e) { nowMeta = null; }
    if (nowMeta) {
      var nowPill = document.createElement('span');
      nowPill.className = 'trade-now ' + nowMeta.cls;
      var nowTxt = '';
      try { nowTxt = tradeNowText(nowMeta.now, main, nowMeta.pct, nowMeta.then, t.type !== 'buy'); } catch (e) { nowTxt = ''; }
      nowPill.textContent = nowTxt;
      nowPill.title = nowTxt;
      nowPill.setAttribute('aria-label', nowTxt);
      head.appendChild(nowPill);
    }
  }
  // Duplicate tx ID (js/data/tx-duplicates.js): the pill shows while the
  // warning is on; an ignored group only keeps the quiet Tx-row marker.
  var dupState = null;
  try {
    var dupLegs = (isSwap && swap && swap.sell && swap.buy) ? [swap.sell.id, swap.buy.id] : [t.id];
    dupState = txidDupCardState(dupLegs);
  } catch (e) { dupState = null; }
  if (dupState && dupState.open) {
    head.appendChild(txidDupPill(dupState));
    try { box.classList.add('has-dup-tx'); } catch (e) { /* ignore */ }
  }
  var whatTxt = '';
  if (t.type === 'transfer' && accountNameById) {
    try {
      var fn = accountNameById(t.accountId);
      var outsH = transferOutputsOf(t);
      var selfH = transferSelfQtyOf(t);
      if (outsH.length === 1 && isTransferOutputInternal(outsH[0])) {
        var tn = accountNameById(String(outsH[0].toAccountId).trim());
        if (fn || tn) whatTxt = (fn || '') + ' → ' + (tn || '') + (selfH > 0 ? ' + same account' : '');
      } else if (outsH.length === 1) {
        var lab0 = String(outsH[0].label || '').trim();
        if (fn || lab0) whatTxt = (fn || '') + ' → ' + lab0 + (selfH > 0 ? ' + same account' : '');
      } else if (outsH.length > 1) {
        if (fn) whatTxt = fn + ' → ' + outsH.length + ' recipients' + (selfH > 0 ? ' + same account' : '');
      } else if (t.toAccountId) {
        var tn2 = accountNameById(t.toAccountId);
        if (fn || tn2) whatTxt = (fn || '') + ' → ' + (tn2 || '');
      } else if (fn) {
        whatTxt = fn + ' → same account';
      }
    } catch (e) { /* ignore */ }
  }
  if (whatTxt) {
    var what = document.createElement('span');
    what.className = 'trade-what';
    what.title = whatTxt;
    // Same convention as the other trimmed texts: the title carries the full
    // text for hover, the aria-label names the action.
    what.setAttribute('aria-label', 'Show full transfer details');
    what.setAttribute('data-info-cond', '1');
    what.setAttribute('role', 'button');
    what.setAttribute('tabindex', '0');
    // The route text lives in its own box, with the ⓘ badge right after it
    // inside the same pill: the badge then rides in continuation of the
    // text, and the text gives up room when the badge needs it.
    var whatText = document.createElement('span');
    whatText.className = 'trade-what-text';
    whatText.textContent = whatTxt;
    what.appendChild(whatText);
    // Overflow-gated ⓘ badge: shows only while the text is trimmed. It sits
    // inside the pill, so its tap bubbles up to the pill's own handler.
    var whatDot = document.createElement('span');
    whatDot.className = 'info-dot info-dot-gated';
    whatDot.textContent = 'ⓘ';
    whatDot.setAttribute('aria-hidden', 'true');
    what.appendChild(whatDot);
    function openWhat() {
      // Popup only when the text is actually trimmed by ellipsis — a route
      // that fits has nothing more to show.
      if (!isTrimmed(whatText)) return;
      openNoteDialog(whatTxt, 'Transfer');
    }
    what.addEventListener('click', openWhat);
    what.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openWhat();
      }
    });
    head.appendChild(what);
  }
  // Phone action cluster (▾ ✎ 🗑): the wrapper keeps the three together when
  // they wrap to the next line, so the ▾ can sit immediately left of ✎ without
  // ever leaving a lone trash behind. Desktop ignores the wrapper box
  // (display:contents) and hides the ▾, so its head layout is untouched.
  var actions = document.createElement('span');
  actions.className = 'trade-actions';
  var more = document.createElement('button');
  more.type = 'button';
  more.className = 'quiet trade-more';
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', 'Show all record details');
  more.title = 'Show all details';
  var caret = document.createElement('span');
  caret.className = 'trade-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';
  more.appendChild(caret);
  more.addEventListener('click', function () {
    if (!isMobileView()) return;
    setTradeCardOpen(box, !(box.classList && box.classList.contains('is-open')));
  });
  actions.appendChild(more);
  var edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'quiet trade-edit';
  edit.textContent = '✎';
  edit.setAttribute('data-edit', t.id || '');
  edit.setAttribute('aria-label', 'Edit record ' + String(t.symbol || '') + ' ' + fmtDateDmy(t.date || ''));
  edit.addEventListener('click', function () { openEditTrade(edit.getAttribute('data-edit')); });
  actions.appendChild(edit);
  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'quiet danger trade-del';
  del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
  del.setAttribute('data-del', t.id || '');
  del.setAttribute('aria-label', 'Delete trade ' + String(t.symbol || '') + ' ' + fmtDateDmy(t.date || ''));
  del.addEventListener('click', function () { deleteTrade(del.getAttribute('data-del')); });
  actions.appendChild(del);
  head.appendChild(actions);
  // Selection checkbox (mirrors account selection) — it rides at the end of
  // the head row so the card's own layout stays intact.
  if (tradeSelectionMode) {
    var cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.className = 'card-check';
    cbx.setAttribute('data-select-check', t.id);
    cbx.checked = !!selectedTrades[t.id];
    cbx.setAttribute('aria-label', 'Select ' + String(t.symbol || '') + ' ' + fmtDateDmy(t.date || ''));
    cbx.addEventListener('click', function (e) { if (e && e.stopPropagation) e.stopPropagation(); });
    cbx.addEventListener('change', function () { toggleTradeSelect(t.id); });
    if (cbx.checked) box.classList.add('selected');
    head.appendChild(cbx);
  }
  box.appendChild(head);
  // Phone tap rules for the whole card surface: a collapsed card is one big
  // "show details" button — the first tap always drops the rows down, and the
  // capture phase suppresses an inner popup just for that tap, so expanding is
  // never a coin toss. Once expanded, every value/ⓘ/link keeps its normal
  // behavior and a tap on the head collapses again. ✎/🗑/links work in both
  // states: real controls are never swallowed.
  box.addEventListener('click', function (ev) {
    try {
      if (!isMobileView()) return;
      var tgt = ev ? ev.target : null;
      if (!tgt || !tgt.closest) return;
      // The drag grip is a control, not a tap-to-expand surface.
      if (tgt.closest('.drag-handle')) return;
      if (tgt.closest('button, a, input, select, textarea, label, summary')) return;
      // A trimmed what-pill is a real control: its tap opens the full text,
      // so the card must not swallow it into an expand/collapse toggle.
      var whatHit = tgt.closest('.trade-what');
      if (whatHit) {
        var whatTxtEl = whatHit.querySelector('.trade-what-text');
        if (isTrimmed(whatTxtEl || whatHit)) return;
      }
      // A clipped value is already an explicit tap target. Let its own
      // handler open the full-value dialog even while the card is collapsed;
      // the general card surface must not consume that first tap to expand.
      var valueHit = tgt.closest('.stat-val[data-trunc-wired="1"]');
      if (!valueHit && tgt.closest('.info-dot')) {
        var dotRow = tgt.closest('.stat-row');
        valueHit = dotRow ? dotRow.querySelector('.stat-val[data-trunc-wired="1"]') : null;
      }
      if (valueHit) {
        var fullValue = String(valueHit.getAttribute('data-full') || '');
        var currentValue = String(valueHit.textContent || '');
        var fitCut = valueHit.getAttribute('data-fit-cut') === '1' && fullValue !== '' && fullValue !== currentValue;
        if (isVisuallyCut(valueHit) || fitCut) return;
      }
      if (box.classList.contains('is-open')) {
        if (tgt.closest('.trade-facts, .lot-links')) return;
        setTradeCardOpen(box, false);
        return;
      }
      if (tgt.closest('.stat-row')) {
        ev.stopPropagation();
        if (ev.preventDefault) ev.preventDefault();
      }
      setTradeCardOpen(box, true);
    } catch (e) { /* a failed tap must never break the list */ }
  }, true);
  var isXfer = t.type === 'transfer';
  // Transfer fee valuation: the network fee in fiat at the frozen tx-date
  // rate. Resolved once here and reused by the Transfer fees (≈) and Fee Fiat
  // Rate rows; null (→ '—') when nothing is known, never a guess.
  var xferFee = 0;
  var xferRate = null;
  if (isXfer) {
    var nfRawX = (t.networkFee === undefined || t.networkFee === null) ? '' : String(t.networkFee).trim();
    xferFee = (nfRawX === '') ? 0 : Number(t.networkFee);
    if (!isFinite(xferFee) || xferFee < 0) xferFee = 0;
    try { xferRate = resolveExecPrice(t, main, kind); } catch (e) { xferRate = null; }
  }
  if (t.type === 'transfer') {
    var tSym = String(t.symbol || '').toUpperCase();
    var outsC = transferOutputsOf(t);
    box.appendChild(primary(statRow('Moved', fmtQty(t.qty, tSym) + ' ' + tSym, t.qty, false)));
    var currentScopeIds = Array.isArray(viewScopeIds) ? viewScopeIds : [];
    var currentSourceLegs = transferSourceLegs(t).filter(function (leg) { return currentScopeIds.indexOf(leg.accountId) !== -1; });
    if (transferSourceLegs(t).length > 1 && currentSourceLegs.length) {
      var ownQty = currentSourceLegs.reduce(function (sum, leg) { return sum + leg.qty; }, 0);
      var ownFee = currentSourceLegs.reduce(function (sum, leg) { return sum + leg.fee; }, 0);
      var ownText = fmtQty(ownQty, tSym) + ' ' + tSym;
      if (ownFee > 0) ownText += ' · fee ' + fmtQty(ownFee, tSym) + ' ' + tSym;
      box.appendChild(statRow('From this account', ownText, ownQty, false));
    }
    if (xferFee > 0) {
      var feeTxtT = fmtQty(t.networkFee, tSym) + ' ' + tSym;
      if (xferRate !== null) feeTxtT += ' (≈ ' + fmtMoney(xferFee * xferRate.price, xferRate.ccy) + ')';
      // skipPopup: we wire the value for truncation popup (show full fee),
      // and the label gets an ⓘ that opens the fee explainer — two different popups.
      var feeRowT = statRow('Transfer fees', feeTxtT, t.networkFee, false, true);
      var feeValT = feeRowT.querySelector('.stat-val');
      var feeLabT = feeRowT.querySelector('.stat-label');
      if (feeValT) {
        // Value tap → show full fee text (truncation popup), no label ⓘ.
        wireTruncTap(feeValT, 'Transfer fees');
        // Label ⓘ → fee explainer (market worth vs booked cost).
        (function (tr, mn, fq, rt) {
          function open() { try { openFeeExplainer(tr, mn, fq, rt); } catch (e) { /* ignore */ } }
          infoDot(feeLabT, open);
        })(t, main, xferFee, xferRate);
      }
      box.appendChild(feeRowT);
      // Fee in fiat rate sits right after Transfer fees — it is the rate behind
      // the (≈) above, frozen at the tx date. Unknown: tap retries the
      // lookup on demand instead of waiting for the backoff.
      var feeRateTxt = (xferRate !== null)
        ? fmtMoney(xferRate.price, xferRate.ccy) + ' / ' + tSym
        : '—';
      var feeRateEl = rateRow('Fee in fiat rate', feeRateTxt);
      if (xferRate === null) {
        feeRateEl.title = feeRateWhy(t, kind);
        (function (el, id) {
          el.addEventListener('click', function () {
            try { retryFeeRate(id); } catch (e) { /* ignore */ }
          });
        })(feeRateEl, t.id);
      }
      box.appendChild(feeRateEl);
    }
    // One Received row for every arrival: the inline line trims with …
    // (capped like Note/Rate so a long recipient list can never push the
    // strip — or the card — off-screen) and the ⓘ/tap opens the full list.
    var recLines = [];
    var recTotal = 0;
    if (!outsC.length) {
      var netQ = Number(t.qty) - xferFee;
      recLines.push(fmtQty(netQ, tSym) + ' ' + tSym);
      recTotal = (isFinite(netQ) && netQ > 0) ? netQ : 0;
    } else {
      outsC.forEach(function (o) {
        if (isTransferOutputInternal(o)) {
          var nm = String(o.toAccountId).trim();
          try { if (accountNameById) nm = accountNameById(String(o.toAccountId).trim()) || nm; } catch (e) { /* ignore */ }
          var arr = transferRowArrival(o, t.symbol);
          var arrSym = (o.toSymbol === undefined || o.toSymbol === null || String(o.toSymbol).trim() === '')
            ? tSym : String(o.toSymbol).trim().toUpperCase();
          var txt = fmtQty(arr, arrSym) + ' ' + arrSym + ' → ' + nm;
          var oFee = (o.fee !== undefined && o.fee !== null && String(o.fee).trim() !== '') ? Number(o.fee) : 0;
          if (isFinite(oFee) && oFee > 0) txt += ' · fee ' + fmtQty(o.fee, tSym);
          recLines.push(txt);
          if (isFinite(arr) && arr > 0) recTotal += arr;
        } else {
          var arr2 = Number(o.qty);
          var lab = String(o.label || '').trim();
          recLines.push(fmtQty(arr2, tSym) + ' ' + tSym + ' → ' + lab + ' (external)');
          if (isFinite(arr2) && arr2 > 0) recTotal += arr2;
        }
      });
      var selfC = transferSelfQtyOf(t);
      if (selfC > 0) {
        recLines.push(fmtQty(selfC, tSym) + ' ' + tSym + ' → same account (received back)');
        recTotal += selfC;
      }
    }
    var recRow = primary(statRow('Received', recLines.join(', '), recTotal, false, true));
    (function (row, lines) {
      var recVal = row.querySelector('.stat-val');
      var recLab = row.querySelector('.stat-label');
      function openRecips() {
        // Popup only when the text actually overflows the row.
        if (!recVal || !isVisuallyCut(recVal)) return;
        openNoteDialog(lines.join('\n'), 'Received');
      }
      if (recVal) {
        recVal.setAttribute('role', 'button');
        recVal.setAttribute('tabindex', '0');
        recVal.setAttribute('aria-label', 'Show all recipients');
        recVal.addEventListener('click', openRecips);
        recVal.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openRecips();
          }
        });
      }
      if (recLab) infoDot(recLab, openRecips, recVal);
    })(recRow, recLines);
    box.appendChild(recRow);
    if ((Number(t.total) > 0 || Number(t.fee) > 0)) {
      box.appendChild(statRow('Fiat cost', fmtMoney(n.netMain, main), n.netMain, false));
    }
  } else if (t.type === 'income') {
    box.appendChild(primary(statRow('Received', fmtQty(t.qty, t.symbol) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false)));
    if (Number(t.total) > 0) {
      box.appendChild(primary(statRow('Value', fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false)));
      if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    } else {
      box.appendChild(primary(statRow('Value', '— (free)', null, false)));
    }
  } else if (t.type === 'expense') {
    if (t.qty !== undefined && t.qty !== null && String(t.qty).trim() !== '') {
      box.appendChild(primary(statRow('Lost', fmtQty(t.qty, t.symbol) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false)));
    }
    if (!isCashKind(kind) && isCryptoQtyExpense(t)) {
      // Paid in the account asset: the fiat side is never typed. It is what
      // the quantity was worth on the spend date, derived from that day's
      // quote ("—" while no quote is known — never 0, never a guess).
      var spendFiat = null;
      try { spendFiat = expenseFiatValueMain(t, main, kind); } catch (e) { spendFiat = null; }
      box.appendChild(primary(statRow('Fiat value', spendFiat !== null ? fmtMoney(spendFiat, main) : '—', spendFiat, false)));
    } else if (t.total !== undefined && t.total !== null && String(t.total).trim() !== '' && Number(t.total) > 0) {
      box.appendChild(primary(statRow('Fiat lost', fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false)));
      if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    }
  } else {
    // The verb follows the side: buys pay fiat out, sells receive it — a
    // sale must never read like a purchase.
    var fiatVerb = (t.type === 'sell') ? 'Received' : 'Paid';
    box.appendChild(primary(statRow(fiatVerb, fmtMoney(t.total, String(t.currency || '').toUpperCase()), t.total, false)));
    if (showConverted) box.appendChild(statRow('Converted', fmtMoney(n.netMain, main), n.netMain, false));
    // Real price is calculated, never quoted: the FULL all-in total converted
    // at the historical FX rate (or manual rate), divided by qty received —
    // e.g. 50 EUR / 0.00058193 BTC = 85920.99. Shown rounded half-up to 2
    // decimals; the books run on this exact value (== Average entry). Exec is
    // the reference-only market quote resolved by resolveExecPrice(); it never
    // touches P&L; "—" only when nothing is known (never 0, never a guess).
    var pq = Number(t.qty);
    if (isFinite(pq) && pq > 0 && n.netMain > 0) {
      var symU = String(t.symbol || '').toUpperCase();
      var realP = n.netMain / pq;
      var ex = null;
      try { ex = resolveExecPrice(t, main, kind); } catch (e) { ex = null; }
      if (ex !== null) {
        box.appendChild(statRow('Exec. price', fmtMoney(ex.price, ex.ccy) + ' / ' + symU, ex.price, false));
      } else {
        box.appendChild(statRow('Exec. price', '—', null, false));
      }
      box.appendChild(statRow('Real price', fmtMoney(realP, main) + ' / ' + symU, realP, false));
    }
  }
  // Same-asset moves have no FX: the meaningless '1:1 @ 1' Rate is gone for
  // transfers (Fee in fiat rate lives next to Transfer fees instead), and the
  // fiat Fee row is gone too — the network fee IS the fee.
  // A crypto expense has no fiat input, so there is no fx rate to show.
  if (!isXfer && !(t.type === 'expense' && !isCashKind(kind) && isCryptoQtyExpense(t))) {
    box.appendChild(rateRow('Rate', fxBadgeText(t)));
  }
  if (!isXfer) {
  var feeRow = statRow('Fee', fmtFeeAmount(t), t.fee, false);
  box.appendChild(feeRow);
  }
  var noteTxt = isSwap ? swapNoteClean(t.note) : String(t.note || '');
  if (noteTxt) {
    var noteRow = statRow('Note', noteTxt, null, false, true);
    var noteVal = noteRow.querySelector('.stat-val');
    if (noteVal) {
      noteVal.classList.add('note-clamp');
      noteVal.setAttribute('role', 'button');
      noteVal.setAttribute('tabindex', '0');
      noteVal.setAttribute('aria-label', 'Show full note');
      noteVal.title = noteTxt;
      (function (val, txt) {
        function open() {
          // Popup only when the text actually overflows the row.
          if (!isVisuallyCut(val)) return;
          openNoteDialog(txt);
        }
        val.addEventListener('click', open);
        val.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        });
        infoDot(noteRow.querySelector('.stat-label'), open, val);
      })(noteVal, noteTxt);
    }
    box.appendChild(noteRow);
  }
  if (t.ledger && String(t.ledger).trim() !== '') {
    var ledTxt = String(t.ledger).trim();
    if (t.ledgerLabel && String(t.ledgerLabel).trim() !== '') ledTxt += ' · ' + String(t.ledgerLabel).trim();
    box.appendChild(statRow('Ledger', ledTxt, null, false));
  }
  // Transaction IDs. A swap is one record with one hash per side: the sent
  // leg's and the received leg's. Both show on either account's card, each
  // with its own asset's rules. Older swaps mirrored a single hash on both
  // legs: that shows once as a plain Tx. Everything else shows its own hash.
  var txEntries = [];
  (function () {
    function validId(v) { return !!(v && isValidTxid(v) && String(v).trim() !== ''); }
    if (isSwap && swap && swap.sell && swap.buy) {
      var sId = validId(swap.sell.txid) ? String(swap.sell.txid).trim() : '';
      var rId = validId(swap.buy.txid) ? String(swap.buy.txid).trim() : '';
      if (sId !== '' && sId === rId) txEntries.push({ label: 'Tx', id: sId, sym: t.symbol, legs: [swap.sell.id, swap.buy.id] });
      else {
        if (sId !== '') txEntries.push({ label: 'Sent Tx', id: sId, sym: swap.sell.symbol, legs: [swap.sell.id] });
        if (rId !== '') txEntries.push({ label: 'Received Tx', id: rId, sym: swap.buy.symbol, legs: [swap.buy.id] });
      }
    } else if (validId(t.txid)) {
      txEntries.push({ label: 'Tx', id: String(t.txid).trim(), sym: t.symbol, legs: [t.id] });
    }
  })();
  txEntries.forEach(function (te) {
    var txFull = te.id;
    var txRow = document.createElement('div');
    txRow.className = 'stat-row tx-row';
    txRow.setAttribute('data-label', te.label);
    var txL = document.createElement('span');
    txL.className = 'stat-label';
    txL.textContent = te.label;
    var txV = document.createElement('span');
    txV.className = 'stat-val num';
    // mempool.space only resolves Bitcoin hashes: other assets would get a
    // dead link, so they show the same shortened id as plain text. BTC keeps
    // the explorer link; every asset gets a copy button carrying the raw
    // hash (not the browser URL).
    if (String(te.sym || '').trim().toUpperCase() === 'BTC') {
      var txA = document.createElement('a');
      txA.className = 'tx-link';
      txA.href = txExplorerUrl(txFull);
      txA.target = '_blank';
      txA.rel = 'noopener';
      txA.textContent = shortTxid(txFull);
      txA.title = txFull;
      txV.appendChild(txA);
    } else {
      var txS = document.createElement('span');
      txS.textContent = shortTxid(txFull);
      txS.title = txFull;
      txV.appendChild(txS);
    }
    txV.appendChild(txCopyButton(txFull));
    var rowDup = null;
    try { rowDup = dupState ? txidDupCardState(te.legs || []) : null; } catch (e) { rowDup = null; }
    if (rowDup) txV.appendChild(txidDupRowMark(rowDup));
    txRow.appendChild(txL);
    txRow.appendChild(txV);
    box.appendChild(txRow);
  });
  if (t.attachment && isValidAttachment(t.attachment)) {
    (function (meta) {
      var atRow = document.createElement('div');
      atRow.className = 'stat-row';
      atRow.setAttribute('data-label', 'Invoice / Receipt');
      var atL = document.createElement('span');
      atL.className = 'stat-label';
      atL.textContent = 'Invoice / Receipt';
      var atV = document.createElement('span');
      atV.className = 'stat-val num';
      var atA = document.createElement('a');
      atA.className = 'tx-link';
      atA.href = '#';
      var atName = safeDisplayName(meta.name);
      atA.textContent = atName.length > 24 ? atName.slice(0, 23) + '…' : atName;
      atA.title = atName + ' (' + String(meta.mime) + ') — click to preview';
      atA.addEventListener('click', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        try { openAttachmentPreview(meta); } catch (e) { showBanner('Could not open the file on this device.'); }
      });
      atV.appendChild(atA);
      atRow.appendChild(atL);
      atRow.appendChild(atV);
      box.appendChild(atRow);
    })(t.attachment);
  }
  if (t.type === 'buy' || t.type === 'sell') {
    // Quantity row follows the side too: bought = Amount, sold = Amount sold.
    var qtyVerb = (t.type === 'sell') ? 'Amount sold' : 'Amount';
    box.appendChild(primary(statRow(qtyVerb, fmtQty(t.qty, t.symbol) + ' ' + String(t.symbol || '').toUpperCase(), t.qty, false)));
  }
  // One true facts line: gather every fact row into a non-wrapping strip so
  // nothing ever spills to a second row — long values trim with … instead
  // (Rate/Note are capped; the popup still opens the full text on click).
  var facts = document.createElement('div');
  facts.className = 'trade-facts';
  Array.prototype.forEach.call(box.querySelectorAll(':scope > .stat-row'), function (r) { facts.appendChild(r); });
  var divider = document.createElement('div');
  divider.className = 'trade-divider';
  divider.setAttribute('aria-hidden', 'true');
  box.appendChild(divider);
  box.appendChild(facts);
  // A card opened before a re-render opens again in the fresh DOM (after the
  // strip exists, so the caret and the ⓘ gate pick up the open state).
  if (t.id && openTradeCards[String(t.id)]) setTradeCardOpen(box, true);
  // FIFO lot linkage: slices of this record closed elsewhere (buys/income)
  // or slices closed by this record (sells). Average pools cost, so there is
  // nothing truthful to link — fifoCtx is null outside FIFO mode.
  if (fifoCtx && t && typeof t.id === 'string' && t.id !== '') {
    if (t.type === 'buy' || t.type === 'income') {
      var buySlices = (fifoCtx.links.byBuy[t.id] || []);
      if (buySlices.length) box.appendChild(soldBlock(t, buySlices, fifoCtx));
    } else if (t.type === 'sell') {
      var closeSlices = (fifoCtx.links.byClose[t.id] || []);
      if (closeSlices.length) box.appendChild(closedBlock(t, closeSlices, fifoCtx));
    }
  }
  return box;
}

// Group closed FIFO lots by opening / closing trade id. Lots without an id
// on the relevant side (legacy id-less trades) keep their math but opt out
// of per-record linkage.
function fifoLinksFor(lots) {
  var byBuy = {};
  var byClose = {};
  (lots || []).forEach(function (l) {
    if (!l) return;
    if (l.buyId) (byBuy[l.buyId] = byBuy[l.buyId] || []).push(l);
    if (l.sellId) (byClose[l.sellId] = byClose[l.sellId] || []).push(l);
  });
  return { byBuy: byBuy, byClose: byClose };
}

function lotKindOf(l) {
  if (l && l.kind === 'expense') return 'expense';
  if (l && l.kind === 'network-fee') return 'network-fee';
  return 'sell';
}

// Human reference to a linked record: code + date + type. Falls back to the
// lot's own dates when the trade itself is out of view (another page) or
// gone — the code still identifies it.
function lotRefText(other, otherId, fallbackDate) {
  var code = tradeDisplayId(other && other.id ? other : otherId);
  var date = (other && other.date) || fallbackDate || '';
  var type = (other && other.type) ? String(other.type).toLowerCase() : 'record';
  return code + ' · ' + fmtDateDmy(date) + ' ' + type;
}

function lotLink(l, targetId, fallbackDate, ctx, sym, verb) {
  var ref = (targetId && ctx.byId[targetId]) || null;
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'lot-link';
  if (targetId) b.setAttribute('data-goto', targetId);
  var code = tradeDisplayId(ref && ref.id ? ref : targetId);
  b.setAttribute('aria-label', 'Show linked record ' + code);
  b.title = 'Show linked record ' + code;
  // Ellipsis lives on an inner block span: text-overflow directly on a
  // <button> paints the ellipsis over the text (sliced/duplicated glyphs)
  // instead of clipping it in some browsers.
  var span = document.createElement('span');
  span.className = 'lot-link-text';
  span.textContent = fmtQty(l.qty, sym) + ' ' + sym + ' ' + verb + ' ' + lotRefText(ref, targetId, fallbackDate) +
    ' (' + fmtMoney(l.gain, ctx.main) + ')';
  b.appendChild(span);
  b.addEventListener('click', function () { ctx.go(targetId); });
  return b;
}

// Buy/income card: which later records consumed this buy, and whether it is
// fully closed. Fee/expense slices get their own verbs so partial states
// always reconcile with the engine.
function soldBlock(t, slices, ctx) {
  var sym = String(t.symbol || '').toUpperCase();
  var bought = Number(t.qty);
  var closed = 0;
  var hasSell = false;
  var i;
  for (i = 0; i < slices.length; i++) {
    closed += Number(slices[i].qty) || 0;
    if (lotKindOf(slices[i]) === 'sell') hasSell = true;
  }
  var full = isFinite(bought) && bought > 0 && closed >= bought - 1e-9;
  var scope = (isFinite(bought) && bought > 0)
    ? fmtQty(closed, sym) + ' of ' + fmtQty(bought, sym) + ' ' + sym
    : fmtQty(closed, sym) + ' ' + sym;
  var wrap = document.createElement('div');
  wrap.className = 'lot-links';
  wrap.setAttribute('data-lot-links', 'sold');
  var head = document.createElement('div');
  head.className = 'lot-links-head';
  head.textContent = hasSell
    ? (full ? 'Sold · in full' : 'Sold · partially (' + scope + ')')
    : (full ? 'Consumed · in full' : 'Consumed · partially (' + scope + ')');
  wrap.appendChild(head);
  // More than five lines scroll inside the list: plain block layout, whole
  // pixels and an isolated layer keep text rasterization stable where fancier
  // containers tore glyphs.
  var list = document.createElement('div');
  list.className = 'lot-link-list';
  wrap.appendChild(list);
  slices.forEach(function (l) {
    var kind = lotKindOf(l);
    var verb = kind === 'sell' ? 'sold in' : (kind === 'expense' ? 'lost to expense in' : 'fee in');
    list.appendChild(lotLink(l, l.sellId, l.closeDate, ctx, sym, verb));
  });
  return wrap;
}

// Sell card: which earlier buys this sale ate, oldest first.
function closedBlock(t, slices, ctx) {
  var sym = String(t.symbol || '').toUpperCase();
  var wrap = document.createElement('div');
  wrap.className = 'lot-links';
  wrap.setAttribute('data-lot-links', 'closed');
  var head = document.createElement('div');
  head.className = 'lot-links-head';
  head.textContent = 'Closed from';
  wrap.appendChild(head);
  // Same five-line cap as the Sold block (see soldBlock).
  var list = document.createElement('div');
  list.className = 'lot-link-list';
  wrap.appendChild(list);
  slices.forEach(function (l) {
    var ref = (l.buyId && ctx.byId[l.buyId]) || null;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'lot-link';
    if (l.buyId) b.setAttribute('data-goto', l.buyId);
    var code = tradeDisplayId(ref && ref.id ? ref : l.buyId);
    b.setAttribute('aria-label', 'Show linked record ' + code);
    b.title = 'Show linked record ' + code;
    // Inner span carries the ellipsis (see lotLink).
    var span = document.createElement('span');
    span.className = 'lot-link-text';
    span.textContent = fmtQty(l.qty, sym) + ' ' + sym + ' ← ' + lotRefText(ref, l.buyId, l.openDate) +
      ' (' + fmtMoney(l.gain, ctx.main) + ')';
    b.appendChild(span);
    (function (id) {
      b.addEventListener('click', function () { ctx.go(id); });
    })(l.buyId);
    list.appendChild(b);
  });
  return wrap;
}

function detailMetaRow(label, text, title) {
  var d = document.createElement('div');
  d.className = 'detail-meta';
  d.setAttribute('data-label', label);
  // Account labels stack: caption on top, wrapped text underneath.
  if (String(label) === 'Label') d.classList.add('detail-meta-stacked');
  var l = document.createElement('span');
  l.className = 'detail-meta-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'detail-meta-val';
  // Account labels are multi-line by design: wrap them fully instead of
  // trimming to one line. Notes keep the trim + popup treatment.
  if (String(label) === 'Label') v.classList.add('detail-meta-multiline');
  v.textContent = String(text);
  v.title = String(text);
  v.setAttribute('role', 'button');
  v.setAttribute('tabindex', '0');
  v.setAttribute('aria-label', 'Show full ' + String(title).toLowerCase());
  function open() {
    if (!isVisuallyCut(v)) return;
    openNoteDialog(text, title);
  }
  v.addEventListener('click', open);
  v.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  // Wrapped rows (multi-line labels) show everything: no hidden info, no dot.
  if (!v.classList.contains('detail-meta-multiline')) infoDot(l, open, v);
  d.appendChild(l);
  d.appendChild(v);
  return d;
}
