'use strict';
// Building blocks of the record card: fact rows, type labels, swap pairing,
// current value, note / attachment / fee dialogs.

// --- Stacked facts (minimalist detail layout) ---
// One fact per row: muted label left, tabular value right. Values carry
// data-label and data-value when known; P&L figures
// tint gain/loss. The FX conversion always gets its own line so amounts
// never run into their provenance.

function statRow(label, text, raw, tint, skipPopup) {
  var d = document.createElement('div');
  d.className = 'stat-row';
  d.setAttribute('data-label', label);
  var l = document.createElement('span');
  l.className = 'stat-label';
  l.textContent = label;
  var v = document.createElement('span');
  v.className = 'stat-val num';
  v.textContent = text;
  if (raw !== null && raw !== undefined && isFinite(Number(raw))) {
    d.setAttribute('data-value', String(Number(raw)));
    if (tint) {
      var sc = plClass(raw);
      if (sc) v.classList.add(sc);
    }
  }
  // Every value here trims with CSS ellipsis, so a plain number can hide
  // digits (long XMR/BTC quantities, deep ledger lines) with no way to read
  // them. Rows that wire a richer popup themselves pass skipPopup (Transfer
  // fees opens an explainer, multi-recipient Received lists one per line,
  // Note clamps its own way); all others get the standard overflow-gated
  // 'show full value' popup: ⓘ on the label while cut, tap anywhere opens.
  var rowTxt = String(text === undefined || text === null ? '' : text);
  if (!skipPopup && rowTxt.trim() !== '' && rowTxt.trim() !== '—') {
    wireTruncTap(v, label, l);
  }
  d.appendChild(l);
  d.appendChild(v);
  return d;
}

function fmtFeeAmount(t) {
  var f = Number(t.fee);
  if (!(isFinite(f) && f > 0)) return '—';
  // One fiat per trade: the fee is always denominated in the trade currency.
  var code = String(t.currency || '').toUpperCase();
  var fiatCodes = ['EUR', 'USD', 'GBP', 'CHF', 'RON', 'USDC', 'USDT', 'DAI', 'JPY', 'CAD', 'AUD'];
  if (fiatCodes.indexOf(code) !== -1 || /^[A-Z]{3}$/.test(code)) {
    // fiat-like: money; crypto-like fee (BTC/ETH) would be caught below? Keep money for 3-letter fiat, qty otherwise.
    if (['EUR', 'USD', 'GBP', 'CHF', 'RON', 'JPY', 'CAD', 'AUD'].indexOf(code) !== -1) {
      try { return moneyFmt(code).format(f); } catch (e) { return fmtQty(f, code) + ' ' + code; }
    }
  }
  return fmtQty(f, code) + ' ' + code;
}

function tradeTypeMeta(type) {
  if (type === 'swap') return { label: 'Swap', cls: 'side-swap' };
  if (type === 'sell') return { label: 'Sell', cls: 'side-sell' };
  if (type === 'transfer') return { label: 'Transfer', cls: 'side-transfer' };
  if (type === 'income') return { label: 'Income', cls: 'side-income' };
  if (type === 'expense') return { label: 'Expense', cls: 'side-expense' };
  return { label: 'Buy', cls: 'side-buy' };
}

// The type a record presents as in the UI. Swap legs keep their real
// buy/sell `type` for all ledger math; only the visible list/filter says
// Swap. Empty string for unknown shapes.
function tradeUiType(t) {
  if (t && typeof t.swapId === 'string' && t.swapId !== '') return 'swap';
  var k = String((t && t.type) || '').toLowerCase();
  return TRADE_TYPES.indexOf(k) !== -1 ? k : '';
}

