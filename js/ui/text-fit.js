'use strict';
// Fixed layout, fluid content: measures text and trims, fits or hides
// decorations so boxes never resize with their values.

// A trimmed box tells you it is trimmed only by measuring it: the text runs
// wider than the box it lives in. Shared by the "show full" tap handlers and
// by the ⓘ gate, so a badge and its popup always agree on the same truth.
var _textMeasureCanvas = null;
var _textMeasureContext = null;

// Measure an unclipped copy: some browsers clamp both Range bounds and
// scrollWidth to the ellipsis, even when the text itself continues.
function isVisuallyCut(el) {
  if (!el) return false;
  try {
    var rect = el.getBoundingClientRect();
    if (!(rect.width > 0)) return false;
    var left = rect.left, right = rect.right;
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var style = window.getComputedStyle(node);
      var overflow = style.overflowX;
      if (node === el || overflow === 'hidden' || overflow === 'clip' || overflow === 'scroll' || overflow === 'auto') {
        var box = node.getBoundingClientRect();
        var clipLeft = box.left + node.clientLeft;
        left = Math.max(left, clipLeft);
        right = Math.min(right, clipLeft + node.clientWidth);
      }
    }
    var visibleWidth = Math.max(0, right - left);
    var fullWidth = textRunWidth(el);
    if (fullWidth > 0) return fullWidth > visibleWidth + 2;
    return el.scrollWidth > el.clientWidth + 2;
  } catch (e) { return false; }
}

function isTrimmed(el) {
  return isVisuallyCut(el);
}

// Discoverability for tap-for-info rows: an ⓘ badge on the label that
// opens the same popup as the value. Pass the value element when the popup
// only exists on overflow — syncInfoDots then hides decorative dots whose
// value fits. Omit it when the tap always opens something (Transfer fees).
// A cut caption opens its own full text: the label element keeps the complete
// string in the DOM (the ellipsis never edits it), so a tap hands it to the
// note popup. Idempotent: one wiring per element, no double dialogs.
function wireLabelFull(labelEl) {
  if (!labelEl || labelEl.getAttribute('data-label-full-wired') === '1') return;
  labelEl.setAttribute('data-label-full-wired', '1');
  labelEl.setAttribute('role', 'button');
  labelEl.setAttribute('tabindex', '0');
  labelEl.setAttribute('aria-label', 'Show full label');
  try { labelEl.style.cursor = 'pointer'; } catch (e) { /* ignore */ }
  function openLab() {
    try { openNoteDialog(labelEl.textContent, 'Label'); } catch (e) { /* ignore */ }
  }
  labelEl.addEventListener('click', openLab);
  labelEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openLab();
    }
  });
}

function infoDot(labelEl, openFn, valueEl) {
  if (!labelEl || typeof openFn !== 'function') return;
  var dot = document.createElement('span');
  // Overflow-gated dots (a measured value was passed) start hidden and only
  // ever appear via the sync pass — any rebuild path that skips the sync
  // then defaults to no dot instead of flashing one. Always-on dots (no
  // value: the tap always opens something) keep the plain class.
  dot.className = valueEl ? 'info-dot info-dot-gated' : 'info-dot';
  dot.textContent = 'ⓘ';
  dot.setAttribute('aria-hidden', 'true');
  labelEl.appendChild(dot);
  try { labelEl.style.cursor = 'pointer'; } catch (e) { /* ignore */ }
  labelEl.addEventListener('click', function () { try { openFn(); } catch (e) { /* ignore */ } });
  if (valueEl) {
    try { valueEl.setAttribute('data-info-cond', '1'); } catch (e) { /* ignore */ }
  }
}

// Cut values hand over their full text on tap. Every trimmed cell keeps the
// complete string in the DOM — the ellipsis is purely visual — so a tap on an
// actually-overflowing value opens the standard note popup (same 2px floor
// as syncInfoDots) with exactly the string that was cut, never a re-rounded
// number. Fitting values get no role, no keyboard stop and no hand cursor.
// `labelEl` attaches the overflow-gated ⓘ badge; label-less values (home
// account figures, the hero total) are tappable directly. The flag makes the
// wiring idempotent for static elements (hero) that re-render in place.
// ————— Facts-strip room: the amount yields first, labels hold the line —————
// The record facts strip keeps everything on one line: label above value,
// all cells sharing the strip's single row. A 17-digit quantity is far
// wider than its fiat neighbours, so when the strip (or any caption) runs
// out of space the QUANTITY rows — and only them — give up their right-most
// decimal digits one at a time until everything fits again. The overflow
// popup still carries the complete exact string (cached on the element
// before the first cut, and data-full is preferred by the popup), so not a
// digit of truth is lost — the strip simply stops repeating what the popup
// already owns. National-fiat tails (EUR…) are never touched: cash rows
// keep every digit, and captions/notes/hashes have their own CSS cut.
var FIT_FIAT_TICKERS = ['EUR', 'USD', 'GBP', 'CHF', 'RON', 'JPY', 'CAD', 'AUD'];

// One ladder step (pure): '1.4523584521545257 AAVE' -> '1.452358452154525
// AAVE'. A previously painted trim marker ('…' between head and tail) is
// accepted on input and dropped on output — the caller re-paints it. Only
// the raw text is ever returned, so the pure contract stays exact.
// Integers have nothing fractional to yield; one decimal place is
// the floor; anything that is not a plain decimal head ('—', notes, hashes,
// exponent forms) stays untouched. National-fiat symbol tails never yield.
function cutOneQtyDigit(txt) {
  var m = /^(-?\d+(?:\.\d+)?)(\u2026)?([\s\u00a0].*)?$/.exec(String(txt === null || txt === undefined ? '' : txt));
  if (!m) return null;
  var sym = (m[3] || '').trim().toUpperCase();
  if (sym !== '' && FIT_FIAT_TICKERS.indexOf(sym) !== -1) return null;
  var num = m[1];
  var dot = num.indexOf('.');
  if (dot < 1) return null;
  if (num.length <= dot + 2) return null;
  return num.slice(0, num.length - 1) + (m[3] || '');
}

// The trim must be VISIBLE: digits given up by the fit pass paint the same
// '…' a CSS ellipsis would, placed where the number stopped. A trimmed
// amount can never pose as a complete number beside its ticker, so the
// popup behind the '…' is the only place the full string lives.
function fitTrimMark(txt) {
  var m = /^(-?\d+(?:\.\d+)?)([\s\u00a0].*)?$/.exec(String(txt === null || txt === undefined ? '' : txt));
  if (!m) return String(txt) + '…';
  return m[1] + '…' + (m[2] || '');
}

function qtyElCutOne(vEl) {
  var next = cutOneQtyDigit(String(vEl.textContent || ''));
  if (next === null) return false;
  vEl.textContent = fitTrimMark(next);
  vEl.setAttribute('data-fit-cut', '1');
  return true;
}

// Trim profiles that may yield room: the real quantity columns of the
// facts strip. Fiat rows ('Paid', the sell 'Received', 'Converted'),
// transfer recipient lists (a different 'Received'), Rate, Note and Tx are
// all outside this set and never appear here.
var TRADE_FACTS_QTY_LABELS = { 'Amount': 1, 'Amount sold': 1, 'Moved': 1, 'Lost': 1 };