// Group linked swap legs once per paint: swapId -> { sell, buy, … }.
// Presentation only; the stored shape stays two ordinary buy/sell records.
function buildSwapPairMap(trades) {
  var out = {};
  (trades || []).forEach(function (t) {
    if (!t || typeof t.swapId !== 'string' || t.swapId === '') return;
    var g = out[t.swapId];
    if (!g) g = out[t.swapId] = { swapId: t.swapId, sell: null, buy: null, legs: [] };
    g.legs.push(t);
    if (t.type === 'sell' && !g.sell) g.sell = t;
    else if (t.type === 'buy' && !g.buy) g.buy = t;
  });
  Object.keys(out).forEach(function (sid) {
    var g = out[sid];
    var fromLeg = g.sell || g.legs[0] || null;
    var toLeg = g.buy || g.legs[1] || null;
    g.fromSymbol = fromLeg ? String(fromLeg.symbol || '').toUpperCase() : '';
    g.toSymbol = toLeg ? String(toLeg.symbol || '').toUpperCase() : '';
    g.fromAccountId = fromLeg ? fromLeg.accountId : '';
    g.toAccountId = toLeg ? toLeg.accountId : '';
  });
  return out;
}

function swapPairText(info) {
  if (!info || !info.fromSymbol || !info.toSymbol) return '';
  return info.fromSymbol + ' → ' + info.toSymbol;
}

// Older swaps appended " [swap]" to the user's note. The Swap pill already
// says it: show the note without the machine suffix, and stop writing it.
function swapNoteClean(note) {
  return String(note === undefined || note === null ? '' : note).replace(/(?:\s*\[swap\])+\s*$/i, '').trim();
}

// Find the linked sell+buy legs for a stored swap record. Null for normal
// records or orphaned/corrupt swap data (callers fall back to single-leg
// editing so nothing becomes uneditable).
function swapPairForTrade(st, tr) {
  if (!tr || typeof tr.swapId !== 'string' || tr.swapId === '') return null;
  var legs = [];
  ((st && st.trades) || []).forEach(function (t) {
    if (t && typeof t.swapId === 'string' && t.swapId === tr.swapId) legs.push(t);
  });
  if (legs.length < 2) return null;
  var sell = null;
  var buy = null;
  legs.forEach(function (t) {
    if (t.type === 'sell' && !sell) sell = t;
    else if (t.type === 'buy' && !buy) buy = t;
  });
  if (!sell || !buy) return null;
  return { swapId: tr.swapId, sell: sell, buy: buy, legs: legs };
}

// "Now worth" fun-fact pill (display-only): what this record's qty would be
// worth today at the live price in the current main fiat — for a buy, the
// position it opened; for a sell, what the sold qty left behind. Pure math,
// never stored, never read by the ledger — P&L/tax cannot see it. Unknown
// live prices stay null (never 0: that would fabricate a -100% loss).
function tradeNowValue(qty, livePrice) {
  var q = Number(qty);
  var p = Number(livePrice);
  if (!isFinite(q) || q <= 0 || !isFinite(p) || p <= 0) return null;
  return q * p;
}

// Standard P&L percent: (now - then) / then * 100. Null when there is no
// cost basis to compare against (then <= 0) — the pill then shows money only.
function tradeNowPct(thenMain, nowMain) {
  var a = Number(thenMain);
  var b = Number(nowMain);
  if (!isFinite(a) || a <= 0 || !isFinite(b) || b < 0) return null;
  return ((b - a) / a) * 100;
}