// Natural width of an element's visible inline text. Range geometry is kept
// as a fallback and a cross-check, while canvas measurement recovers text
// width when overflow clipping makes the Range report only the visible part.
function textRunWidth(el) {
  if (!el) return 0;
  var rangeWidth = 0, canvasWidth = 0;
  try {
    var r = document.createRange();
    r.selectNodeContents(el);
    rangeWidth = r.getBoundingClientRect().width;
    if (r.detach) r.detach();
  } catch (e) { /* canvas measurement remains available */ }
  try {
    if (!_textMeasureCanvas) {
      _textMeasureCanvas = document.createElement('canvas');
      _textMeasureContext = _textMeasureCanvas.getContext('2d');
    }
    if (_textMeasureContext) {
      var walker = document.createTreeWalker(el, 4, null, false);
      var textNode;
      while ((textNode = walker.nextNode())) {
        var parent = textNode.parentElement;
        if (!parent || !String(textNode.nodeValue || '').trim() && !/\s/.test(textNode.nodeValue || '')) continue;
        var cs = window.getComputedStyle(parent);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        var value = String(textNode.nodeValue || '');
        if (cs.textTransform === 'uppercase') value = value.toUpperCase();
        else if (cs.textTransform === 'lowercase') value = value.toLowerCase();
        _textMeasureContext.font = cs.font;
        var width = _textMeasureContext.measureText(value).width;
        var spacing = parseFloat(cs.letterSpacing);
        if (isFinite(spacing) && value.length > 1) width += spacing * (value.length - 1);
        canvasWidth += width;
      }
    }
  } catch (e) { /* Range geometry remains available */ }
  return Math.max(isFinite(rangeWidth) ? rangeWidth : 0, isFinite(canvasWidth) ? canvasWidth : 0);
}

function fitTradeFactsRows(strip) {
  if (!strip) return;
  var rows = strip.querySelectorAll('.stat-row');
  var qtys = [];
  var i, row, lab, v, txt;
  // The captions are the strip's contract: every label shows in full and
  // the squeeze is paid by the data cells (Note, Rate, Amount) instead of
  // clipping words like 'Exec. price' or 'Fee'. Pin each cell's min-width
  // to its caption's natural width — plus the ⓘ slot while the badge is
  // hidden, so it can never re-cut the caption when it surfaces.
  for (i = 0; i < rows.length; i++) {
    row = rows[i];
    lab = row.querySelector('.stat-label');
    if (!lab) continue;
    var labW = textRunWidth(lab);
    if (!(labW > 0)) continue;
    var dotEl = lab.querySelector('.info-dot');
    var dotPad = (dotEl && !dotEl.offsetWidth) ? 14 : 0;
    var want = Math.ceil(labW) + dotPad + 1;
    if (parseFloat(row.style.minWidth || '') !== want) row.style.minWidth = want + 'px';
  }
  // Tx is the copyable id: its shortened first…last form must always read
  // whole — a CSS tail cut would fake hidden characters after the last
  // block. Pin the cell to the short hash plus the copy glyph, so the
  // strip takes the room from Note and the amounts instead.
  var txRowsFit = strip.querySelectorAll('.stat-row.tx-row');
  for (var txi = 0; txi < txRowsFit.length; txi++) {
    var txRow = txRowsFit[txi];
    var txTxt = txRow.querySelector('.stat-val > :first-child');
    var txW = textRunWidth(txTxt);
    if (txW > 0) {
      var txCopy = txRow.querySelector('.tx-copy');
      var txNeed = Math.ceil(txW) + ((txCopy && txCopy.offsetWidth) ? txCopy.offsetWidth + 6 : 0) + 1;
      var txMin = parseFloat(txRow.style.minWidth || '') || 0;
      if (txNeed > txMin) txRow.style.minWidth = txNeed + 'px';
    }
  }
  for (i = 0; i < rows.length; i++) {
    row = rows[i];
    lab = row.getAttribute ? (row.getAttribute('data-label') || '') : '';
    if (!TRADE_FACTS_QTY_LABELS[lab]) continue;
    v = row.querySelector('.stat-val');
    if (!v) continue;
    txt = String(v.textContent || '');
    if (txt === '' || txt === '—') continue;
    // Cache the exact DOM string once: the popup reads it after any cut.
    if (!v.getAttribute('data-full')) v.setAttribute('data-full', txt);
    qtys.push(v);
  }
  if (!qtys.length) return;
  // Every pass restarts from the exact truth, so a resize can re-fit from
  // full precision instead of compounding earlier cuts. Restoring also
  // clears the cut flag: only a cut applied by the ladder below keeps it.
  for (i = 0; i < qtys.length; i++) {
    var fv = qtys[i].getAttribute('data-full');
    if (fv !== null) {
      qtys[i].textContent = fv;
      qtys[i].removeAttribute('data-fit-cut');
    }
  }
  // Reset any previous inline note cap; every fact cell shares its space
  // with the others and truncates its own value independently.
  var noteRow = strip.querySelector('.stat-row[data-label="Note"]');
  if (noteRow) noteRow.style.maxWidth = '';
  function fits() {
    try {
      if (strip.scrollWidth > strip.clientWidth + 2) return false;
      var ls = strip.querySelectorAll('.stat-label');
      for (var k = 0; k < ls.length; k++) {
        if (isVisuallyCut(ls[k])) return false;
      }
      // Every quantity value must render COMPLETE inside its own cell: a
      // long string with its tail cut shows data that was trimmed anyway —
      // the fit prefers a shorter value with the precision marker over a
      // longer one whose ticker drowns at the cell edge.
      for (var q = 0; q < qtys.length; q++) {
        if (isVisuallyCut(qtys[q])) return false;
      }
      return true;
    } catch (e) { return true; }
  }
  if (fits()) return;
  var guard = 64; // digits + headroom — far past the one-decimal floor
  while (guard-- > 0 && !fits()) {
    // The longest numeric head yields first: with one quantity column per
    // card this is simply the amount of the record.
    var pick = null, pickLen = 0;
    for (i = 0; i < qtys.length; i++) {
      var len = String(qtys[i].textContent || '').length;
      if (len > pickLen) { pickLen = len; pick = qtys[i]; }
    }
    if (!pick || !qtyElCutOne(pick)) return;
  }
}

function syncTradeFactsFit() {
  var strips = document.querySelectorAll('.trade-facts');
  for (var i = 0; i < strips.length; i++) fitTradeFactsRows(strips[i]);
}

function wireTruncTap(valEl, title, labelEl) {
  if (!valEl || valEl.getAttribute('data-trunc-wired') === '1') return;
  valEl.setAttribute('data-trunc-wired', '1');
  valEl.setAttribute('data-info-cond', '1');
  valEl.setAttribute('role', 'button');
  valEl.setAttribute('tabindex', '0');
  valEl.setAttribute('aria-label', 'Show full ' + String(title || 'value').toLowerCase());
  // The invariant is: every trimmed thing opens its full value on tap. The
  // exact DOM string is snapshotted right here at wiring time — but never
  // over an existing one, because in-place re-renders (the hero total) keep
  // this element and refresh their own snapshot where the text changes.
  var full0 = String(valEl.textContent || '');
  if (full0 !== '' && full0 !== '—' && !valEl.getAttribute('data-full')) valEl.setAttribute('data-full', full0);
  function open() {
    try {
      var snap = String(valEl.getAttribute('data-full') || '');
      var cur = String(valEl.textContent || '');
      var fitCut = valEl.getAttribute('data-fit-cut') === '1' && snap !== '' && snap !== cur;
      if (!fitCut && !isVisuallyCut(valEl)) return;
      openNoteDialog(fitCut ? snap : (snap || cur), title);
    } catch (e) { /* a broken tap must never break the panel */ }
  }
  valEl.addEventListener('click', open);
  valEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  if (labelEl) infoDot(labelEl, open, valEl);
}