// Resolve the pill model for one buy/sell record, or null when no pill
// should render (other types, bad qty, unknown live price). `t` is the
// display (converted) trade so `then` already sits in the current main.
// Buys read as a held position: price up = gain. Sells are the mirror — the
// asset is gone, so a price ABOVE the proceeds is a miss (loss colour) and
// a price below is a save (gain colour); `pct` carries that same mirror
// sign (negated buy percent) so the number never contradicts the colour.
// `then` stays the full proceeds (fee inside), like everywhere else.
function tradeNowMeta(t, main, livePrice, kind) {
  var isExp = !!(t && t.type === 'expense' && isCryptoQtyExpense(t));
  if (!t || (t.type !== 'buy' && t.type !== 'sell' && !isExp)) return null;
  // An expense reads like a sell: the asset is gone, so today's worth above
  // what it was worth when spent is a miss, below it a save.
  var isSell = t.type !== 'buy';
  var q = Number(t.qty);
  if (!isFinite(q) || q <= 0) return null;
  var now = tradeNowValue(q, livePrice);
  if (now === null) return null;
  var then = null;
  if (isExp) {
    // Spend-date fiat value (derived from the quote of that day); unknown
    // quote means no pill rather than a made-up comparison.
    then = expenseFiatValueMain(t, main, kind);
    if (then === null) return null;
  } else {
    try { then = normalizeTrade(t).netMain; } catch (e) { then = null; }
  }
  then = Number(then);
  if (!isFinite(then) || then < 0) return null;
  var rawPct = tradeNowPct(then, now);
  // Null stays null — negating it would collapse to 0 and paint a pct.
  var pct = (rawPct === null) ? null : (isSell ? -rawPct : rawPct);
  // Signed "came out ahead?" amount in the record's own frame.
  var ahead = isSell ? (then - now) : (now - then);
  var cls = 'trade-now-flat';
  // Cent-level epsilon: sub-cent drift (FX rounding) reads as flat.
  if (then <= 0) {
    // No basis: a free buy is all gain, a give-away sell all miss.
    cls = isSell ? 'trade-now-loss' : (now > 0 ? 'trade-now-gain' : 'trade-now-flat');
  } else if (ahead > 0.005) {
    cls = 'trade-now-gain';
  } else if (-ahead > 0.005) {
    cls = 'trade-now-loss';
  }
  return { now: now, then: then, pct: pct, cls: cls };
}

// Pill text. Buys keep the long-standing shape: signed change first (delta
// vs the record's own cost), then the labelled current value with its
// percent, e.g. "+€5.49 | Current €7.49 +200%". The sign carries the
// direction, so no increase/decrease word, and the current value meets the
// percent with a plain space (no · in this pill).
// Sells speak from today instead (5th argument true): "Saved €1.00 · Now
// €1.00 +50%" when the price fell since the sale, "Missed €4.00 · Now
// €6.00 -200%" when it rose — the amount is what the sold qty is worth
// beyond/below the proceeds. Flat reads "Now €N" only; with no basis to
// compare the miss is still stated (proceeds of 0 settle the direction).
// The ▲/▼ arrow rides CSS ::before (like .pill.gain/.pill.loss), so the
// text carries no arrow.
function tradeNowText(now, main, pct, then, sell) {
  var p = Number(pct);
  var hasPct = !(pct === null || pct === undefined) && isFinite(p);
  if (sell) {
    var curS = 'Now ' + fmtMoney(now, main);
    var ahead = Number(then) - Number(now);
    if (Math.abs(ahead) < 0.005) return curS;
    var pctTxt = (hasPct && Math.abs(p) >= 0.005) ? ' ' + ((p > 0 ? '+' : '') + fmtPct(p)) : '';
    return (ahead > 0 ? 'Saved ' : 'Missed ') + fmtMoney(Math.abs(ahead), main) + ' · ' + curS + pctTxt;
  }
  var cur = 'Current ' + fmtMoney(now, main);
  if (!hasPct) return cur;
  if (Math.abs(p) < 0.005) return cur;
  var delta = Number(now) - Number(then);
  var signedDelta = (delta > 0 ? '+' : '') + fmtMoney(delta, main);
  var signedPct = (p > 0 ? '+' : '') + fmtPct(p);
  return signedDelta + ' | ' + cur + ' ' + signedPct;
}

function openNoteDialog(text, title) {
  var p = document.getElementById('note-dialog-text');
  if (p) p.textContent = String(text === undefined || text === null ? '' : text);
  var h = document.getElementById('note-dialog-title');
  if (h) h.textContent = title || 'Note';
  openDialog('note-dialog');
}