// Overflow-gated dots mean something only when the value is actually
// truncated: hide the decorative ones after layout settles. The pointer
// follows the same truth — text cursor for fitting text, hand only where
// a tap does something. Runs on every paint and on resize (truncation
// follows width). The 2px floor swallows subpixel rounding so near-fitting
// labels never flap their dot across paints, refreshes or resizes.
function syncInfoDots() {
  try { syncTradeFactsFit(); } catch (e) { /* the strip fit never breaks the sync */ }
  try {
    var vals = document.querySelectorAll('.stat-val[data-info-cond], .detail-meta-val[data-info-cond], .ledger-label-text[data-info-cond], .card-value[data-info-cond]');
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      var box = null;
      try { box = v.closest ? v.closest('.stat-row, .detail-meta, .card') : null; } catch (e) { box = null; }
      if (!box) continue;
      var dot = box.querySelector('.info-dot');
      var lab = null;
      try { lab = box.querySelector('.stat-label, .detail-meta-label, .card-label'); } catch (e) { lab = null; }
      var overflowing = false;
      try { overflowing = isVisuallyCut(v); } catch (e) { overflowing = false; }
      // A strategy-trim (the strip fit ladder cut digits to make the row
      // fit) counts too: the value text differing from its snapshot means
      // digits gave their room to the neighbours and the popup must be
      // reachable — the same affordance as a CSS-cut. A mismatch on an
      // element that measures uncut is the reverse case: an in-place
      // re-render painted a fresh string, so the snapshot follows the live
      // text and no stale value can ever be served from a tap.
      try {
        var snapV = String(v.getAttribute('data-full') || '');
        var curV = String(v.textContent || '');
        if (snapV !== '' && snapV !== curV) {
          if (v.getAttribute('data-fit-cut') === '1') overflowing = true;
          else if (!overflowing) v.setAttribute('data-full', curV);
        }
      } catch (e) { /* snapshot reads never break the pass */ }
      if (dot) dot.style.display = overflowing ? 'inline' : 'none';
      try { v.style.cursor = overflowing ? 'pointer' : ''; } catch (e) { /* ignore */ }
      if (lab) {
        var labOverflow = false;
        try { labOverflow = isVisuallyCut(lab); } catch (e) { labOverflow = false; }
        var shown = overflowing || labOverflow;
        if (dot) dot.style.display = shown ? 'inline' : 'none';
        try { lab.style.cursor = shown ? 'pointer' : ''; } catch (e) { /* ignore */ }
        // A cut caption is its own trim: labels carry their full text (the
        // ellipsis is pure ink), so when the row carries no ⓘ dot at all
        // (no wired value popup — '—' placeholders skip wiring), the label
        // itself opens with its complete text. The click-to-full rule has
        // no exceptions.
        if (labOverflow && !dot) wireLabelFull(lab);
      }
    }
    // Trade what-pills (.trade-what) trim their own text box; the ⓘ dot is
    // a child of the pill, right after the text.
    var whats = document.querySelectorAll('.trade-what[data-info-cond]');
    for (var i = 0; i < whats.length; i++) {
      var w = whats[i];
      var wt = w.querySelector('.trade-what-text');
      var dot = w.querySelector('.info-dot');
      var trimmed = isTrimmed(wt || w);
      if (dot) dot.style.display = trimmed ? 'inline' : 'none';
      try { w.style.cursor = trimmed ? 'pointer' : ''; } catch (e) { /* ignore */ }
    }
    // Label-less wired values (home account figures, the hero total) carry
    // no ⓘ badge — the number itself is the tap target. Only the hand
    // cursor follows the truncation truth.
    var bare = document.querySelectorAll('.acct-value[data-info-cond], .acct-pl[data-info-cond], #hero-value[data-info-cond], #hero-value-num[data-info-cond]');
    for (var b = 0; b < bare.length; b++) {
      var bv = bare[b];
      try { bv.style.cursor = isVisuallyCut(bv) ? 'pointer' : ''; } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

// The now-worth / pair pills cap short of the pinned ▾ ✎ 🗑 corner only while
// they share the head's FIRST line with the buttons; once such a pill wraps
// below, the corner is free and the pill must run the full width. Pure CSS
// cannot see a flex wrap, so a measurement pass tags the dropped pills — the
// same render + resize rhythm as syncInfoDots. The 2px floor swallows the
// subpixel rounding of near-fit lines.
//
// The per-pill `100% - 7rem` cap reserves the corner from the head's edge,
// but a second or third pill on the first line already starts past that
// reservation — on some devices such pills used their whole cap yet still
// slid UNDER the trio (record-length dependent, hence "some records"). The
// same pass therefore reads the cluster's real left edge: any line-1 pill
// whose uncut text would cross it takes a wrap-forcing right margin and
// reappears on its own row, lifted and parked below the band — at pill size,
// parked, never painted over the buttons. Every pass resets its own inline
// corrections first and re-decides from the plain CSS layout, so repeated
// runs are idempotent and no lift/cap seesaw can survive a paint.
function syncTradeHeadRows() {
  try {
    var heads = document.querySelectorAll('#account-detail .trade-head');
    for (var i = 0; i < heads.length; i++) {
      var head = heads[i];
      var when = head.querySelector('.trade-when');
      if (!when) { // no date pill: nothing to measure against
        continue;
      }
      var pills = head.querySelectorAll('.trade-now, .trade-pair, .trade-what, .trade-id');
      if (!pills.length) {
        continue;
      }
      // Corner geometry in the head's own offset space — pills and cluster
      // share the offsetParent, so lefts and widths compare like for like.
      // A device with no real cluster box (desktop's display:contents, the
      // shim) keeps the plain first-line pass. offsetHeight > 0 filters the
      // boxless cluster out.
      var cornerLeft = null;
      var band = null;
      try {
        var cluster = head.querySelector('.trade-actions');
        if (cluster && typeof cluster.offsetLeft === 'number' && typeof cluster.offsetTop === 'number' &&
            typeof cluster.offsetHeight === 'number' && cluster.offsetHeight > 0) {
          band = cluster.offsetTop + cluster.offsetHeight;
          if (cluster.offsetLeft > 0) cornerLeft = cluster.offsetLeft;
        }
      } catch (e) { band = null; cornerLeft = null; }
      // The "safe space" is one normal row-gap: reuse the head's own gap so
      // the clearance reads like the rest of the card, never like padding.
      var rowGap = 0;
      try {
        var rg = parseFloat(window.getComputedStyle(head).rowGap);
        if (isFinite(rg) && rg > 0) rowGap = rg;
      } catch (e) { /* shimmed layouts keep a plain pass */ }
      // Margins left by the previous pass would skew this measurement: drop
      // them first so every read below is the pill's natural CSS position.
      for (var k = 0; k < pills.length; k++) {
        try { pills[k].style.marginTop = ''; } catch (e) { /* ignore */ }
        try { pills[k].style.marginRight = ''; } catch (e) { /* ignore */ }
      }
      var firstTop = when.offsetTop;
      for (var j = 0; j < pills.length; j++) {
        var pill = pills[j];
        var top = pill.offsetTop;
        // A wrapped row starts at or below the trio's band where the band is
        // real; the old first-line + 2px floor stays as the fallback.
        var low = (band !== null) ? (top >= band - 2) : (top > firstTop + 2);
        if (low) pill.classList.add('head-own-row');
        else pill.classList.remove('head-own-row');
        if (!low && cornerLeft !== null) {
          // Line 1 shares the row with the pinned corner: a pill whose uncut
          // text would cross the cluster's left edge is wrapped to its own
          // row instead — with a right margin bigger than whatever the line
          // had left, the flex partition cannot keep it on line 1. scrollWidth
          // reads the uncut text even under the cap, so the decision is
          // content-based and stable across passes.
          try {
            var content = pill.scrollWidth;
            if (isFinite(content) && (pill.offsetLeft + content) > cornerLeft) {
              var force = null;
              try {
                if (typeof head.clientWidth === 'number' && head.clientWidth > 0) {
                  force = Math.round(head.clientWidth - cornerLeft + 1);
                }
              } catch (e2) { force = null; }
              if (force !== null && force > 0) {
                pill.style.marginRight = force + 'px';
                // The margin takes effect on the next layout: read the pill's
                // new row (the read flushes it), then lift the cap for that
                // row and park it band + one row-gap below the buttons.
                var top2 = pill.offsetTop;
                if (top2 >= band - 2) {
                  pill.classList.add('head-own-row');
                  var need = (band + rowGap) - top2;
                  if (need > 1) pill.style.marginTop = Math.round(need) + 'px';
                }
              }
            }
          } catch (e3) { /* the corner net stays off this pill */ }
        } else if (low && band !== null) {
          // Naturally wrapped rows park the same one row-gap below the band,
          // without growing any pill.
          var needNat = (band + rowGap) - top;
          if (needNat > 1) pill.style.marginTop = Math.round(needNat) + 'px';
        }
      }
    }
  } catch (e) { /* a failed pass keeps the last tags */ }
}