// Invoice / receipt preview: inline for images + PDFs, with a download
// button. Builds its dialog once. When the blob is missing locally and
// sync holds a passphrase, it lazy-fetches the encrypted copy first;
// otherwise it says plainly where the file lives instead of doing nothing.
function openAttachmentPreview(meta) {
  if (!meta || !isValidAttachment(meta)) return;
  var dlg = document.getElementById('attach-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'attach-dialog';
    dlg.setAttribute('aria-labelledby', 'attach-dialog-title');
    dlg.innerHTML =
      '<div class="dialog-head"><h2 id="attach-dialog-title">Invoice / Receipt</h2>' +
      '<button type="button" data-close aria-label="Close dialog">✕</button></div>' +
      '<p id="attach-dialog-name" class="muted"></p>' +
      '<div id="attach-dialog-view"></div>' +
      '<p id="attach-dialog-msg" class="muted" hidden></p>' +
      '<div class="dialog-actions"><button type="button" id="attach-dialog-dl" class="primary" hidden>Download</button> ' +
      '<button type="button" data-close>Close</button></div>';
    document.body.appendChild(dlg);
    // Same wiring as every other dialog: backdrop clicks close via
    // [data-close], Esc restores focus and recomputes the background
    // freeze — without this the page scrolls under the preview (and the
    // lock could stick the other way if Esc bypassed the recount).
    try { wireDialog('attach-dialog'); } catch (e) { /* ignore */ }
    dlg.addEventListener('close', function () {
      try {
        var old = dlg.getAttribute('data-objurl');
        if (old) { (window.URL || window.webkitURL).revokeObjectURL(old); dlg.removeAttribute('data-objurl'); }
        var v = document.getElementById('attach-dialog-view'); if (v) v.innerHTML = '';
      } catch (e) { /* ignore */ }
    });
  }
  var nameEl = document.getElementById('attach-dialog-name');
  var viewEl = document.getElementById('attach-dialog-view');
  var msgEl = document.getElementById('attach-dialog-msg');
  var dlEl = document.getElementById('attach-dialog-dl');
  if (nameEl) nameEl.textContent = safeDisplayName(meta.name);
  if (msgEl) { msgEl.hidden = true; msgEl.textContent = ''; }
  if (viewEl) viewEl.innerHTML = '';
  if (dlEl) { dlEl.hidden = true; dlEl.onclick = null; }
  function showBlob(blob, label) {
    try {
      var urls = window.URL || window.webkitURL;
      var url = urls.createObjectURL(blob);
      dlg.setAttribute('data-objurl', url);
      var fname = safeDisplayName((label && label.name) || meta.name) || 'attachment';
      if (dlEl) {
        dlEl.hidden = false;
        dlEl.onclick = function () {
          try {
            var a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click();
            if (a.parentNode) a.parentNode.removeChild(a);
          } catch (e) { /* ignore */ }
        };
      }
      if (viewEl) {
        var mime = (label && label.mime) || meta.mime;
        if (String(mime).indexOf('image/') === 0) {
          var img = document.createElement('img');
          img.src = url; img.alt = safeDisplayName(meta.name);
          img.style.cssText = 'max-width:100%;border-radius:10px;border:1px solid var(--border)';
          viewEl.appendChild(img);
        } else {
          var emb = document.createElement('embed');
          emb.src = url; emb.type = 'application/pdf';
          emb.style.cssText = 'width:100%;height:60vh;border-radius:10px;border:1px solid var(--border)';
          viewEl.appendChild(emb);
        }
      }
    } catch (e) {
      if (msgEl) { msgEl.hidden = false; msgEl.textContent = 'Could not display the file on this device.'; }
    }
    openDialog('attach-dialog');
  }
  function showMissing(note) {
    if (msgEl) { msgEl.hidden = false; msgEl.textContent = note; }
    openDialog('attach-dialog');
  }
  attGet(meta.hash).then(function (rec) {
    if (rec && rec.blob) { showBlob(rec.blob, rec); return; }
    var cfg = null, pass = '';
    try {
      cfg = syncLoadConfig();
      pass = (cfg && cfg.passphrase) ? cfg.passphrase : '';
      if (!pass) {
        try {
          var pv = document.getElementById('sy-pass');
          if (pv && pv.value) pass = pv.value;
        } catch (e) { /* settings closed */ }
      }
    } catch (e) { cfg = null; }
    if (!cfg || !pass) { showMissing('File is not on this device — it was attached elsewhere. Open the original device, or enter the sync passphrase in Settings → Sync to fetch it.'); return; }
    if (msgEl) { msgEl.hidden = false; msgEl.textContent = 'Fetching encrypted copy…'; }
    openDialog('attach-dialog');
    syncPullAttachment(cfg, pass, meta).then(function (got) {
      if (msgEl) { msgEl.hidden = true; msgEl.textContent = ''; }
      showBlob(got.blob, got.meta);
    }, function () {
      showMissing('File is not on this device yet — sync has no copy either. Open the original device with sync on so it can upload, then retry here.');
    });
  });
}

// Resolve the reference Exec quote for a trade row: {price, ccy} or null.
// Precedence is deliberate: a fiat-tagged global override is explicit live
// intent and always convertible; a frozen per-trade quote carries its own
// known fiat and beats a legacy bare-number override (whose fiat is unknown
// — showing it raw in a foreign main would be a nominal lie); the legacy
// number still serves when nothing better exists; then async history.
// Cross-fiat values convert at the trade-date historical rate; when the rate
// is unavailable the value shows in its OWN fiat, never nominal in the
// display fiat. Never throws; P&L never reads this (display-only).
function resolveExecPrice(t, main, kind) {
  var m = String(main || '').toUpperCase();
  if (!t || typeof t !== 'object' || !m) return null;
  function converted(price, vs) {
    var p = Number(price);
    var from = String(vs || '').trim().toUpperCase();
    if (!isFinite(p) || p <= 0 || !/^[A-Z]{2,10}$/.test(from)) return null;
    if (from === m) return { price: p, ccy: m };
    var hr = null;
    try { hr = getCachedRate(t.date, from, m); } catch (e) { hr = null; }
    if (hr && isFinite(Number(hr.rate)) && Number(hr.rate) > 0) {
      return { price: p * Number(hr.rate), ccy: m };
    }
    return { price: p, ccy: from };
  }
  var oe = null;
  try { oe = priceOverrideEntry(t.symbol, PRICE_KIND_BY_ACCOUNT[t.accountId]); } catch (e) { oe = null; }
  if (oe !== null && oe.vs) return converted(oe.price, oe.vs);
  var fr = null;
  try { fr = frozenExecOf(t); } catch (e) { fr = null; }
  if (fr) return converted(fr.price, fr.vs);
  if (oe !== null) {
    var lp = Number(oe.price);
    if (isFinite(lp) && lp > 0) return { price: lp, ccy: m }; // legacy bare: old nominal behavior
    return null;
  }
  var hi = null;
  try { hi = getHistoricalExec(t.symbol, t.date, main, kind); } catch (e) { hi = null; }
  if (hi && isFinite(Number(hi.price)) && Number(hi.price) > 0) return { price: Number(hi.price), ccy: m };
  return null;
}

// Ledger inputs ride records that can carry a code: cash income/expense
// always (required at submit); transfers on every kind (a move posts -sent
// on the source and +received on the arrival under the same code, so groups
// net to the fee); every other asset type while the global switch is on
// (optional). Swaps move value through generated sell/buy legs — label the
// legs afterwards via record edit instead.
function tradeLedgerAllowed(isCashAcc, side) {
  if (side === 'swap') return false;
  if (side === 'transfer') {
    if (isCashAcc) return true;
    try { return assetLedgersOn(peekState()); } catch (e) { return true; }
  }
  if (isCashAcc) return side === 'income' || side === 'expense';
  try { return assetLedgersOn(peekState()); } catch (e) { return true; }
}

// Plain-language fee economics for transfer cards: what the fee was worth
// at move time vs what the books record (original cost). Numbers come from
// the record itself; nothing here touches P&L.
function openFeeExplainer(t, main, feeQty, rate) {
  var sym = String((t && t.symbol) || '').toUpperCase();
  var fq = Number(feeQty);
  var worth = (rate !== null && isFinite(fq) && fq > 0)
    ? fmtMoney(fq * rate.price, rate.ccy) : null;
  var rateTxt = (rate !== null)
    ? fmtMoney(rate.price, rate.ccy) + ' / ' + sym : null;
  var entry = 0;
  try {
    var st = loadState();
    var dtr = convertTrades(st.trades || [], main);
    var eng = computeAverage(dtr);
    var pos = eng.get(sym) || eng.get(String((t && t.symbol) || ''));
    if (pos && isFinite(Number(pos.avgEntry)) && Number(pos.avgEntry) > 0) entry = Number(pos.avgEntry);
  } catch (e) { entry = 0; }
  var lines = [];
  if (worth !== null && rateTxt !== null) {
    lines.push('Worth ' + worth + ' at the transfer-day price (' + rateTxt + ').');
  } else {
    lines.push('No rate known yet for this move — tap Fee in fiat rate to retry the lookup.');
  }
  if (worth !== null && entry > 0) {
    lines.push('Books record its ' + fmtMoney(fq * entry, main) + ' cost (your ' + fmtMoney(entry, main) + ' average entry) as the realized loss.');
    lines.push('The difference is the market move while you held — not an error.');
  } else if (worth !== null) {
    lines.push('Books record what those coins cost you when bought — not this market value.');
  }
  openNoteDialog(lines.join('\n'), 'Transfer fees');
}

function rateRow(label, text) {
  var rate = document.createElement('div');
  rate.className = 'stat-row rate-line';
  rate.setAttribute('data-label', label);
  var rl = document.createElement('span');
  rl.className = 'stat-label';
  rl.textContent = label;
  var rv = document.createElement('span');
  rv.className = 'stat-val muted';
  rv.textContent = text;
  // The ⓘ badge (and the "show full" affordance) exists only when a popup
  // is possible at all: a '—' placeholder can never overflow, so wiring it
  // would leave a badge that opens nothing. Real values stay runtime-gated
  // (badge shows only while the text is actually truncated).
  var hasContent = String(text === undefined || text === null ? '' : text).trim() !== '' &&
    String(text).trim() !== '—';
  function openRate() {
    // Popup only when the text actually overflows the row.
    if (!isVisuallyCut(rv)) return;
    openNoteDialog(text, label);
  }
  if (hasContent) {
    rv.setAttribute('role', 'button');
    rv.setAttribute('tabindex', '0');
    rv.setAttribute('aria-label', 'Show full rate');
    rv.addEventListener('click', openRate);
    rv.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openRate();
      }
    });
    infoDot(rl, openRate, rv);
  }
  rate.appendChild(rl);
  rate.appendChild(rv);
  return rate;
}

// ————— Phone-collapsed record cards —————
// Phones (≤720px) show every record as pills + actions + the two key numbers
// (the .is-primary rows); the stylesheet hides the rest until a tap drops
// them down. Expanded ids live here so a re-render — live prices landing, FX
// fills, paging, filtering — never slams an open card shut under the reader.
// Keyed by trade id; legacy id-less records simply opt out.
var openTradeCards = {};

// Flip one card between collapsed (phone default) and expanded. Runs at any
// width; the stylesheet only hides rows inside the phone breakpoint, so a
// desktop toggle stays invisible. Re-gates the ⓘ dots too: rows that were
// display:none just became measurable (and vice versa).
function setTradeCardOpen(box, open) {
  if (!box) return;
  var id = '';
  try { id = String(box.getAttribute('data-trade') || ''); } catch (e) { id = ''; }
  if (open) {
    try { box.classList.add('is-open'); } catch (e) { /* ignore */ }
    if (id) openTradeCards[id] = true;
  } else {
    try { box.classList.remove('is-open'); } catch (e) { /* ignore */ }
    if (id) delete openTradeCards[id];
  }
  var btn = null;
  try { btn = box.querySelector('.trade-more'); } catch (e) { btn = null; }
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Hide record details' : 'Show all record details');
    btn.title = open ? 'Hide details' : 'Show all details';
  }
  try { syncInfoDots(); } catch (e) { /* the ⓘ gate never breaks a tap */ }
}
